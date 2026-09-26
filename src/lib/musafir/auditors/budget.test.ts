import { test } from "node:test";
import assert from "node:assert/strict";
import { auditBudget, isCostKnown } from "./budget.ts";
import { DayScheduleSchema, type DaySchedule, type ItineraryNodeInput } from "../schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const loc = { lat: 26.9239, lng: 75.8267, city: "Jaipur" };
const node = (n: number, amount: number, currency = "INR", metadata?: Record<string, unknown>): ItineraryNodeInput => ({
  id: uid(n),
  type: "SOFT",
  title: `Stop ${n}`,
  category: "CULTURE",
  location: loc,
  timeSlot: { start: `${String(8 + n).padStart(2, "0")}:00`, durationMinutes: 45, bufferMinutes: 0 },
  costEstimate: { amount, currency },
  ...(metadata ? { metadata } : {}),
});
const day = (dayIndex: number, nodes: ItineraryNodeInput[]): DaySchedule =>
  DayScheduleSchema.parse({ dayIndex, date: `2026-10-0${dayIndex}`, nodes, transitSegments: [], dailyFatigueScore: 0 });
const PLANNER_UNKNOWN = { costSource: "unknown (no price in open data)" };

test("budget: which costs count as known", () => {
  const n = (amount: number, metadata?: Record<string, unknown>) => ({ costEstimate: { amount, currency: "INR" }, metadata });
  assert.equal(isCostKnown(n(200)), true);
  assert.equal(isCostKnown(n(0)), false, "a bare zero is unknown, not free");
  assert.equal(isCostKnown(n(0, PLANNER_UNKNOWN)), false);
  assert.equal(isCostKnown(n(0, { costSource: "carried over from the replaced stop (no price data)" })), false);
  assert.equal(isCostKnown(n(500, PLANNER_UNKNOWN)), false, "an amount with an 'unknown' source is still unknown");
  assert.equal(isCostKnown(n(0, { costSource: "free entry" })), true);
  assert.equal(isCostKnown(n(0, { costKnown: true })), true);
  assert.equal(isCostKnown(n(300, { costKnown: false })), false);
});

test("budget: sums known costs per currency, per day and overall; unknowns make it a minimum", () => {
  const trip = [
    day(1, [node(1, 200), node(2, 0, "INR", PLANNER_UNKNOWN), node(3, 150.5)]),
    day(2, [node(4, 0, "INR", { costSource: "free" }), node(5, 12, "usd")]),
  ];
  const r = auditBudget(trip);
  assert.deepEqual(r.totals, [
    { currency: "INR", amount: 350.5, knownItems: 3 },
    { currency: "USD", amount: 12, knownItems: 1 },
  ]);
  assert.deepEqual(r.days[0].unknownNodeIds, [uid(2)]);
  assert.equal(r.knownCount, 4);
  assert.equal(r.unknownCount, 1);
  assert.equal(r.isLowerBound, true);
  assert.equal(r.findings[0].code, "UNKNOWN_COSTS");
  assert.match(r.findings[0].message, /1 of 5 stops has no price/);
});

test("budget: sums don't drift with decimals", () => {
  const r = auditBudget([day(1, [node(1, 0.1, "EUR"), node(2, 0.2, "EUR")])]);
  assert.equal(r.totals[0].amount, 0.3);
});

test("budget: over, near and under a limit", () => {
  const trip = [day(1, [node(1, 900), node(2, 200)])];
  const over = auditBudget(trip, { amount: 1000, currency: "inr" });
  assert.equal(over.findings.find((f) => f.code === "OVER_BUDGET")?.severity, "ALERT");
  assert.match(over.findings[0].message, /INR 100 over the INR 1,000 budget/);

  assert.equal(auditBudget(trip, { amount: 1200, currency: "INR" }).findings[0].code, "NEAR_BUDGET");
  assert.deepEqual(auditBudget(trip, { amount: 5000, currency: "INR" }).findings, []);
});

test("budget: other currencies are reported, never converted or counted", () => {
  const r = auditBudget([day(1, [node(1, 100), node(2, 40, "USD")])], { amount: 1000, currency: "INR" });
  assert.deepEqual(r.findings.map((f) => f.code), ["OTHER_CURRENCY"]);
  assert.match(r.findings[0].message, /USD 40 can't be counted against a budget in INR/);
});

test("budget: nothing known yet and an empty trip", () => {
  const r = auditBudget([day(1, [node(1, 0, "INR", PLANNER_UNKNOWN)])], { amount: 100, currency: "INR" });
  assert.deepEqual(r.totals, []);
  assert.deepEqual(r.findings.map((f) => f.code), ["UNKNOWN_COSTS"]);
  const empty = auditBudget([]);
  assert.equal(empty.isLowerBound, false);
  assert.deepEqual(empty.findings, []);
});

test("budget: invalid limits throw", () => {
  const trip = [day(1, [node(1, 10)])];
  assert.throws(() => auditBudget(trip, { amount: -1, currency: "INR" }), RangeError);
  assert.throws(() => auditBudget(trip, { amount: Number.NaN, currency: "INR" }), RangeError);
  assert.throws(() => auditBudget(trip, { amount: 10, currency: "rupees" }), RangeError);
});
