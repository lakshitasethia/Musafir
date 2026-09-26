import assert from "node:assert/strict";
import { test } from "node:test";
import { parseReport, REPORTED_RAIN_MINUTES, type ReportStop } from "./report.ts";

const stops: ReportStop[] = [
  { index: 1, title: "Amber Fort", startMinute: 540, endMinute: 630, isOutdoor: true },
  { index: 2, title: "City Palace Museum", startMinute: 660, endMinute: 750, isOutdoor: false },
  { index: 3, title: "Nahargarh Park", startMinute: 900, endMinute: 990, isOutdoor: true },
];

test("delay with minutes, stop from context (current/next)", () => {
  assert.deepEqual(parseReport("stuck in traffic, 20 min late", stops, 600), { kind: "DELAY", stop: 1, minutes: 20 });
  assert.deepEqual(parseReport("running half an hour behind schedule", stops, 640), { kind: "DELAY", stop: 2, minutes: 30 });
});

test("closure names the stop", () => {
  assert.deepEqual(parseReport("the palace museum is closed today", stops, 600), { kind: "CLOSURE", stop: 2 });
  assert.deepEqual(parseReport("stop 3 is shut", stops, 600), { kind: "CLOSURE", stop: 3 });
});

test("rain starts now, lasts as said or a default", () => {
  assert.deepEqual(parseReport("it's pouring here", stops, 600), { kind: "WEATHER", fromMinute: 600, toMinute: 600 + REPORTED_RAIN_MINUTES });
  assert.deepEqual(parseReport("heavy rain until 3pm", stops, 600), { kind: "WEATHER", fromMinute: 600, toMinute: 900 });
});

test("unclear text returns null (the server may ask the AI)", () => {
  assert.equal(parseReport("hmm", stops, 600), null);
  assert.equal(parseReport("we are a bit tired", stops, 600), null);
  assert.equal(parseReport("running late", stops, 600), null, "no minutes given");
});
