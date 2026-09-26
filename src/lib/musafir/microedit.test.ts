import { test } from "node:test";
import assert from "node:assert/strict";
import { intentToPatches, matchStop, parseMicroEdit } from "./microedit.ts";
import { applyPatches } from "./reducer.ts";
import { DayScheduleSchema, type ItineraryNode } from "./schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const n = (i: number, title: string, start: string, category: ItineraryNode["category"] = "CULTURE", type: "HARD" | "SOFT" = "SOFT"): ItineraryNode => ({
  id: uid(i),
  type,
  title,
  category,
  location: { lat: 0, lng: 0, city: "X" },
  timeSlot: { start, durationMinutes: 60, bufferMinutes: 10 },
  isOutdoor: false,
  costEstimate: { amount: 0, currency: "USD" },
});
const nodes = [n(1, "Albert Hall", "09:00"), n(2, "Albert Hall Museum", "10:30"), n(3, "Ganesh Restaurant", "13:00", "DINING"), n(4, "Suvarna Mahal", "20:00", "DINING", "HARD")];
let seq = 100;
const id = () => uid(seq++);

test("grammar: shifts, earlier/later, hours, removal and resizing", () => {
  assert.deepEqual(parseMicroEdit("push Ganesh 30 min", nodes), { ok: true, intent: { op: "SHIFT", nodeId: uid(3), minutes: 30 } });
  assert.deepEqual(parseMicroEdit("Move stop 1 by 1 h earlier", nodes), { ok: true, intent: { op: "SHIFT", nodeId: uid(1), minutes: -60 } });
  assert.deepEqual(parseMicroEdit("pull lunch 15", nodes), { ok: true, intent: { op: "SHIFT", nodeId: uid(3), minutes: -15 } });
  assert.deepEqual(parseMicroEdit("skip #2", nodes), { ok: true, intent: { op: "REMOVE", nodeId: uid(2) } });
  assert.deepEqual(parseMicroEdit("extend albert hall museum by 20 mins", nodes), { ok: true, intent: { op: "RESIZE", nodeId: uid(2), minutes: 20 } });
});

test("grammar: ambiguity and unknowns are errors, never guesses", () => {
  const amb = parseMicroEdit("push albert 10 min", nodes);
  assert.equal(amb.ok, false);
  assert.match((amb as { reason: string }).reason, /matches Albert Hall, Albert Hall Museum/);
  assert.equal(parseMicroEdit("make it fun", nodes).ok, false);
  assert.equal(typeof matchStop("stop 9", nodes), "string");
});

test("patches: locked bookings refuse shifts; results pass applyPatches", () => {
  assert.match(intentToPatches({ op: "SHIFT", nodeId: uid(4), minutes: 30 }, nodes, 1, id) as string, /locked booking/);
  const day = DayScheduleSchema.parse({ dayIndex: 1, date: "2026-09-26", nodes, transitSegments: [], dailyFatigueScore: 0 });
  const p = intentToPatches({ op: "RESIZE", nodeId: uid(2), minutes: 20 }, nodes, 1, id);
  assert.ok(Array.isArray(p));
  assert.equal(applyPatches(day, p).nodes.find((x) => x.id === uid(2))?.timeSlot.durationMinutes, 80);
  assert.match(intentToPatches({ op: "RESIZE", nodeId: uid(2), minutes: -58 }, nodes, 1, id) as string, /shorter than 5/);
});
