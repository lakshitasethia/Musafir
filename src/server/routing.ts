/**
 * Routed travel times from the public OSRM demo server, behind a cache.
 * Policy (OSRM wiki, checked 2026-09-26): ≤ 1 request/second, reasonable
 * non-commercial use, no uptime guarantee. So: one table request per batch,
 * serialized with a 1.1 s gap, and only real OSRM answers are cached — a failure
 * leaves callers on the Haversine estimate.
 *
 * Callers warm the cache *before* a write, then pass the synchronous lookup into
 * the pure engine; background work never rewrites trip state.
 */
import { distanceMatrix, OSRM_MAX_TABLE_COORDS, type LegEstimate, type LegLookup } from "@/lib/musafir/geo.ts";

type Point = { lat: number; lng: number };
const MIN_GAP_MS = 1100;
const MAX_ENTRIES = 20_000;
const key = (p: Point) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

const g = globalThis as typeof globalThis & {
  __musafirRouting?: { legs: Map<string, LegEstimate>; chain: Promise<unknown>; last: number };
};
const state = (g.__musafirRouting ??= { legs: new Map(), chain: Promise.resolve(), last: 0 });

export function cachedLeg(a: Point, b: Point): LegEstimate | undefined {
  return state.legs.get(`${key(a)}>${key(b)}`);
}

/** Lookup for the pure engine (`applyPatches`, `heal`, `planDays`). */
export const routedLookup: LegLookup = (a, b) => cachedLeg(a.location, b.location);

/** Fetches every missing pair among `points` in one OSRM table call (best effort). */
export async function warmLegs(points: readonly Point[]): Promise<"osrm" | "cached" | "unavailable"> {
  const unique = [...new Map(points.map((p) => [key(p), p])).values()].slice(0, OSRM_MAX_TABLE_COORDS);
  if (unique.length < 2) return "cached";
  const missing = unique.some((a) => unique.some((b) => a !== b && !state.legs.has(`${key(a)}>${key(b)}`)));
  if (!missing) return "cached";

  const run = state.chain.catch(() => undefined).then(async () => {
    const wait = state.last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    state.last = Date.now();
    const m = await distanceMatrix(unique);
    if (m.source !== "osrm") return "unavailable" as const;
    if (state.legs.size > MAX_ENTRIES) state.legs.clear();
    unique.forEach((a, i) => unique.forEach((b, j) => i !== j && state.legs.set(`${key(a)}>${key(b)}`, m.legs[i][j])));
    return "osrm" as const;
  });
  state.chain = run;
  return run;
}
