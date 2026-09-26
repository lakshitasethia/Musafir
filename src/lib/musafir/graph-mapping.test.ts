import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, diffById, graphToTrip, tripToGraph } from "./graph-mapping.ts";
import { applyPatches } from "./reducer.ts";
import { TripStateSchema, type ItineraryNode, type TripState } from "./schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const stop = (i: number, extra: Partial<ItineraryNode> = {}): ItineraryNode => ({
  id: uid(i),
  type: "SOFT",
  title: `Stop ${i}`,
  category: "CULTURE",
  location: { lat: 26.9 + i / 100, lng: 75.8, city: "Jaipur" },
  timeSlot: { start: `${String(8 + i).padStart(2, "0")}:00`, durationMinutes: 45, bufferMinutes: 10 },
  isOutdoor: false,
  costEstimate: { amount: 0, currency: "INR" },
  ...extra,
});

function sampleTrip(): TripState {
  const day1 = applyPatches(
    { dayIndex: 1, date: "2026-10-01", nodes: [], transitSegments: [], dailyFatigueScore: 0 },
    [
      stop(1, { nativeTitle: "एल्बर्ट हॉल", nativeAddress: "मोतीडूंगरी मार्ग", location: { lat: 26.91, lng: 75.82, city: "Jaipur", neighborhood: "Adarsh Nagar" }, metadata: { priority: 0.8, plannedBy: "planner", nested: { a: [1, 2] } } }),
      stop(2, { type: "HARD", category: "DINING", isOutdoor: true, costEstimate: { amount: 60.5, currency: "USD" } }),
      stop(3),
    ].map((payload, i) => ({ patchId: uid(100 + i), targetDayIndex: 1, operation: "INSERT", payload, reason: "seed" })),
  );
  return TripStateSchema.parse({
    id: uid(900),
    userId: uid(901),
    destination: "Jaipur",
    dateRange: { start: "2026-10-01", end: "2026-10-03" },
    vibeConfig: { pacing: 0.3, budget: 0.7, culturalDepth: 0.55, circadian: 0.1 },
    dietaryRestrictions: ["vegetarian", "no peanuts"],
    schedule: [day1, { dayIndex: 2, date: "2026-10-02", nodes: [], transitSegments: [], dailyFatigueScore: 0 }, { dayIndex: 3, date: "2026-10-03", nodes: [stop(9)], transitSegments: [], dailyFatigueScore: 0 }],
    version: 7,
  });
}

test("graph mapping: TripState → rows → TripState is lossless", () => {
  const t = sampleTrip();
  const g = tripToGraph(t);
  assert.deepEqual(graphToTrip(structuredClone(g)), t);
});

test("graph mapping: rows are graph-safe (primitives only, no nulls) with real NEXT edges", () => {
  const g = tripToGraph(sampleTrip());
  const rows = [g.trip, ...g.days, ...g.stops, ...g.legs];
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      assert.notEqual(v, null, `${k} is null`);
      assert.ok(["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => typeof x === "string")), `${k} is not a primitive`);
    }
  }
  assert.equal(g.legs.length, 2);
  assert.deepEqual([g.legs[0].from, g.legs[0].to], [uid(1), uid(2)]);
  assert.equal(g.stops.filter((s) => s.dayKey === dayKey(uid(900), 1)).length, 3);
  assert.equal("nativeTitle" in g.stops.find((s) => s.id === uid(3))!, false); // absent, not null
});

test("graph mapping: row order from the database doesn't matter", () => {
  const t = sampleTrip();
  const g = tripToGraph(t);
  const shuffled = { trip: g.trip, days: [...g.days].reverse(), stops: [...g.stops].reverse(), legs: [...g.legs].reverse() };
  assert.deepEqual(graphToTrip(shuffled), t);
});

test("diffById: only changed/new rows are written, removed ids are deleted", () => {
  const prev = [{ id: "a", v: 1 }, { id: "b", v: 1 }, { id: "c", v: 1 }];
  const next = [{ id: "a", v: 1 }, { id: "b", v: 2 }, { id: "d", v: 1 }];
  const d = diffById(prev, next, (x) => x.id);
  assert.deepEqual(d.upserts.map((x) => x.id), ["b", "d"]);
  assert.deepEqual(d.deletes, ["c"]);
});
