import { test } from "node:test";
import assert from "node:assert/strict";
import { cascadeDelay, heal } from "./reducer.ts";
import { DEFAULT_AUTONOMY, canDecide, classifyRisk } from "./risk.ts";
import { DayScheduleSchema, type ItineraryNodeInput } from "./schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const loc = { lat: 26.9239, lng: 75.8267, city: "Jaipur" };
const node = (n: number, type: "HARD" | "SOFT", start: string, duration: number, extra: Partial<ItineraryNodeInput> = {}): ItineraryNodeInput => ({
  id: uid(n), type, title: `Stop ${n}`, category: "CULTURE", location: loc,
  timeSlot: { start, durationMinutes: duration, bufferMinutes: 15 }, costEstimate: { amount: 10 }, ...extra,
});
const day = (nodes: ItineraryNodeInput[]) => DayScheduleSchema.parse({ dayIndex: 1, date: "2026-10-01", nodes, transitSegments: [], dailyFatigueScore: 0 });
const opts = { transitMinutes: () => 0 };

test("risk: small SOFT shift is AUTO; beyond the limit it needs the traveller", () => {
  const d = day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "12:00", 60)]);
  const small = cascadeDelay(d, { nodeId: uid(1), delayMinutes: 20, reason: "x" }, opts);
  assert.equal(classifyRisk(d, small.patches, small.conflicts).tier, "AUTO");
  const big = cascadeDelay(d, { nodeId: uid(1), delayMinutes: 45, reason: "x" }, opts);
  assert.equal(classifyRisk(d, big.patches, big.conflicts).tier, "TRAVELLER");
  assert.equal(classifyRisk(d, small.patches, small.conflicts, { ...DEFAULT_AUTONOMY, autoApply: false }).tier, "TRAVELLER");
});

test("risk: drops need the traveller; locked-booking conflicts need an operator", () => {
  const d = day([node(1, "SOFT", "10:00", 60), node(2, "HARD", "11:00", 60)]);
  const closed = heal(d, { kind: "CLOSURE", nodeId: uid(1), reason: "x" }, opts);
  assert.equal(classifyRisk(d, closed.patches, closed.conflicts).tier, "TRAVELLER");
  const late = cascadeDelay(d, { nodeId: uid(2), delayMinutes: 20, reason: "x" }, opts);
  const r = classifyRisk(d, late.patches, late.conflicts);
  assert.equal(r.tier, "OPERATOR");
  assert.equal(r.escalatable, true);
});

test("risk: a patch touching a HARD node or adding cost is OPERATOR and not escalatable", () => {
  const hard = node(2, "HARD", "11:00", 60);
  const d = day([node(1, "SOFT", "09:00", 60), hard]);
  const remove = [{ patchId: uid(90), targetDayIndex: 1, operation: "REMOVE" as const, nodeId: uid(2), reason: "x" }];
  const r = classifyRisk(d, remove, []);
  assert.equal(r.tier, "OPERATOR");
  assert.equal(r.escalatable, false);
  const pricey = [{ patchId: uid(91), targetDayIndex: 1, operation: "INSERT" as const, payload: { ...node(3, "SOFT", "14:00", 60), costEstimate: { amount: 99, currency: "USD" }, isOutdoor: false, timeSlot: { start: "14:00", durationMinutes: 60, bufferMinutes: 15 } }, reason: "x" }];
  assert.equal(classifyRisk(d, pricey, []).tier, "OPERATOR");
});

test("canDecide: travellers can't approve operator-tier unless escalated and escalatable", () => {
  const op = { tier: "OPERATOR" as const, escalatable: true };
  assert.equal(canDecide("operator", op, { escalated: false, policy: DEFAULT_AUTONOMY }), true);
  assert.equal(canDecide("traveller", op, { escalated: false, policy: DEFAULT_AUTONOMY }), false);
  assert.equal(canDecide("traveller", op, { escalated: true, policy: DEFAULT_AUTONOMY }), true);
  assert.equal(canDecide("traveller", { ...op, escalatable: false }, { escalated: true, policy: DEFAULT_AUTONOMY }), false);
  assert.equal(canDecide("traveller", op, { escalated: true, policy: { ...DEFAULT_AUTONOMY, fallbackToTraveller: false } }), false);
  assert.equal(canDecide("traveller", { tier: "TRAVELLER", escalatable: false }, { escalated: false, policy: DEFAULT_AUTONOMY }), true);
});
