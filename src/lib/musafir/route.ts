/**
 * Multi-city routing for area destinations ("Japan", "Kerala"). Pure: given
 * real candidate cities (fetched by the server) and the trip's days, choose
 * how many cities fit, which ones, in what order, and which days each gets.
 *
 *  - pacing decides days per city (slow = 3, fast = 2); never below 1 day
 *  - order of preference: an optional curated list (LLM or traveller), then
 *    popularity; a city joins only if it's within `maxLegKm` of one already
 *    chosen, so a 6-day India trip isn't Delhi → Chennai → Shimla
 *  - route order: nearest-neighbour from the first (most popular / preferred)
 *  - spare days go to the more popular cities
 */
import { haversineMeters } from "./geo.ts";

export interface CityOption {
  id: string;
  name: string;
  lat: number;
  lng: number;
  /** Higher = better known (e.g. Wikipedia language editions). */
  popularity: number;
  /** Short traveller-facing description from the source, if any. */
  blurb?: string;
}

export interface RouteSegment {
  city: CityOption;
  dayIndexes: number[];
}

export const MAX_CITIES = 5;
export const MAX_LEG_KM = 600;

export function daysPerCity(pacing: number): number {
  return pacing >= 0.5 ? 2 : 3;
}

export function planRoute(
  cities: readonly CityOption[],
  dayIndexes: readonly number[],
  opts: { pacing: number; preferredIds?: readonly string[]; maxCities?: number; maxLegKm?: number },
): RouteSegment[] {
  const valid = cities.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  if (valid.length === 0 || dayIndexes.length === 0) return [];
  const maxCities = Math.max(1, opts.maxCities ?? MAX_CITIES);
  const maxLeg = (opts.maxLegKm ?? MAX_LEG_KM) * 1000;
  const want = Math.min(maxCities, valid.length, Math.max(1, Math.floor(dayIndexes.length / daysPerCity(opts.pacing))));

  const preferred = new Map((opts.preferredIds ?? []).map((id, i) => [id, i]));
  const ranked = [...valid].sort((a, b) => {
    const pa = preferred.get(a.id) ?? Infinity;
    const pb = preferred.get(b.id) ?? Infinity;
    return pa - pb || b.popularity - a.popularity || a.name.localeCompare(b.name);
  });

  const chosen: CityOption[] = [ranked[0]];
  for (const c of ranked.slice(1)) {
    if (chosen.length >= want) break;
    if (chosen.some((k) => k.id === c.id)) continue;
    if (chosen.some((k) => haversineMeters(k, c) <= maxLeg)) chosen.push(c);
  }

  // Nearest-neighbour route from the first pick.
  const route: CityOption[] = [];
  const pool = [...chosen];
  let cur: CityOption | undefined = pool[0];
  while (cur) {
    route.push(cur);
    pool.splice(pool.indexOf(cur), 1);
    const from: CityOption = cur;
    cur = pool.sort((a, b) => haversineMeters(from, a) - haversineMeters(from, b))[0];
  }

  // Days: equal share, remainder to the most popular (by the ranking above).
  const base = Math.floor(dayIndexes.length / route.length);
  let extra = dayIndexes.length % route.length;
  const bonus = new Set<string>();
  for (const c of ranked) {
    if (extra === 0) break;
    if (route.includes(c)) {
      bonus.add(c.id);
      extra--;
    }
  }
  const days = [...dayIndexes].sort((a, b) => a - b);
  let at = 0;
  return route.map((city) => {
    const n = base + (bonus.has(city.id) ? 1 : 0);
    const seg = { city, dayIndexes: days.slice(at, at + n) };
    at += n;
    return seg;
  });
}
