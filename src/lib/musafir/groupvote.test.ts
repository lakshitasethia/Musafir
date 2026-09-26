import { test } from "node:test";
import assert from "node:assert/strict";
import { consensus } from "./groupvote.ts";

const opts = ["a", "b", "c"];

test("a single participant can never decide for a group", () => {
  assert.equal(consensus(opts, ["p1"], { p1: { a: "yes" } }).state, "OPEN");
});

test("unanimous yes wins; earliest-listed wins among several", () => {
  const r = consensus(opts, ["p1", "p2"], { p1: { b: "yes", c: "yes" }, p2: { c: "yes", b: "yes" } });
  assert.deepEqual(r, { state: "WIN", optionId: "b", tally: { a: 0, b: 2, c: 2 } });
});

test("a late joiner re-opens the vote until they agree", () => {
  const votes = { p1: { a: "yes" as const }, p2: { a: "yes" as const } };
  assert.equal(consensus(opts, ["p1", "p2", "p3"], votes).state, "OPEN");
  assert.equal(consensus(opts, ["p1", "p2", "p3"], { ...votes, p3: { a: "yes" } }).state, "WIN");
});

test("everyone voted, nothing unanimous → deadlock, never an automatic write", () => {
  const r = consensus(["a", "b"], ["p1", "p2"], { p1: { a: "yes", b: "no" }, p2: { a: "no", b: "yes" } });
  assert.equal(r.state, "DEADLOCK");
  assert.deepEqual(r.tally, { a: 1, b: 1 });
});
