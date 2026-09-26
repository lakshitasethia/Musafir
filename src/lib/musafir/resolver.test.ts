import { test } from "node:test";
import assert from "node:assert/strict";
import { rankReplacements, stopsNeedingReplacement } from "./resolver.ts";
import type { ItineraryNode, TripPatch } from "./schemas.ts";

const node = (id: string, type: "HARD" | "SOFT" = "SOFT"): ItineraryNode => ({
  id,
  type,
  title: id,
  category: "CULTURE",
  location: { lat: 0, lng: 0, city: "X" },
  timeSlot: { start: "10:00", durationMinutes: 60, bufferMinutes: 0 },
  isOutdoor: true,
  costEstimate: { amount: 0, currency: "USD" },
});
const rm = (nodeId: string): TripPatch => ({ patchId: "00000000-0000-4000-8000-000000000001", targetDayIndex: 1, operation: "REMOVE", nodeId, reason: "x" });
const shift = (nodeId: string): TripPatch => ({ patchId: "00000000-0000-4000-8000-000000000002", targetDayIndex: 1, operation: "SHIFT_TIME", nodeId, shiftOffsetMinutes: 60, reason: "x" });

test("replacement is only sought when a stop was actually lost", () => {
  const nodes = [node("a"), node("b"), node("h", "HARD")];
  assert.deepEqual(stopsNeedingReplacement("CLOSURE", ["a"], [rm("a")], nodes), ["a"]);
  assert.deepEqual(stopsNeedingReplacement("CLOSURE", ["h"], [], nodes), []); // locked: operator's job
  assert.deepEqual(stopsNeedingReplacement("WEATHER", ["a", "b"], [shift("a"), rm("b")], nodes), ["b"]); // a was just moved
  assert.deepEqual(stopsNeedingReplacement("WEATHER", ["a"], [shift("a")], nodes), []);
  assert.deepEqual(stopsNeedingReplacement("DELAY", ["a"], [rm("a")], nodes), []);
});

const target = { category: "CULTURE" as const, timeSlot: { start: "18:00", durationMinutes: 60, bufferMinutes: 0 } };
const MON = "2026-09-28";

test("closed places are never offered; open beats unknown; purpose and nearness break ties", () => {
  const { ranked } = rankReplacements(
    [
      { name: "Closed museum", category: "CULTURE", distanceMeters: 100, openingHours: "Mo-Su 09:00-17:00" },
      { name: "Far open gallery", category: "CULTURE", distanceMeters: 700, openingHours: "Mo-Su 10:00-20:00" },
      { name: "Near, hours unknown", category: "CULTURE", distanceMeters: 150 },
      { name: "Open cinema", category: "LEISURE", distanceMeters: 200, openingHours: "10:00-23:00" },
    ],
    target,
    { date: MON, wantCategory: "CULTURE" },
  );
  assert.deepEqual(ranked.map((r) => r.candidate.name), ["Far open gallery", "Open cinema", "Near, hours unknown"]);
  assert.equal(ranked[0].hours, "open");
});

test("near-identical top candidates are flagged as ambiguous (the only case an LLM is asked)", () => {
  const same = { category: "CULTURE" as const, openingHours: "10:00-20:00" };
  assert.equal(rankReplacements([{ name: "A", distanceMeters: 300, ...same }, { name: "B", distanceMeters: 310, ...same }], target, { date: MON }).ambiguous, true);
  assert.equal(rankReplacements([{ name: "A", distanceMeters: 100, ...same }, { name: "B", distanceMeters: 100, category: "CULTURE" as const }], target, { date: MON }).ambiguous, false);
});
