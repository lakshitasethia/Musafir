import assert from "node:assert/strict";
import { test } from "node:test";
import type { DaySchedule, ItineraryNode } from "./schemas.ts";
import { applyScenario, BASELINE, mean, observe, priorModel, rainClass, simulateDay, type WeatherMember } from "./twin.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, start: string, outdoor: boolean, type: "SOFT" | "HARD" = "SOFT"): ItineraryNode => ({
  id: id(n),
  type,
  title: `Stop ${n}`,
  category: outdoor ? "NATURE" : "CULTURE",
  location: { lat: 26.92 + n * 0.002, lng: 75.82, city: "Jaipur" },
  timeSlot: { start, durationMinutes: 60, bufferMinutes: 15 },
  isOutdoor: outdoor,
  costEstimate: { amount: 0, currency: "INR" },
  metadata: {},
});
const day: DaySchedule = {
  dayIndex: 1,
  date: "2026-10-01",
  nodes: [node(1, "09:00", true), node(2, "11:00", true), node(3, "13:00", false), node(4, "16:00", false, "HARD")],
  transitSegments: [],
  dailyFatigueScore: 0,
};
const dry: WeatherMember = { id: "dry", hours: Array.from({ length: 24 }, (_, hour) => ({ hour, precipMm: 0, apparentC: 25, gustKmh: 10 })) };
const stormy: WeatherMember = { id: "storm", hours: Array.from({ length: 24 }, (_, hour) => ({ hour, precipMm: hour >= 9 && hour < 12 ? 12 : 0, apparentC: 25, gustKmh: 20 })) };

test("rain classes follow the AMS/WMO bands", () => {
  assert.equal(rainClass(0), "rain:none");
  assert.equal(rainClass(1), "rain:light");
  assert.equal(rainClass(5), "rain:moderate");
  assert.equal(rainClass(10), "rain:heavy");
  assert.equal(rainClass(60), "rain:violent");
});

test("Bayesian learning: observations move the belief and are counted", () => {
  let m = priorModel();
  const before = mean(m["rain:light"]);
  for (let i = 0; i < 10; i++) m = observe(m, "rain:light", true);
  assert.ok(mean(m["rain:light"]) > before);
  assert.equal(m["rain:light"].n, 10);
});

test("counterfactual scenario: heavier, longer, hotter", () => {
  const s = applyScenario(stormy, { ...BASELINE, precipScale: 2, durationExtendH: 2, tempOffsetC: 5 });
  assert.equal(s.hours.find((h) => h.hour === 10)!.precipMm, 24);
  assert.ok(s.hours.find((h) => h.hour === 13)!.precipMm > 0, "storm extended past noon");
  assert.equal(s.hours.find((h) => h.hour === 20)!.precipMm, 0);
  assert.equal(s.hours[0].apparentC, 30);
});

test("a what-if storm on a dry day is imposed at the chosen hour", () => {
  const s = applyScenario(dry, { ...BASELINE, precipAddMm: 20, durationExtendH: 1, stormStartHour: 9 });
  assert.deepEqual(s.hours.filter((h) => h.precipMm > 0).map((h) => h.hour), [9, 10, 11]);
  const t = simulateDay(day, [dry], { model: priorModel(), seed: 5, samplesPerMember: 40, scenario: { ...BASELINE, precipAddMm: 20, stormStartHour: 9 } });
  assert.ok(t.stops.find((x) => x.nodeId === id(1))!.pDisrupted > 0.5, "outdoor 09:00 stop hit by the storm");
});

test("dry day: nothing happens", () => {
  const t = simulateDay(day, [dry], { model: priorModel(), seed: 1, samplesPerMember: 100 });
  assert.ok(t.stops.every((s) => s.pDisrupted < 0.1));
  assert.ok(t.pAnyChange < 0.2);
});

test("storm over the outdoor morning: those stops are at risk, indoor ones aren't, cascade recorded", () => {
  const t = simulateDay(day, [stormy], { model: priorModel(), seed: 7, samplesPerMember: 40 });
  const s1 = t.stops.find((s) => s.nodeId === id(1))!;
  const s3 = t.stops.find((s) => s.nodeId === id(3))!;
  assert.ok(s1.pDisrupted > 0.5, `outdoor stop in heavy rain p=${s1.pDisrupted}`);
  assert.equal(s3.pDisrupted, 0);
  assert.ok(t.pAnyChange > 0.5);
  assert.ok(t.edges.some((e) => e.from === "weather" && e.kind === "disrupts"));
  assert.equal(t.runs, 40);
});

test("what-if: a flood makes things worse than the baseline", () => {
  const base = simulateDay(day, [dry], { model: priorModel(), seed: 3, samplesPerMember: 30 });
  const flood = simulateDay(day, [dry], { model: priorModel(), seed: 3, samplesPerMember: 30, scenario: { ...BASELINE, flood: true } });
  assert.ok(flood.pAnyChange > base.pAnyChange);
  assert.ok(flood.travelSlowdown.mean > base.travelSlowdown.mean);
});

test("the simulation never mutates the real day", () => {
  const snapshot = JSON.stringify(day);
  simulateDay(day, [stormy], { model: priorModel(), seed: 9, samplesPerMember: 10, scenario: { ...BASELINE, flood: true } });
  assert.equal(JSON.stringify(day), snapshot);
});
