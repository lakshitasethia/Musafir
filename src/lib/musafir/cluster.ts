/**
 * "Cluster Nearby" (USP 3): when the leg into a stop is a commute spike, find a
 * replacement near the *previous* stop that genuinely shortens the day.
 * Pure and deterministic; callers supply travel times (OSRM cache or estimates).
 */
import { COMMUTE_MODERATE_MAX_MIN } from "./geo.ts";
import type { ItineraryNode } from "./schemas.ts";

/** A swap must save at least this many minutes of travel to be worth offering. */
export const MIN_CLUSTER_SAVING_MIN = 10;

export interface ClusterCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

export interface ClusterChoice<C extends ClusterCandidate> {
  candidate: C;
  before: number;
  after: number;
  saving: number;
}

type Minutes = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number;

/**
 * Picks the candidate that minimises prev→candidate (+ candidate→next) travel,
 * excluding places already in the day. Returns null unless the saving is
 * ≥ MIN_CLUSTER_SAVING_MIN and the new inbound leg is no longer a spike.
 */
export function pickClusterReplacement<C extends ClusterCandidate>(
  prev: ItineraryNode,
  target: ItineraryNode,
  next: ItineraryNode | undefined,
  candidates: readonly C[],
  dayTitles: readonly string[],
  minutes: Minutes,
): ClusterChoice<C> | null {
  const taken = new Set(dayTitles.map((t) => t.trim().toLowerCase()));
  const cost = (p: { lat: number; lng: number }) => minutes(prev.location, p) + (next ? minutes(p, next.location) : 0);
  const before = cost(target.location);
  let best: ClusterChoice<C> | null = null;
  for (const c of candidates) {
    if (taken.has(c.name.trim().toLowerCase())) continue;
    const inbound = minutes(prev.location, c);
    if (inbound > COMMUTE_MODERATE_MAX_MIN) continue;
    const after = cost(c);
    const saving = before - after;
    if (saving < MIN_CLUSTER_SAVING_MIN) continue;
    if (!best || after < best.after || (after === best.after && c.id < best.candidate.id)) best = { candidate: c, before, after, saving };
  }
  return best;
}
