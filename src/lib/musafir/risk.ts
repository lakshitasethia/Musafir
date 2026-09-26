/**
 * Tiered autonomy: who must approve a proposed change. Pure and deterministic,
 * so the server can re-run it on anything a client submits.
 *
 *  AUTO      – only time shifts / compression of SOFT stops within the trip's
 *              limits and no extra cost. Applied immediately, undoable.
 *  TRAVELLER – drops, insertions, venue swaps, or shifts beyond the limit.
 *  OPERATOR  – anything touching a locked (HARD) booking, costing more than the
 *              limit, or a conflict only an operator can resolve.
 *
 * An OPERATOR proposal is `escalatable` when the operator was needed only for a
 * conflict notice (no locked booking modified, no extra cost). If the operator
 * does not answer in time, such a proposal may fall back to the traveller.
 */
import { z } from "zod";
import { applyPatches, type Conflict, type ConflictCode } from "./reducer.ts";
import { toMinutes } from "./time.ts";
import type { DaySchedule, ItineraryNode, TripPatch } from "./schemas.ts";

export const AutonomyPolicySchema = z.object({
  autoApply: z.boolean().default(true),
  maxAutoShiftMinutes: z.number().int().nonnegative().default(30),
  maxAutoCostIncrease: z.number().nonnegative().default(0),
  operatorTimeoutMinutes: z.number().int().positive().default(30),
  fallbackToTraveller: z.boolean().default(true),
});
export type AutonomyPolicy = z.infer<typeof AutonomyPolicySchema>;
export const DEFAULT_AUTONOMY: AutonomyPolicy = AutonomyPolicySchema.parse({});

export type RiskTier = "AUTO" | "TRAVELLER" | "OPERATOR";
const RANK: Record<RiskTier, number> = { AUTO: 0, TRAVELLER: 1, OPERATOR: 2 };

const OPERATOR_CONFLICTS: ReadonlySet<ConflictCode> = new Set([
  "HARD_ANCHOR_LATE",
  "HARD_ANCHOR_UNREACHABLE",
  "HARD_VENUE_CLOSED",
  "WEATHER_EXPOSED_LOCKED",
]);

export interface RiskAssessment {
  tier: RiskTier;
  reasons: string[];
  /** Change in summed cost estimate (after − before), in the day's currency. */
  costDelta: number;
  maxShiftMinutes: number;
  escalatable: boolean;
}

function dayCost(nodes: readonly ItineraryNode[]): { total: number; currencies: Set<string> } {
  const currencies = new Set(nodes.map((n) => n.costEstimate.currency));
  return { total: nodes.reduce((s, n) => s + n.costEstimate.amount, 0), currencies };
}

export function classifyRisk(
  before: DaySchedule,
  patches: readonly TripPatch[],
  conflicts: readonly Conflict[],
  policy: AutonomyPolicy = DEFAULT_AUTONOMY,
): RiskAssessment {
  let tier = "AUTO" as RiskTier;
  const reasons: string[] = [];
  const raise = (t: RiskTier, why: string) => {
    if (RANK[t] > RANK[tier]) tier = t;
    reasons.push(why);
  };
  let touchesHard = false;

  const original = new Map(before.nodes.map((n) => [n.id, n]));
  const after = applyPatches(before, patches); // throws on invalid patches
  const costBefore = dayCost(before.nodes);
  const costAfter = dayCost(after.nodes);
  const mixedCurrency = new Set([...costBefore.currencies, ...costAfter.currencies]).size > 1;
  const costDelta = costAfter.total - costBefore.total;

  let maxShiftMinutes = 0;
  for (const p of patches) {
    const target = p.nodeId ? original.get(p.nodeId) : undefined;
    if (target?.type === "HARD" || p.payload?.type === "HARD") {
      touchesHard = true;
      raise("OPERATOR", `changes locked booking "${target?.title ?? p.payload?.title}"`);
    }
    switch (p.operation) {
      case "REMOVE":
        raise("TRAVELLER", `removes "${target?.title}"`);
        break;
      case "INSERT":
        raise("TRAVELLER", `adds "${p.payload?.title}"`);
        break;
      case "SHIFT_TIME":
        maxShiftMinutes = Math.max(maxShiftMinutes, Math.abs(p.shiftOffsetMinutes ?? 0));
        break;
      case "REPLACE": {
        if (!target || !p.payload) break;
        const moved = Math.abs(toMinutes(p.payload.timeSlot.start) - toMinutes(target.timeSlot.start));
        maxShiftMinutes = Math.max(maxShiftMinutes, moved);
        const trimmed = target.timeSlot.durationMinutes - p.payload.timeSlot.durationMinutes;
        if (trimmed < 0 || trimmed > target.timeSlot.bufferMinutes) raise("TRAVELLER", `resizes "${target.title}" beyond its buffer`);
        if (
          p.payload.title !== target.title ||
          p.payload.category !== target.category ||
          p.payload.location.lat !== target.location.lat ||
          p.payload.location.lng !== target.location.lng
        ) {
          raise("TRAVELLER", `swaps "${target.title}" for "${p.payload.title}"`);
        }
        break;
      }
    }
  }
  if (maxShiftMinutes > policy.maxAutoShiftMinutes) raise("TRAVELLER", `moves a stop by ${maxShiftMinutes} min`);

  for (const c of conflicts) if (OPERATOR_CONFLICTS.has(c.code)) raise("OPERATOR", c.message);

  const costOk = !mixedCurrency && costDelta <= policy.maxAutoCostIncrease;
  if (mixedCurrency) raise("OPERATOR", "mixes currencies, cost change can't be verified");
  else if (!costOk) raise("OPERATOR", `adds ${costDelta.toFixed(2)} in cost`);

  if (!policy.autoApply && tier === "AUTO" && patches.length > 0) raise("TRAVELLER", "auto-apply is turned off for this trip");

  return { tier, reasons, costDelta, maxShiftMinutes, escalatable: tier === "OPERATOR" && !touchesHard && costOk };
}

export type Role = "traveller" | "operator";

/** Server-side authorization for approving a proposal option. */
export function canDecide(
  role: Role,
  risk: Pick<RiskAssessment, "tier" | "escalatable">,
  opts: { escalated: boolean; policy: AutonomyPolicy },
): boolean {
  if (role === "operator") return true;
  if (risk.tier !== "OPERATOR") return true;
  return opts.escalated && risk.escalatable && opts.policy.fallbackToTraveller;
}
