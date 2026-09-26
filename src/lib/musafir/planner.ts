/**
 * Deterministic day planner. Turns real candidate places + the Vibe Equalizer
 * into scheduled days. No LLM math: clustering, ordering, transit and timing
 * are all computed here. An optional curator (LLM) may only re-rank the given
 * candidates by id before this runs.
 *
 *  - pacing    → stops per day (2…6) and how long each visit lasts
 *  - circadian → when the day starts (08:00…11:00) and ends (18:00…23:00)
 *  - culturalDepth → iconic landmarks vs local/underground places
 *  - budget    → sit-down restaurants vs street food / cafés
 *
 * Each day is a geographic cluster (seeded by the best remaining place, filled
 * with its nearest neighbours), ordered by nearest-neighbour walk, with lunch
 * and dinner inserted near the preceding stop when the day spans a meal window.
 */
import { estimateLeg, haversineMeters, type LegEstimate } from "./geo.ts";
import { osmDietChecker, type DietChecker, type DietStatus } from "./dining.ts";
import { openStatus } from "./opening-hours.ts";
import type { ItineraryNode, NodeCategory, VibeConfig } from "./schemas.ts";
import { fromMinutes, MINUTES_PER_DAY } from "./time.ts";

export interface PlaceCandidate {
  /** Stable id from the data source (e.g. OSM id). */
  sourceId: string;
  name: string;
  nameNative?: string;
  lat: number;
  lng: number;
  category: NodeCategory;
  isOutdoor: boolean;
  /** OSM "key=value" of the main tag, e.g. "tourism=museum". */
  kind: string;
  openingHours?: string;
  source: string;
  /** OSM `diet:*` tags for eateries. */
  diet?: Record<string, string>;
}

export const BASE_VISIT_MINUTES: Record<NodeCategory, number> = {
  CULTURE: 90,
  NATURE: 75,
  LEISURE: 90,
  DINING: 70,
  TRANSIT: 0,
  ACCOMMODATION: 0,
};
export const LUNCH_WINDOW = { from: 12 * 60 + 30, to: 14 * 60 };
export const DINNER_WINDOW = { from: 19 * 60, to: 21 * 60 };
const ICONIC_KINDS = /^(historic=|tourism=(attraction|viewpoint|museum|zoo|theme_park))/;
const LOCAL_KINDS = /^(tourism=gallery|amenity=(arts_centre|theatre|cafe|bar|pub|cinema)|shop=|leisure=(park|garden))/;
const CASUAL_FOOD = /^amenity=(fast_food|food_court|cafe|ice_cream)/;
const SNAP = 5;
/** Places this close whose names contain one another are treated as one venue. */
export const DUPLICATE_RADIUS_M = 80;
/** Score lost per km a stop sits from its day's seed — keeps days walkable. */
export const CLUSTER_PENALTY_PER_KM = 0.15;

/** "Raj Mandir Cinemas" and "Rajmandir cinemas" compare equal. */
export const normalizeName = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");

export interface PlanShape {
  stopsPerDay: number;
  dayStart: number;
  dayEnd: number;
  visitScale: number;
}

export function planShape(vibe: VibeConfig): PlanShape {
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const pacing = clamp01(vibe.pacing);
  const circadian = clamp01(vibe.circadian);
  const snap = (m: number) => Math.round(m / 15) * 15;
  return {
    stopsPerDay: 2 + Math.round(pacing * 4),
    dayStart: snap(8 * 60 + circadian * 180),
    dayEnd: snap(18 * 60 + circadian * 300),
    visitScale: 1.25 - pacing * 0.5,
  };
}

export function scoreCandidate(c: PlaceCandidate, vibe: VibeConfig, center: { lat: number; lng: number }, radiusMeters: number): number {
  const closeness = 1 - Math.min(1, haversineMeters(center, c) / Math.max(1, radiusMeters));
  if (c.category === "DINING") {
    const casual = CASUAL_FOOD.test(c.kind);
    return 0.4 * closeness + 0.6 * (casual ? 1 - vibe.budget : vibe.budget);
  }
  const iconic = ICONIC_KINDS.test(c.kind);
  const local = LOCAL_KINDS.test(c.kind);
  const fit = iconic ? 1 - vibe.culturalDepth : local ? vibe.culturalDepth : 0.5;
  return 0.35 * closeness + 0.55 * fit + (c.category === "NATURE" ? 0.1 : 0);
}

export interface PlanInput {
  days: { dayIndex: number; date: string }[];
  candidates: PlaceCandidate[];
  vibe: VibeConfig;
  center: { lat: number; lng: number };
  radiusMeters: number;
  city: string;
  currency?: string;
  /** Optional curator ranking: sourceIds in preferred order; boosts those places. */
  curatedOrder?: string[];
  idFactory: () => string;
  /** Routed legs between candidates (e.g. OSRM table); falls back to Haversine estimates. */
  leg?: (a: PlaceCandidate, b: PlaceCandidate) => LegEstimate | undefined;
  /** Traveller's dietary restrictions and the checker for OSM diet tags (default makes no claims). */
  dietary?: string[];
  dietCheck?: DietChecker;
}

export interface PlannedDay {
  dayIndex: number;
  nodes: ItineraryNode[];
  /** Why the day is shorter than requested, if it is. */
  note?: string;
}

export function planDays(input: PlanInput): PlannedDay[] {
  const shape = planShape(input.vibe);
  // OSM often maps one venue several times ("Albert Hall" / "Albert Hall Museum").
  const kept: PlaceCandidate[] = [];
  for (const c of input.candidates) {
    const key = normalizeName(c.name);
    if (!key || !Number.isFinite(c.lat) || !Number.isFinite(c.lng) || c.category === "TRANSIT" || c.category === "ACCOMMODATION") continue;
    const dup = kept.some((k) => {
      const other = normalizeName(k.name);
      if (other === key) return true;
      if (haversineMeters(k, c) >= DUPLICATE_RADIUS_M) return false;
      const [short, long] = other.length <= key.length ? [other, key] : [key, other];
      // "Albert Hall" ⊂ "Albert Hall Museum" is one venue; "Gate 1" vs "Gate 10" is not.
      return long.includes(short) && !/\p{N}/u.test(long.replace(short, ""));
    });
    if (!dup) kept.push(c);
  }
  const unique = kept;
  const curatedRank = new Map((input.curatedOrder ?? []).map((id, i) => [id, i]));
  const score = new Map(
    unique.map((c) => {
      const curated = curatedRank.get(c.sourceId);
      const boost = curated === undefined ? 0 : 0.5 * (1 - curated / Math.max(1, curatedRank.size));
      return [c.sourceId, scoreCandidate(c, input.vibe, input.center, input.radiusMeters) + boost];
    }),
  );
  const byScore = (a: PlaceCandidate, b: PlaceCandidate) => score.get(b.sourceId)! - score.get(a.sourceId)! || a.sourceId.localeCompare(b.sourceId);
  const sights = unique.filter((c) => c.category !== "DINING").sort(byScore);
  const food = unique.filter((c) => c.category === "DINING").sort(byScore);

  const travelMinutes = (a: { lat: number; lng: number }, b: PlaceCandidate) =>
    ("sourceId" in a && input.leg?.(a as PlaceCandidate, b)?.durationMinutes) || estimateLeg(a, b).durationMinutes;

  return input.days.map((d) => {
    // 1. Cluster: every remaining sight is tried as a seed with its nearest
    //    neighbours; the most valuable *compact* group wins the day.
    let cluster: PlaceCandidate[] = [];
    let bestValue = -Infinity;
    for (const seed of sights) {
      const group = [...sights].sort((a, b) => haversineMeters(seed, a) - haversineMeters(seed, b) || byScore(a, b)).slice(0, shape.stopsPerDay);
      const value = group.reduce((v, c) => v + score.get(c.sourceId)! - (CLUSTER_PENALTY_PER_KM * haversineMeters(seed, c)) / 1000, 0);
      if (value > bestValue + 1e-9) {
        bestValue = value;
        cluster = group;
      }
    }
    for (const c of cluster) sights.splice(sights.indexOf(c), 1);
    // 2. Order: nearest-neighbour walk starting from the stop closest to the centre.
    const ordered: PlaceCandidate[] = [];
    const pool = [...cluster];
    let cur = pool.sort((a, b) => haversineMeters(input.center, a) - haversineMeters(input.center, b))[0];
    while (cur) {
      ordered.push(cur);
      pool.splice(pool.indexOf(cur), 1);
      const from: PlaceCandidate = cur;
      cur = pool.sort((a, b) => haversineMeters(from, a) - haversineMeters(from, b))[0];
    }
    // 3. Time it, inserting meals near the previous stop.
    const nodes: ItineraryNode[] = [];
    let cursor = shape.dayStart;
    let prev = null as { lat: number; lng: number } | null;
    let hadLunch = false;
    let hadDinner = false;
    let truncated = 0;
    let closedSkips = 0;
    /** "late" = past the day's end; "closed" = its opening hours exclude this slot. */
    const place = (c: PlaceCandidate, minutes: number, diet?: DietStatus): true | "late" | "closed" => {
      const travel = prev ? travelMinutes(prev, c) : 0;
      const start = Math.ceil((cursor + travel) / SNAP) * SNAP;
      const duration = Math.max(20, Math.round((minutes * shape.visitScale) / SNAP) * SNAP);
      if (start + duration > Math.min(shape.dayEnd, MINUTES_PER_DAY - 1)) return "late";
      const hours = openStatus(c.openingHours, d.date, start, start + duration);
      if (hours === "closed") return "closed";
      nodes.push({
        id: input.idFactory(),
        type: "SOFT",
        title: c.name,
        nativeTitle: c.nameNative && c.nameNative !== c.name ? c.nameNative : undefined,
        category: c.category,
        location: { lat: c.lat, lng: c.lng, city: input.city },
        timeSlot: { start: fromMinutes(start), durationMinutes: duration, bufferMinutes: Math.round(duration / 4 / SNAP) * SNAP },
        isOutdoor: c.isOutdoor,
        costEstimate: { amount: 0, currency: input.currency ?? "USD" },
        metadata: {
          source: c.source,
          sourceId: c.sourceId,
          kind: c.kind,
          priority: Math.round(Math.min(1, Math.max(0, score.get(c.sourceId)!)) * 100) / 100,
          costSource: "unknown (no price in open data)",
          plannedBy: "planner",
          ...(c.openingHours ? { openingHours: c.openingHours } : {}),
          hours,
          ...(diet && diet !== "not-needed" ? { diet } : {}),
        },
      });
      cursor = start + duration;
      prev = c;
      return true;
    };
    const meal = (window: { from: number; to: number }) => {
      const here = prev ?? input.center;
      const restrictions = input.dietary ?? [];
      const check = input.dietCheck ?? osmDietChecker;
      const DIET_RANK = { "not-needed": 0, verified: 0, unverified: 1, conflicts: 2 } as const;
      // Never place food that conflicts with a restriction; prefer verified fits, then proximity.
      const mealEnd = window.from + BASE_VISIT_MINUTES.DINING;
      const [best] = food
        .filter((f) => haversineMeters(here, f) < input.radiusMeters)
        .filter((f) => openStatus(f.openingHours, d.date, window.from, mealEnd) !== "closed")
        .map((f) => ({ f, diet: check(f.diet, restrictions) }))
        .filter((x) => x.diet !== "conflicts")
        .sort((a, b) => DIET_RANK[a.diet] - DIET_RANK[b.diet] || haversineMeters(here, a.f) - haversineMeters(here, b.f) || byScore(a.f, b.f));
      if (!best) return;
      const pick = best.f;
      cursor = Math.max(cursor, window.from - (prev ? travelMinutes(prev, pick) : 0));
      if (place(pick, BASE_VISIT_MINUTES.DINING, best.diet) === true) food.splice(food.indexOf(pick), 1);
    };
    for (const c of ordered) {
      if (!hadLunch && cursor >= LUNCH_WINDOW.from - 30 && cursor <= LUNCH_WINDOW.to) {
        meal(LUNCH_WINDOW);
        hadLunch = true;
      }
      if (!hadDinner && cursor >= DINNER_WINDOW.from - 30 && cursor <= DINNER_WINDOW.to) {
        meal(DINNER_WINDOW);
        hadDinner = true;
      }
      const placed = place(c, BASE_VISIT_MINUTES[c.category]);
      if (placed !== true) {
        if (placed === "closed") closedSkips++;
        else truncated++;
        sights.push(c); // give unused places back to later days (another day may suit its hours)
      }
    }
    // The last sight may end right at a meal time; don't skip the meal just because no sight follows.
    if (!hadLunch && cursor >= LUNCH_WINDOW.from - 30 && cursor <= LUNCH_WINDOW.to) meal(LUNCH_WINDOW);
    if (!hadDinner && shape.dayEnd >= DINNER_WINDOW.from + 60 && cursor <= DINNER_WINDOW.to) meal(DINNER_WINDOW);
    sights.sort(byScore);

    const parts = [
      truncated > 0 ? `${truncated} place${truncated > 1 ? "s" : ""} didn't fit before ${fromMinutes(shape.dayEnd)}` : "",
      closedSkips > 0 ? `${closedSkips} skipped because ${closedSkips > 1 ? "they're" : "it's"} closed then` : "",
    ].filter(Boolean);
    const note = nodes.length === 0 ? "No places found for this day." : parts.length ? `${parts.join("; ")}.` : undefined;
    return { dayIndex: d.dayIndex, nodes, note };
  });
}
