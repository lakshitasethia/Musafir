import assert from "node:assert/strict";
import { test } from "node:test";
import { hazardLabel, readClassifyReply, severityValue } from "./hazards.ts";

test("the requested shape (Groq) passes through unchanged", () => {
  const reply = { posts: [{ i: 0, hazard: "rain", severity: 0.5 }, { i: 1, hazard: "none", severity: 0 }] };
  assert.deepEqual(readClassifyReply(reply), reply);
});

test("Nugen's index-keyed reply is read (seen live 2026-09-27)", () => {
  assert.deepEqual(readClassifyReply({ "0": { hazard: "heat", severity: 0.9 } }), { posts: [{ i: 0, hazard: "heat", severity: 0.9 }] });
  assert.deepEqual(readClassifyReply({ posts: { "2": { hazard: "flood", severity: 0.8 } } }), { posts: [{ i: 2, hazard: "flood", severity: 0.8 }] });
});

test("a single {hazard, severity} with words is read as post 0 (seen live: Flooding / Moderate)", () => {
  assert.deepEqual(readClassifyReply({ hazard: "Flooding", severity: "Moderate" }), { posts: [{ i: 0, hazard: "flood", severity: 0.5 }] });
});

test("a bare array uses positions when indices are missing", () => {
  assert.deepEqual(readClassifyReply([{ hazard: "Rainfall", severity: 3 }, { hazard: "none" }]), {
    posts: [
      { i: 0, hazard: "rain", severity: 0.3 },
      { i: 1, hazard: "none", severity: 0 },
    ],
  });
});

test("Nugen's badly nested multi-post reply is salvaged post by post (exact live reply, 2026-09-27)", () => {
  const text =
    '{"0":{"hazard":"rain","severity":0.2},{"1":{"hazard":"none","severity":0.2},{"2":{"hazard":"heat","severity":0.9},{"3":{"hazard":"none","severity":0.2},' +
    '{"4":{"hazard":"fog","severity":0.5},{"5":{"hazard":"storm","severity":0.9},{"6":{"hazard":"none","severity":0.2},{"7":{"hazard":"flood","severity":0.9}}}"';
  assert.throws(() => JSON.parse(text));
  assert.deepEqual(readClassifyReply(text), {
    posts: [
      { i: 0, hazard: "rain", severity: 0.2 },
      { i: 1, hazard: "none", severity: 0 },
      { i: 2, hazard: "heat", severity: 0.9 },
      { i: 3, hazard: "none", severity: 0 },
      // 4 ("fog") isn't a hazard label: left out, keywords read that post
      { i: 5, hazard: "storm", severity: 0.9 },
      { i: 6, hazard: "none", severity: 0 },
      { i: 7, hazard: "flood", severity: 0.9 },
    ],
  });
  assert.equal(readClassifyReply("I can't help with that."), null);
});

test("unreadable posts are left out (caller falls back to keywords); nothing readable → null", () => {
  assert.deepEqual(readClassifyReply({ posts: [{ i: 0, hazard: "volcano", severity: 0.9 }, { i: 1, hazard: "wind", severity: 0.4 }] }), {
    posts: [{ i: 1, hazard: "wind", severity: 0.4 }],
  });
  assert.equal(readClassifyReply({ "0": { hazard: "rain", severity: "whatever" } }), null);
  assert.equal(readClassifyReply("rain"), null);
  assert.equal(readClassifyReply(null), null);
});

test("labels and severities", () => {
  assert.equal(hazardLabel("Thunderstorm"), "storm");
  assert.equal(hazardLabel("heatwave"), "heat");
  assert.equal(hazardLabel("Road closed"), "closure");
  assert.equal(hazardLabel(3), null);
  assert.equal(severityValue(0.85), 0.85);
  assert.equal(severityValue(80), 0.8);
  assert.equal(severityValue("0.4"), 0.4);
  assert.equal(severityValue("Severe"), 0.9);
  assert.equal(severityValue(-1), null);
  assert.equal(severityValue(500), null);
});
