/**
 * Dining & Dietary Matcher (pure). Ranks real eateries for a meal slot by
 * dietary fit, then travel time from the previous stop (and to the next).
 *
 * Dietary fit comes from an injected checker over OSM `diet:*` tags. The
 * default checker makes no claims: with restrictions it returns "unverified"
 * for everything. Parth's `auditors/diet.ts` plugs in here (CLAUDE.md §10).
 * An LLM must never decide dietary safety.
 */
export type DietStatus = "not-needed" | "verified" | "unverified" | "conflicts";

export type DietChecker = (tags: Readonly<Record<string, string>> | undefined, restrictions: readonly string[]) => DietStatus;

export const noClaimDietChecker: DietChecker = (_tags, restrictions) => (restrictions.length === 0 ? "not-needed" : "unverified");

const RANK: Record<DietStatus, number> = { "not-needed": 0, verified: 0, unverified: 1, conflicts: 2 };

export interface MealCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  diet?: Record<string, string>;
}

export interface MealOption<C extends MealCandidate> {
  candidate: C;
  diet: DietStatus;
  travelMinutes: number;
}

/** Best options first; places that conflict with a restriction are never offered. */
export function rankMealOptions<C extends MealCandidate>(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number } | undefined,
  candidates: readonly C[],
  restrictions: readonly string[],
  minutes: (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => number,
  check: DietChecker = noClaimDietChecker,
  limit = 3,
): MealOption<C>[] {
  return candidates
    .map((candidate) => ({
      candidate,
      diet: check(candidate.diet, restrictions),
      travelMinutes: minutes(from, candidate) + (to ? minutes(candidate, to) : 0),
    }))
    .filter((o) => o.diet !== "conflicts")
    .sort((a, b) => RANK[a.diet] - RANK[b.diet] || a.travelMinutes - b.travelMinutes || a.candidate.id.localeCompare(b.candidate.id))
    .slice(0, limit);
}
