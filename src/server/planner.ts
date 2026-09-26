/**
 * Planner agent (supervisor = this code). Drafts every *empty* day of a trip:
 *   1. The destination is resolved (destinations.ts): a place → one city; a
 *      region or country → Wikivoyage's recommended cities, of which the LLM
 *      may pick an order for this traveller, and lib/route.ts decides how many
 *      fit, the route order and which days each city gets. Continents are refused.
 *   2. Must-see places the traveller typed are looked up; a must-see outside
 *      every chosen city pulls its own stop into the route.
 *   3. Real places around each city come from open data (Overpass → Nominatim → Photon → Wikidata).
 *   4. Optional LLM curator re-orders a short, pre-scored list per city — it
 *      can only return indices from that list.
 *   5. The deterministic planner (lib/musafir/planner.ts) clusters, orders and
 *      times each day; transfer days start after the road leg (OSRM).
 *   6. Days inside the forecast horizon are pre-healed for rain with heal().
 * Everything goes through applyPatches like any other change. Days the
 * traveller already filled are never touched.
 */
import { z } from "zod";
import { haversineMeters } from "@/lib/musafir/geo.ts";
import { englishTitle } from "@/lib/musafir/names.ts";
import { newId } from "@/lib/musafir/ids.ts";
import { planDays, planShape, scoreCandidate, type PlaceCandidate, type PlannedDay } from "@/lib/musafir/planner.ts";
import { applyPatches, heal, policyFromVibe } from "@/lib/musafir/reducer.ts";
import { planRoute, type CityOption } from "@/lib/musafir/route.ts";
import type { DaySchedule, ItineraryNode, TripPatch, VibeConfig } from "@/lib/musafir/schemas.ts";
import { fromMinutes, toMinutes } from "@/lib/musafir/time.ts";
import { resolveDestination } from "./destinations.ts";
import { publish } from "./events.ts";
import { llmJson } from "./llm.ts";
import { nearbyCandidates, openKnowledgeSearch, searchPlaces, type CandidatePurpose } from "./osm.ts";
import { cachedLeg, routedLookup, warmLegs } from "./routing.ts";
import { read, write, type TripRecord } from "./store.ts";
import { rainWindows } from "./weather.ts";

const SEARCH_RADIUS_M = 3000;
/** When a place is small or rural, widen the search until there's enough to fill days. */
const WIDER_RADII_M = [10_000, 25_000];
const ENOUGH_CANDIDATES = 12;
const PURPOSES: CandidatePurpose[] = ["CULTURE", "NATURE", "LEISURE", "DINING"];
const CURATOR_LIST_SIZE = 24;
/** A must-see within this distance of a chosen city is visited from that city. */
const MUST_SEE_CITY_KM = 60;
/** Road legs longer than this are left to trains/flights: the transfer takes the morning instead. */
const MAX_ROAD_TRANSFER_MIN = 7 * 60;
/** When the road time is unknown or too long, sightseeing resumes after this (labelled placeholder). */
const LONG_TRANSFER_RESUME = 14 * 60;
const TRANSFER_SETTLE_MIN = 30;
/** A RUNNING planner older than this is treated as crashed and may be restarted. */
export const PLANNER_STALE_MS = 4 * 60_000;

const CuratorSchema = z.object({ order: z.array(z.number().int().min(0)).max(CURATOR_LIST_SIZE) });
const CityChoiceSchema = z.object({ order: z.array(z.number().int().min(0)).max(12) });

interface Segment {
  city: string;
  center: { lat: number; lng: number };
  dayIndexes: number[];
  mustSee: PlaceCandidate[];
}

async function setPlanner(tripId: string, planner: NonNullable<TripRecord["planner"]>) {
  await write((db) => {
    const rec = db.trips.find((t) => t.trip.id === tripId);
    if (rec) rec.planner = planner;
  });
  publish({ type: "activity", tripId, message: planner.note });
}

const tasteOf = (vibe: VibeConfig) => ({
  pace01: vibe.pacing,
  budget01: vibe.budget,
  localOverIconic01: vibe.culturalDepth,
  nightOwl01: vibe.circadian,
  interests: vibe.interests ?? [],
  avoid: vibe.avoid ?? [],
  party: vibe.party,
  brief: vibe.brief,
});

const dayRange = (days: number[]) => (days.length === 1 ? `day ${days[0]}` : `days ${days[0]}–${days[days.length - 1]}`);

/** The LLM may order the fetched cities for this traveller; code still decides how many fit and the route. */
async function chooseCities(destination: string, cities: CityOption[], vibe: VibeConfig, days: number) {
  const r = await llmJson({
    tier: "fast",
    timeoutMs: 6000,
    schema: CityChoiceSchema,
    system:
      'You help plan a multi-city trip. Order the listed cities by how well they suit this traveller, best first, and leave out ones that don\'t fit. Only use indices from the list. Reply as JSON: {"order": [indices]}',
    user: JSON.stringify({ destination, days, traveller: tasteOf(vibe), cities: cities.map((c, i) => ({ i, name: c.name, about: c.blurb })) }),
  });
  if (!r.ok) return { ids: undefined, via: `popularity (AI unavailable: ${r.reason})` };
  const ids = [...new Set(r.value.order)].filter((i) => i < cities.length).map((i) => cities[i].id);
  return { ids: ids.length ? ids : undefined, via: r.via };
}

/** Looks up each must-see by name (near the destination when known). Unfound ones are reported, never invented. */
async function findMustSees(names: readonly string[], near?: { lat: number; lng: number }) {
  const found: PlaceCandidate[] = [];
  const missing: string[] = [];
  for (const name of names) {
    // Landmarks: Wikipedia's relevance order first (English titles), then the map search.
    // First hit that isn't a station ("Fushimi Inari" → the shrine, not Fushimi-Inari Station).
    const notStation = (h: { category: string; name: string }) => h.category !== "TRANSIT" && !/\bstation\b/i.test(h.name);
    const hit =
      (await openKnowledgeSearch(name).catch(() => [])).find(notStation) ?? (await searchPlaces(name, near).catch(() => [])).find(notStation);
    if (!hit) {
      missing.push(name);
      continue;
    }
    found.push({
      sourceId: `mustsee:${hit.lat.toFixed(5)},${hit.lng.toFixed(5)}`,
      name: hit.name,
      nameNative: hit.nativeName,
      lat: hit.lat,
      lng: hit.lng,
      category: hit.category === "ACCOMMODATION" ? "CULTURE" : hit.category,
      isOutdoor: hit.isOutdoor,
      kind: "musafir=must_see",
      source: "traveller must-see",
    });
  }
  return { found, missing };
}

async function gather(center: { lat: number; lng: number }, failures: string[], radius = SEARCH_RADIUS_M): Promise<PlaceCandidate[]> {
  const out: PlaceCandidate[] = [];
  for (const purpose of PURPOSES) {
    try {
      for (const c of await nearbyCandidates(center, purpose, radius)) {
        const t = englishTitle(c);
        out.push({
          sourceId: c.osmId,
          name: t.title,
          nameNative: t.native,
          generic: t.generic,
          notability: c.notability,
          lat: c.lat,
          lng: c.lng,
          category: c.category,
          isOutdoor: c.isOutdoor,
          kind: c.kind,
          openingHours: c.openingHours,
          source: c.source,
          diet: c.diet,
        });
      }
    } catch (e) {
      failures.push(`${purpose.toLowerCase()}: ${(e as Error).message}`);
    }
  }
  return out;
}

function transitNode(from: Segment, to: Segment, start: number, minutes: number, distanceKm: number, routed: boolean): ItineraryNode {
  return {
    id: newId(),
    type: "SOFT",
    title: routed ? `Travel ${from.city} → ${to.city} by road` : `Travel ${from.city} → ${to.city}`,
    category: "TRANSIT",
    location: { lat: to.center.lat, lng: to.center.lng, city: to.city },
    timeSlot: { start: fromMinutes(start), durationMinutes: minutes, bufferMinutes: 0 },
    isOutdoor: false,
    costEstimate: { amount: 0, currency: "USD" },
    metadata: {
      plannedBy: "planner",
      priority: 1,
      source: routed ? "osrm" : "placeholder",
      durationSource: routed ? "OSRM road time" : "unknown — no road route or longer than a day's drive; check trains/flights",
      distanceKm: Math.round(distanceKm),
      fromCity: from.city,
      toCity: to.city,
      costSource: "unknown (no price in open data)",
    },
  };
}

export async function runPlanner(tripId: string): Promise<void> {
  const rec = await read((db) => structuredClone(db.trips.find((t) => t.trip.id === tripId)));
  if (!rec) return;
  const at = () => new Date().toISOString();
  const vibe = rec.trip.vibeConfig;
  const shape = planShape(vibe);
  try {
    await setPlanner(tripId, { status: "RUNNING", note: `Working out where "${rec.trip.destination}" is…`, at: at() });
    const emptyDays = rec.trip.schedule.filter((d) => d.nodes.length === 0).map((d) => ({ dayIndex: d.dayIndex, date: d.date }));
    const resolved = await resolveDestination(rec.trip.destination).catch(() => null);
    if (resolved?.scale === "continent") {
      await setPlanner(tripId, { status: "FAILED", note: `${resolved.name} is a whole continent — pick a country, region or city to plan around.`, at: at() });
      return;
    }

    // 1–2. Segments (city + days) and must-sees.
    const notes: string[] = [];
    let segments: Segment[];
    let cityChoice = "";
    const mustSeeNames = vibe.mustSee ?? [];
    if (resolved && (resolved.scale === "region" || resolved.scale === "country") && resolved.cities.length > 0) {
      await setPlanner(tripId, { status: "RUNNING", note: `${resolved.name} is a ${resolved.scale}: choosing cities from ${resolved.cities.length} that travel guides recommend…`, at: at() });
      const near = resolved.lat !== undefined && resolved.lng !== undefined ? { lat: resolved.lat, lng: resolved.lng } : undefined;
      const must = await findMustSees(mustSeeNames, near);
      if (must.missing.length) notes.push(`couldn't find ${must.missing.join(", ")} on the map`);
      // A must-see far from every recommended city becomes its own stop on the route.
      const top = Math.max(...resolved.cities.map((c) => c.popularity), 0);
      const extra: CityOption[] = must.found
        .filter((m) => !resolved.cities.some((c) => haversineMeters(c, m) <= MUST_SEE_CITY_KM * 1000))
        .map((m) => ({ id: `must:${m.sourceId}`, name: m.name, lat: m.lat, lng: m.lng, popularity: top + 1 }));
      const cities = [...resolved.cities, ...extra];
      const choice = await chooseCities(resolved.name, cities, vibe, emptyDays.length);
      cityChoice = choice.via;
      const mustIds = cities.filter((c) => must.found.some((m) => haversineMeters(c, m) <= MUST_SEE_CITY_KM * 1000)).map((c) => c.id);
      const route = planRoute(
        cities,
        emptyDays.map((d) => d.dayIndex),
        { pacing: vibe.pacing, preferredIds: [...new Set([...mustIds, ...(choice.ids ?? [])])] },
      );
      // Each must-see belongs to its nearest city on the route (within reach).
      const home = (m: PlaceCandidate) => {
        const best = [...route].sort((a, b) => haversineMeters(a.city, m) - haversineMeters(b.city, m))[0];
        return best && haversineMeters(best.city, m) <= MUST_SEE_CITY_KM * 1000 ? best.city.id : undefined;
      };
      segments = route.map((s) => ({
        city: s.city.name,
        center: { lat: s.city.lat, lng: s.city.lng },
        dayIndexes: s.dayIndexes,
        mustSee: must.found.filter((m) => home(m) === s.city.id),
      }));
      const skipped = must.found.filter((m) => !segments.some((s) => s.mustSee.includes(m)));
      if (skipped.length) notes.push(`${skipped.map((m) => m.name).join(", ")} didn't fit this many days`);
    } else {
      const place =
        resolved?.lat !== undefined && resolved.lng !== undefined
          ? { lat: resolved.lat, lng: resolved.lng, name: resolved.name, city: resolved.name }
          : (await searchPlaces(rec.trip.destination))[0];
      if (!place) {
        await setPlanner(tripId, { status: "FAILED", note: `Couldn't find "${rec.trip.destination}" on the map. Try a city, region or country name.`, at: at() });
        return;
      }
      const center = { lat: place.lat, lng: place.lng };
      const must = await findMustSees(mustSeeNames, center);
      if (must.missing.length) notes.push(`couldn't find ${must.missing.join(", ")} on the map`);
      const far = must.found.filter((m) => haversineMeters(center, m) > MUST_SEE_CITY_KM * 1000);
      if (far.length) notes.push(`${far.map((m) => m.name).join(", ")} ${far.length > 1 ? "are" : "is"} over ${MUST_SEE_CITY_KM} km away — plan it as its own trip`);
      segments = [{ city: place.city || place.name, center, dayIndexes: emptyDays.map((d) => d.dayIndex), mustSee: must.found.filter((m) => !far.includes(m)) }];
    }
    const routeNote = segments.length > 1 ? `Route: ${segments.map((s) => `${s.city} (${dayRange(s.dayIndexes)})`).join(" → ")}` : "";
    if (routeNote) await setPlanner(tripId, { status: "RUNNING", note: `${routeNote}. Gathering places…`, at: at() });

    // 3–5. Per city: gather, curate, time.
    const planned: (PlannedDay & { center: { lat: number; lng: number } })[] = [];
    const failures: string[] = [];
    let totalCandidates = 0;
    let curatedVia = "";
    let routing: "osrm" | "cached" | "unavailable" = "cached";
    for (const [k, seg] of segments.entries()) {
      if (seg.dayIndexes.length === 0) continue;
      await setPlanner(tripId, { status: "RUNNING", note: `Gathering places in ${seg.city}${segments.length > 1 ? ` (${k + 1}/${segments.length})` : ""}…`, at: at() });
      const candidates = [...seg.mustSee, ...(await gather(seg.center, failures))];
      // Villages, islands, hill stations: widen until there's enough real material for the days.
      let radius = SEARCH_RADIUS_M;
      for (const r of WIDER_RADII_M) {
        if (candidates.length >= ENOUGH_CANDIDATES * Math.max(1, seg.dayIndexes.length / 2)) break;
        await setPlanner(tripId, { status: "RUNNING", note: `Few places right in ${seg.city} — looking within ${r / 1000} km…`, at: at() });
        const seen = new Set(candidates.map((c) => c.sourceId));
        candidates.push(...(await gather(seg.center, failures, r)).filter((c) => !seen.has(c.sourceId)));
        radius = r;
      }
      // The traveller's own keywords ("jazz bars", "anime") are searched for directly, so places outside the usual categories exist at all.
      for (const k of (vibe.keywords ?? []).slice(0, 4)) {
        const hits = await searchPlaces(`${k} ${seg.city}`, seg.center).catch(() => []);
        for (const h of hits) {
          if (h.category === "TRANSIT" || h.category === "ACCOMMODATION" || haversineMeters(seg.center, h) > SEARCH_RADIUS_M * 2) continue;
          const t = englishTitle({ name: h.nativeName ?? h.name, nameEn: h.name, kind: `search=${k}`, category: h.category });
          candidates.push({ sourceId: `kw:${h.lat.toFixed(5)},${h.lng.toFixed(5)}`, name: t.title, nameNative: t.native, generic: t.generic, lat: h.lat, lng: h.lng, category: h.category, isOutdoor: h.isOutdoor, kind: `search=${k}`, source: "keyword search" });
        }
      }
      // A must-see outside the city's search circle gets its own neighbourhood, so its day isn't spent shuttling.
      for (const m of seg.mustSee.filter((x) => haversineMeters(seg.center, x) > SEARCH_RADIUS_M)) candidates.push(...(await gather(m, failures)));
      totalCandidates += candidates.length;
      if (candidates.length === 0) continue;

      const shortlist = [...candidates]
        .sort((a, b) => scoreCandidate(b, vibe, seg.center, radius) - scoreCandidate(a, vibe, seg.center, radius))
        .slice(0, CURATOR_LIST_SIZE);
      const curated = await llmJson({
        tier: "fast",
        timeoutMs: 6000,
        schema: CuratorSchema,
        system:
          'You curate places for a traveller. Return the indices of the listed places in the order the traveller would most enjoy, best first. Only use indices from the list. Consider their taste, interests, what they want to avoid, and dietary needs. Reply as JSON: {"order": [indices]}',
        user: JSON.stringify({ city: seg.city, traveller: tasteOf(vibe), dietary: rec.trip.dietaryRestrictions, places: shortlist.map((c, i) => ({ i, name: c.name, kind: c.kind })) }),
      });
      curatedVia ||= curated.ok ? `curated by ${curated.via}` : `ranked by open-data score (AI curator unavailable: ${curated.reason})`;
      const llmOrder = curated.ok ? [...new Set(curated.value.order)].filter((i) => i < shortlist.length).map((i) => shortlist[i].sourceId) : [];
      // Must-sees always lead the order, whatever the curator said.
      const curatedOrder = [...new Set([...seg.mustSee.map((m) => m.sourceId), ...llmOrder])];

      const legState = await warmLegs(candidates).catch(() => "unavailable" as const);
      if (legState === "unavailable") routing = "unavailable";
      else if (routing !== "unavailable" && legState === "osrm") routing = "osrm";

      // Transfer into this city on its first day.
      let transfer: ItineraryNode | undefined;
      let startMinute: number | undefined;
      const prev = segments[k - 1];
      if (prev) {
        await warmLegs([prev.center, seg.center]).catch(() => undefined);
        const leg = cachedLeg(prev.center, seg.center);
        const km = haversineMeters(prev.center, seg.center) / 1000;
        if (leg && leg.durationMinutes <= MAX_ROAD_TRANSFER_MIN) {
          const minutes = Math.max(15, Math.round(leg.durationMinutes / 5) * 5);
          transfer = transitNode(prev, seg, shape.dayStart, minutes, leg.distanceMeters / 1000, true);
          startMinute = shape.dayStart + minutes + TRANSFER_SETTLE_MIN;
        } else {
          const minutes = Math.max(60, LONG_TRANSFER_RESUME - shape.dayStart);
          transfer = transitNode(prev, seg, shape.dayStart, minutes, km, false);
          startMinute = shape.dayStart + minutes + TRANSFER_SETTLE_MIN;
          notes.push(`${prev.city} → ${seg.city} is ${Math.round(km)} km — trains or flights are likely faster (see Flights)`);
        }
      }
      const days = emptyDays.filter((d) => seg.dayIndexes.includes(d.dayIndex)).map((d, i) => (i === 0 && startMinute !== undefined ? { ...d, startMinute } : d));
      const out = planDays({
        days,
        candidates,
        vibe,
        center: seg.center,
        radiusMeters: radius,
        city: seg.city,
        curatedOrder,
        pinned: seg.mustSee.map((m) => m.sourceId),
        idFactory: newId,
        leg: cachedLeg,
        dietary: rec.trip.dietaryRestrictions,
      });
      for (const [i, p] of out.entries()) {
        planned.push({ ...p, nodes: i === 0 && transfer ? [transfer, ...p.nodes] : p.nodes, center: seg.center });
      }
    }
    if (totalCandidates === 0) {
      await setPlanner(tripId, { status: "FAILED", note: `No places found near ${segments.map((s) => s.city).join(", ")}${failures.length ? ` (${failures[0]})` : ""}.`, at: at() });
      return;
    }

    // 6. Forecast rain: move outdoor stops with the same heal() the rain simulator uses (no LLM).
    await setPlanner(tripId, { status: "RUNNING", note: "Checking the forecast for each day…", at: at() });
    const policy = policyFromVibe(vibe);
    const drafted = new Map<number, { day: DaySchedule; rainNote?: string }>();
    for (const p of planned) {
      const base = rec.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
      if (!base || p.nodes.length === 0) continue;
      const inserts: TripPatch[] = p.nodes.map((payload) => ({ patchId: newId(), targetDayIndex: p.dayIndex, operation: "INSERT", payload, reason: `Planned "${payload.title}"` }));
      let day = applyPatches(base, inserts, { routed: routedLookup });
      const forecast = await rainWindows(p.center.lat, p.center.lng, base.date).catch(() => null);
      let moved = 0;
      let dropped = 0;
      for (const w of forecast?.available ? forecast.windows : []) {
        const hit = day.nodes.some((n) => n.isOutdoor && toMinutes(n.timeSlot.start) < w.toMinute && toMinutes(n.timeSlot.start) + n.timeSlot.durationMinutes > w.fromMinute);
        if (!hit) continue;
        const r = heal(day, { kind: "WEATHER", fromMinute: w.fromMinute, toMinute: w.toMinute, reason: "Forecast rain" }, { policy, routed: routedLookup });
        moved += r.patches.filter((x) => x.operation !== "REMOVE").length;
        dropped += r.patches.filter((x) => x.operation === "REMOVE").length;
        day = r.preview;
      }
      const windows = forecast?.available ? forecast.windows.map((w) => `${fromMinutes(w.fromMinute)}–${w.toMinute >= 1440 ? "24:00" : fromMinutes(w.toMinute)}`).join(", ") : "";
      drafted.set(p.dayIndex, {
        day,
        rainNote: moved + dropped > 0 ? `rain forecast ${windows}: rescheduled ${moved}${dropped ? `, skipped ${dropped} outdoor stop${dropped > 1 ? "s" : ""}` : ""}` : undefined,
      });
    }

    const summary = await write((db) => {
      const cur = db.trips.find((t) => t.trip.id === tripId);
      if (!cur) return null;
      let filled = 0;
      for (const p of planned) {
        const day = cur.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
        const draft = drafted.get(p.dayIndex);
        if (!day || day.nodes.length > 0 || !draft || draft.day.nodes.length === 0) continue; // user edited meanwhile, or nothing found
        const next = draft.day;
        cur.trip.schedule = cur.trip.schedule.map((d) => (d.dayIndex === p.dayIndex ? next : d));
        filled++;
        db.activity.push({
          id: newId(),
          tripId,
          at: new Date().toISOString(),
          actor: "planner agent",
          message: `Planned day ${p.dayIndex}: ${draft.day.nodes.map((n) => n.title).join(" → ")}${[p.note, draft.rainNote].filter(Boolean).length ? ` (${[p.note, draft.rainNote].filter(Boolean).join("; ")})` : ""}`,
        });
      }
      if (filled > 0) {
        cur.trip.version += 1;
        cur.updatedAt = new Date().toISOString();
      }
      const how = [
        `${totalCandidates} real places`,
        curatedVia,
        cityChoice && segments.length > 1 ? `cities chosen by ${cityChoice}` : "",
        `travel times ${routing === "unavailable" ? "estimated (OSRM unreachable)" : "from OSRM road routing"}`,
      ].filter(Boolean);
      cur.planner = {
        status: "DONE",
        note: filled
          ? `${routeNote ? `${routeNote}. ` : ""}Planned ${filled} day${filled > 1 ? "s" : ""} from ${how.join("; ")}.${notes.length ? ` Note: ${notes.join("; ")}.` : ""}`
          : emptyDays.length
            ? `Couldn't fit any places into the empty days.${notes.length ? ` ${notes.join("; ")}.` : ""}`
            : "Every day already has stops — nothing to plan.",
        at: new Date().toISOString(),
      };
      return { version: cur.trip.version, note: cur.planner.note };
    });
    if (summary) {
      publish({ type: "trip.updated", tripId, version: summary.version });
      publish({ type: "activity", tripId, message: summary.note });
    }
  } catch (e) {
    await setPlanner(tripId, { status: "FAILED", note: `Planning failed: ${(e as Error).message}`, at: at() });
  }
}
