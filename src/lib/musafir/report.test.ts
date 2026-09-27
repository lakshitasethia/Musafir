import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReport, REPORTED_RAIN_MINUTES, type ReportStop } from "./report.ts";

const stops: ReportStop[] = [
  { index: 1, title: "Amber Fort", startMinute: 540, endMinute: 630, isOutdoor: true, category: "CULTURE", kind: "historic=fort" },
  { index: 2, title: "City Palace Museum", startMinute: 660, endMinute: 750, isOutdoor: false, category: "CULTURE", kind: "tourism=museum" },
  { index: 3, title: "Tapri Central", startMinute: 780, endMinute: 840, isOutdoor: false, category: "DINING", kind: "amenity=cafe" },
  { index: 4, title: "Nahargarh Park", startMinute: 900, endMinute: 990, isOutdoor: true, category: "NATURE", kind: "leisure=park" },
];

test("delay with minutes, stop from context (current/next)", () => {
  assert.deepEqual(parseReport("stuck in traffic, 20 min late", stops, 600), { kind: "DELAY", stop: 1, minutes: 20 });
  assert.deepEqual(parseReport("running half an hour behind schedule", stops, 640), { kind: "DELAY", stop: 2, minutes: 30 });
});

test("closure names the stop", () => {
  assert.deepEqual(parseReport("the palace museum is closed today", stops, 600), { kind: "CLOSURE", stop: 2 });
  assert.deepEqual(parseReport("stop 4 is shut", stops, 600), { kind: "CLOSURE", stop: 4 });
});

test("rain starts now, lasts as said or a default", () => {
  assert.deepEqual(parseReport("it's pouring here", stops, 600), { kind: "WEATHER", fromMinute: 600, toMinute: 600 + REPORTED_RAIN_MINUTES });
  assert.deepEqual(parseReport("heavy rain until 3pm", stops, 600), { kind: "WEATHER", fromMinute: 600, toMinute: 900 });
});

test("remove only the stop named — by type or by name", () => {
  assert.deepEqual(parseReport("I don't want the museum", stops, 600), { kind: "REMOVE", stop: 2 });
  assert.deepEqual(parseReport("skip Nahargarh please", stops, 600), { kind: "REMOVE", stop: 4 });
});

test("replace a stop, keeping what they asked for", () => {
  assert.deepEqual(parseReport("change the cafe", stops, 600), { kind: "REPLACE", stop: 3 });
  assert.deepEqual(parseReport("swap the museum for a park", stops, 600), { kind: "REPLACE", stop: 2, want: "park" });
  assert.deepEqual(parseReport("replace Amber Fort with something indoor", stops, 600), { kind: "REPLACE", stop: 1, want: "indoor" });
});

test("move one stop to a time or by minutes", () => {
  assert.deepEqual(parseReport("move the park to 4pm", stops, 600), { kind: "MOVE", stop: 4, toMinute: 960 });
  assert.deepEqual(parseReport("push the cafe 30 min later", stops, 600), { kind: "MOVE", stop: 3, byMinutes: 30 });
  assert.deepEqual(parseReport("move the fort 15 min earlier", stops, 600), { kind: "MOVE", stop: 1, byMinutes: -15 });
});

test("edits never guess a target", () => {
  assert.equal(parseReport("change something", stops, 600), null);
  const two = [...stops, { index: 5, title: "Albert Hall Museum", startMinute: 1000, endMinute: 1060, isOutdoor: false, category: "CULTURE", kind: "tourism=museum" }];
  assert.deepEqual(parseReport("I don't want the museum", two, 600), { kind: "AMBIGUOUS", candidates: [2, 5] });
});

test("unclear text returns null (the server may ask the AI)", () => {
  assert.equal(parseReport("hmm", stops, 600), null);
  assert.equal(parseReport("we are a bit tired", stops, 600), null);
  assert.equal(parseReport("running late", stops, 600), null, "no minutes given");
});
