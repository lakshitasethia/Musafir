/**
 * Disruption Resolver decisions (pure). Code decides *whether* a replacement is
 * needed and ranks candidates; an LLM is consulted only when the best options
 * are too close to separate on open data.
 */
import { osmDietChecker, type DietChecker } from "./dining.ts";
import { openStatus, type OpenStatus } from "./opening-hours.ts";
import type { ItineraryNode, NodeCategory, TripPatch } from "./schemas.ts";
import { toMinutes } from "./time.ts";

/**
 * Which affected stops really need a replacement place:
 *  - CLOSURE of a SOFT stop → it was removed, so yes.
 *  - WEATHER → only outdoor stops the engine had to drop; ones it simply moved out of the rain are fine.
 */
export function stopsNeedingReplacement(
  kind: string,
  affectedIds: readonly string[],
  enginePatches: readonly TripPatch[],
  nodes: readonly ItineraryNode[],
): string[] {
  const soft = new Set(nodes.filter((n) => n.type === "SOFT").map((n) => n.id));
  if (kind === "CLOSURE") return affectedIds.filter((id) => soft.has(id));
  if (kind === "WEATHER") {
    const removed = new Set(enginePatches.filter((p) => p.operation === "REMOVE").map((p) => p.nodeId));
    return affectedIds.filter((id) => soft.has(id) && removed.has(id));
  }
  return [];
}

export interface ReplacementCandidate {
  name: string;
  category: NodeCategory;
  distanceMeters: number;
  openingHours?: string;
  diet?: Record<string, string>;
}

export interface RankedReplacement<C> {
  candidate: C;
  score: number;
  hours: OpenStatus;
}

/** Score gap below which the top candidates count as a tie worth an LLM opinion. */
export const AMBIGUITY_GAP = 0.1;
const DISTANCE_SCALE_M = 800;

/**
 * Deterministic ranking: closed-at-that-time places are excluded; then open >
 * unknown hours, same purpose as the replaced stop, diet fit, and nearness.
 */
export function rankReplacements<C extends ReplacementCandidate>(
  candidates: readonly C[],
  target: Pick<ItineraryNode, "category" | "timeSlot">,
  opts: { date: string; wantCategory?: NodeCategory; dietary?: readonly string[]; dietCheck?: DietChecker },
): { ranked: RankedReplacement<C>[]; ambiguous: boolean } {
  const start = toMinutes(target.timeSlot.start);
  const end = start + target.timeSlot.durationMinutes;
  const check = opts.dietCheck ?? osmDietChecker;
  const ranked = candidates
    .map((c) => {
      const hours = openStatus(c.openingHours, opts.date, start, end);
      const diet = c.category === "DINING" ? check(c.diet, opts.dietary ?? []) : "not-needed";
      const score =
        (hours === "open" ? 1 : 0) +
        (opts.wantCategory && c.category === opts.wantCategory ? 0.5 : 0) +
        (diet === "verified" ? 0.5 : 0) -
        Math.min(1, c.distanceMeters / DISTANCE_SCALE_M) * 0.5;
      return { candidate: c, score, hours, diet };
    })
    .filter((r) => r.hours !== "closed" && r.diet !== "conflicts")
    .sort((a, b) => b.score - a.score || a.candidate.distanceMeters - b.candidate.distanceMeters)
    .map(({ candidate, score, hours }) => ({ candidate, score, hours }));
  const ambiguous = ranked.length > 1 && ranked[0].score - ranked[1].score < AMBIGUITY_GAP;
  return { ranked, ambiguous };
}
