/**
 * Planner agent (supervisor = this code). Drafts every *empty* day of a trip:
 *   1. Nominatim geocodes the destination.
 *   2. Real places near it come from OpenStreetMap (Overpass, Nominatim fallback).
 *   3. Optional LLM curator re-orders a short, pre-scored list by vibe/diet —
 *      it can only return ids from that list.
 *   4. The deterministic planner (lib/musafir/planner.ts) clusters, orders and
 *      times each day. Results go through applyPatches like any other change.
 * Days the traveller already filled are never touched.
 */
import { z } from "zod";
import { newId } from "@/lib/musafir/ids.ts";
import { planDays, scoreCandidate, type PlaceCandidate } from "@/lib/musafir/planner.ts";
import { applyPatches, heal, policyFromVibe } from "@/lib/musafir/reducer.ts";
import type { DaySchedule, TripPatch } from "@/lib/musafir/schemas.ts";
import { fromMinutes, toMinutes } from "@/lib/musafir/time.ts";
import { publish } from "./events.ts";
import { llmJson } from "./llm.ts";
import { nearbyCandidates, searchPlaces, type CandidatePurpose } from "./osm.ts";
import { cachedLeg, routedLookup, warmLegs } from "./routing.ts";
import { read, write, type TripRecord } from "./store.ts";
import { rainWindows } from "./weather.ts";

const SEARCH_RADIUS_M = 3000;
const PURPOSES: CandidatePurpose[] = ["CULTURE", "NATURE", "LEISURE", "DINING"];
const CURATOR_LIST_SIZE = 24;
/** A RUNNING planner older than this is treated as crashed and may be restarted. */
export const PLANNER_STALE_MS = 3 * 60_000;

const CuratorSchema = z.object({ order: z.array(z.number().int().min(0)).max(CURATOR_LIST_SIZE) });

async function setPlanner(tripId: string, planner: NonNullable<TripRecord["planner"]>) {
  await write((db) => {
    const rec = db.trips.find((t) => t.trip.id === tripId);
    if (rec) rec.planner = planner;
  });
  publish({ type: "activity", tripId, message: planner.note });
}

export async function runPlanner(tripId: string): Promise<void> {
  const rec = await read((db) => structuredClone(db.trips.find((t) => t.trip.id === tripId)));
  if (!rec) return;
  const at = () => new Date().toISOString();
  try {
    await setPlanner(tripId, { status: "RUNNING", note: `Finding ${rec.trip.destination} on the map…`, at: at() });
    const [place] = await searchPlaces(rec.trip.destination);
    if (!place) {
      await setPlanner(tripId, { status: "FAILED", note: `Couldn't find "${rec.trip.destination}" on OpenStreetMap. Try a city name.`, at: at() });
      return;
    }
    const center = { lat: place.lat, lng: place.lng };
    const city = place.city || place.name;

    const candidates: PlaceCandidate[] = [];
    const failures: string[] = [];
    for (const purpose of PURPOSES) {
      await setPlanner(tripId, { status: "RUNNING", note: `Gathering ${purpose.toLowerCase()} places near ${city}…`, at: at() });
      try {
        for (const c of await nearbyCandidates(center, purpose, SEARCH_RADIUS_M)) {
          candidates.push({
            sourceId: c.osmId,
            name: c.nameEn ?? c.name,
            nameNative: c.nameEn ? c.name : undefined,
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
    if (candidates.length === 0) {
      await setPlanner(tripId, { status: "FAILED", note: `No places found near ${city}${failures.length ? ` (${failures[0]})` : ""}.`, at: at() });
      return;
    }

    // Curator: an LLM may re-order the top candidates; it only returns indices.
    const vibe = rec.trip.vibeConfig;
    const shortlist = [...candidates]
      .sort((a, b) => scoreCandidate(b, vibe, center, SEARCH_RADIUS_M) - scoreCandidate(a, vibe, center, SEARCH_RADIUS_M))
      .slice(0, CURATOR_LIST_SIZE);
    await setPlanner(tripId, { status: "RUNNING", note: `Curating ${shortlist.length} of ${candidates.length} places for your vibe…`, at: at() });
    const curated = await llmJson({
      tier: "fast",
      timeoutMs: 6000,
      schema: CuratorSchema,
      system:
        'You curate places for a traveller. Return the indices of the listed places in the order the traveller would most enjoy, best first. Only use indices from the list. Consider the vibe values (0–1) and dietary needs. Reply as JSON: {"order": [indices]}',
      user: JSON.stringify({
        destination: rec.trip.destination,
        vibe: { pace01: vibe.pacing, budget01: vibe.budget, localOverIconic01: vibe.culturalDepth, nightOwl01: vibe.circadian },
        dietary: rec.trip.dietaryRestrictions,
        places: shortlist.map((c, i) => ({ i, name: c.name, kind: c.kind })),
      }),
    });
    const curatedOrder = curated.ok ? [...new Set(curated.value.order)].filter((i) => i < shortlist.length).map((i) => shortlist[i].sourceId) : undefined;
    const rankedBy = curated.ok ? `curated by ${curated.via}` : `ranked by open-data score (AI curator unavailable: ${curated.reason})`;

    await setPlanner(tripId, { status: "RUNNING", note: "Fetching real travel times and clustering neighbourhoods…", at: at() });
    const routing = await warmLegs(candidates).catch(() => "unavailable" as const);
    const emptyDays = rec.trip.schedule.filter((d) => d.nodes.length === 0).map((d) => ({ dayIndex: d.dayIndex, date: d.date }));
    const planned = planDays({ days: emptyDays, candidates, vibe, center, radiusMeters: SEARCH_RADIUS_M, city, curatedOrder, idFactory: newId, leg: cachedLeg, dietary: rec.trip.dietaryRestrictions });

    // Build each drafted day, then keep outdoor stops out of *forecast* rain (days within Open-Meteo's
    // ~16-day horizon) by running the same deterministic heal() the rain simulator uses. No LLM involved.
    await setPlanner(tripId, { status: "RUNNING", note: "Checking the forecast for each day…", at: at() });
    const policy = policyFromVibe(vibe);
    const drafted = new Map<number, { day: DaySchedule; rainNote?: string }>();
    for (const p of planned) {
      const base = rec.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
      if (!base || p.nodes.length === 0) continue;
      const inserts: TripPatch[] = p.nodes.map((payload) => ({ patchId: newId(), targetDayIndex: p.dayIndex, operation: "INSERT", payload, reason: `Planned "${payload.title}"` }));
      let day = applyPatches(base, inserts, { routed: routedLookup });
      const forecast = await rainWindows(center.lat, center.lng, base.date).catch(() => null);
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
      cur.planner = {
        status: "DONE",
        note: filled
          ? `Planned ${filled} day${filled > 1 ? "s" : ""} from ${candidates.length} real places — ${rankedBy}; travel times ${routing === "unavailable" ? "estimated (OSRM unreachable)" : "from OSRM road routing"}.`
          : emptyDays.length
            ? "Couldn't fit any places into the empty days."
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
