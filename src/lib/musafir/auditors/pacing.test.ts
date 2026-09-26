import { test } from "node:test";
import assert from "node:assert/strict";
import { HEAT_DANGER_C, HEAT_EXTREME_CAUTION_C, auditPacing } from "./pacing.ts";
import { DayScheduleSchema, type DaySchedule, type ItineraryNodeInput, type TransitSegment } from "../schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JAIPUR = { lat: 26.9239, lng: 75.8267, city: "Jaipur" };
const node = (n: number, start: string, duration: number, extra: Partial<ItineraryNodeInput> = {}): ItineraryNodeInput => ({
  id: uid(n),
  type: "SOFT",
  title: `Stop ${n}`,
  category: "CULTURE",
  location: JAIPUR,
  timeSlot: { start, durationMinutes: duration, bufferMinutes: 0 },
  costEstimate: { amount: 0 },
  ...extra,
});
const leg = (from: number, to: number, mode: TransitSegment["mode"], minutes: number): TransitSegment => ({
  fromNodeId: uid(from),
  toNodeId: uid(to),
  mode,
  durationMinutes: minutes,
  distanceMeters: minutes * 80,
  fatigueScore: 0,
});
const day = (nodes: ItineraryNodeInput[], transitSegments: TransitSegment[] = []): DaySchedule =>
  DayScheduleSchema.parse({ dayIndex: 1, date: "2026-10-05", nodes, transitSegments, dailyFatigueScore: 0 });
const codes = (r: ReturnType<typeof auditPacing>) => r.findings.map((f) => `${f.code}:${f.severity}`);

test("pacing: a light day has no findings", () => {
  const r = auditPacing({ day: day([node(1, "10:00", 60), node(2, "11:10", 60)], [leg(1, 2, "WALK", 10)]), vibe: { pacing: 0.5 } });
  assert.deepEqual(r.findings, []);
  assert.equal(r.longestActiveStretchMinutes, 130);
});

test("pacing: daily fatigue limits loosen as the Pacing fader rises", () => {
  // 150 walking minutes → weighted 187.5 → score 100.
  const heavy = day([node(1, "08:00", 30), node(2, "11:00", 30)], [leg(1, 2, "WALK", 150)]);
  assert.deepEqual(codes(auditPacing({ day: heavy, vibe: { pacing: 0 } })).filter((c) => c.startsWith("DAILY")), ["DAILY_FATIGUE:ALERT"]);
  // 80 cab minutes → weighted 56 → score 31: fine at any pace.
  const cab = day([node(1, "08:00", 30), node(2, "10:00", 30)], [leg(1, 2, "CAB", 80)]);
  assert.deepEqual(auditPacing({ day: cab, vibe: { pacing: 0 } }).findings.filter((f) => f.code === "DAILY_FATIGUE"), []);
  // 100 walking minutes → score 69: warns a slow traveller, not a fast one.
  const mid = day([node(1, "08:00", 30), node(2, "10:30", 30)], [leg(1, 2, "WALK", 100)]);
  assert.ok(codes(auditPacing({ day: mid, vibe: { pacing: 0 } })).includes("DAILY_FATIGUE:WARN"));
  assert.ok(!codes(auditPacing({ day: mid, vibe: { pacing: 1 } })).some((c) => c.startsWith("DAILY")));
});

test("pacing: long stretches without a break suggest a rest buffer once per stretch", () => {
  // Slow pace allows 150 min: 60 + 5 + 60 + 5 + 60 = 190 → flagged at stop 3.
  const d = day([node(1, "09:00", 60), node(2, "10:05", 60), node(3, "11:10", 60), node(4, "12:15", 60)], [leg(1, 2, "WALK", 5), leg(2, 3, "WALK", 5), leg(3, 4, "WALK", 5)]);
  const r = auditPacing({ day: d, vibe: { pacing: 0 } });
  const rest = r.findings.filter((f) => f.code === "NO_REST");
  assert.equal(rest.length, 1);
  assert.equal(rest[0].nodeId, uid(3));
  assert.deepEqual(r.restBreaks, [{ afterNodeId: uid(2), minutes: 20 }]);
  // A fast traveller (300 min) is fine with the same day.
  assert.deepEqual(auditPacing({ day: d, vibe: { pacing: 1 } }).restBreaks, []);
});

test("pacing: a meal or an idle gap resets the stretch; cab rides don't add to it", () => {
  const withLunch = day(
    [node(1, "09:00", 90), node(2, "10:35", 45, { category: "DINING" }), node(3, "11:25", 90)],
    [leg(1, 2, "WALK", 5), leg(2, 3, "WALK", 5)],
  );
  assert.deepEqual(auditPacing({ day: withLunch, vibe: { pacing: 0 } }).restBreaks, []);
  const withGap = day([node(1, "09:00", 90), node(2, "11:00", 90)], [leg(1, 2, "WALK", 5)]);
  assert.equal(auditPacing({ day: withGap, vibe: { pacing: 0 } }).longestActiveStretchMinutes, 95);
  const byCab = day([node(1, "09:00", 70), node(2, "10:20", 70)], [leg(1, 2, "CAB", 10)]);
  assert.equal(auditPacing({ day: byCab, vibe: { pacing: 0 } }).longestActiveStretchMinutes, 140);
});

test("pacing: too many sights for the fader", () => {
  const nodes = [1, 2, 3, 4, 5].map((n) => node(n, `${String(8 + 2 * n).padStart(2, "0")}:00`, 30));
  // Pacing 0 → 2 stops/day; 5 sights > 2 + 1.
  assert.ok(codes(auditPacing({ day: day(nodes), vibe: { pacing: 0 } })).includes("TOO_MANY_STOPS:WARN"));
  assert.ok(!codes(auditPacing({ day: day(nodes), vibe: { pacing: 1 } })).includes("TOO_MANY_STOPS:WARN"));
  // Without a vibe there's no target to compare against.
  assert.ok(!codes(auditPacing({ day: day(nodes) })).includes("TOO_MANY_STOPS:WARN"));
});

test("pacing: NWS heat bands apply to outdoor stops only, using overlapped hours", () => {
  assert.ok(Math.abs(HEAT_EXTREME_CAUTION_C - 32.2) < 0.1);
  assert.ok(Math.abs(HEAT_DANGER_C - 39.4) < 0.1);
  const d = day([
    node(1, "11:30", 60, { isOutdoor: true, title: "Fort walk" }),
    node(2, "13:00", 60, { isOutdoor: false, title: "Museum" }),
    node(3, "16:00", 30, { isOutdoor: true, title: "Garden" }),
  ]);
  const weather = [
    { hour: 11, apparentTemperatureC: 31 },
    { hour: 12, apparentTemperatureC: 40.2 },
    { hour: 13, apparentTemperatureC: 42 },
    { hour: 16, apparentTemperatureC: 33 },
  ];
  const heat = auditPacing({ day: d, weather }).findings.filter((f) => f.code === "HEAT");
  assert.deepEqual(heat.map((f) => [f.nodeId, f.severity]), [
    [uid(1), "ALERT"],
    [uid(3), "WARN"],
  ]);
  assert.match(heat[0].message, /Feels like 40.2°C during Fort walk \(NWS "danger" band\)/);
});

test("pacing: WHO UV categories, and missing weather hours are skipped, not guessed", () => {
  const d = day([node(1, "12:00", 60, { isOutdoor: true }), node(2, "15:00", 60, { isOutdoor: true }), node(3, "17:00", 60, { isOutdoor: true })]);
  const weather = [
    { hour: 12, uvIndex: 11.4 },
    { hour: 15, uvIndex: 7 },
    { hour: 17, uvIndex: null },
  ];
  const uv = auditPacing({ day: d, weather }).findings.filter((f) => f.code === "UV");
  assert.deepEqual(uv.map((f) => [f.nodeId, f.severity]), [
    [uid(1), "ALERT"],
    [uid(2), "INFO"],
  ]);
  assert.throws(() => auditPacing({ day: d, weather: [{ hour: 24, uvIndex: 3 }] }), RangeError);
});

test("pacing: CDC altitude thresholds and steep walking legs", () => {
  const d = day([node(1, "09:00", 60), node(2, "10:10", 60), node(3, "11:20", 60)], [leg(1, 2, "WALK", 10), leg(2, 3, "CAB", 10)]);
  const climb = auditPacing({ day: d, elevationsM: { [uid(1)]: 1600, [uid(2)]: 1750, [uid(3)]: 3000 } });
  assert.deepEqual(codes(climb), ["ALTITUDE:ALERT", "STEEP_WALK:INFO"]);
  assert.equal(climb.findings[0].nodeId, uid(3));

  const high = auditPacing({ day: d, elevationsM: { [uid(1)]: 2600, [uid(2)]: 2650, [uid(3)]: 2700 } });
  assert.deepEqual(codes(high), ["ALTITUDE:WARN"]);
  assert.deepEqual(auditPacing({ day: d, elevationsM: { [uid(1)]: 400, [uid(2)]: Number.NaN } }).findings, []);
});

test("pacing: unsorted input is ordered by start time and never mutated", () => {
  const d = day([node(2, "11:10", 60), node(1, "10:00", 60)], [leg(1, 2, "WALK", 10)]);
  const before = JSON.stringify(d);
  const r = auditPacing({ day: d, vibe: { pacing: 0.5 } });
  assert.equal(r.longestActiveStretchMinutes, 130);
  assert.equal(JSON.stringify(d), before);
});
