import assert from "node:assert/strict";
import { test } from "node:test";
import { interestFit, keywordFit, matchesInterest, readBrief } from "./interests.ts";

test("interests match OSM kinds and names", () => {
  assert.ok(matchesInterest("history", { kind: "historic=fort", name: "Amber Fort" }));
  assert.ok(matchesInterest("spiritual", { kind: "tourism=attraction", name: "Birla Mandir" }));
  assert.ok(matchesInterest("nightlife", { kind: "amenity=bar", name: "Blue" }));
  assert.ok(!matchesInterest("beaches", { kind: "leisure=park", name: "Central Park" }));
});

test("interest fit: likes raise, avoids veto", () => {
  const fort = { kind: "historic=fort", name: "Nahargarh Fort" };
  assert.equal(interestFit(fort, [], []), 0);
  assert.ok(interestFit(fort, ["history", "food"], []) > 0);
  assert.equal(interestFit({ kind: "amenity=bar", name: "Bar X" }, ["history"], ["nightlife"]), -1);
});

test("brief reading: pace, budget, interests, avoid, party", () => {
  const r = readBrief("Relaxed trip with my wife, love history and street food, cheap eats, no nightlife please");
  assert.equal(r.vibe.pacing, 0.2);
  assert.equal(r.vibe.budget, 0.15);
  assert.ok(r.interests.includes("history"));
  assert.ok(r.interests.includes("street-food"));
  assert.ok(r.avoid.includes("nightlife"));
  assert.equal(r.party, "couple");
});

test("free-form keywords are matched, not a fixed list", () => {
  const r = readBrief("We love anime, jazz bars and tea ceremony, also history");
  assert.deepEqual(r.keywords, ["anime", "jazz bars", "tea ceremony"]);
  assert.ok(r.interests.includes("history"));
});

test("keyword fit matches names and OSM types, plural-tolerant", () => {
  assert.equal(keywordFit({ kind: "shop=anime", name: "Animate" }, ["anime"]), 1);
  assert.equal(keywordFit({ kind: "amenity=bar", name: "Jazz Club Blue" }, ["jazz"]), 1);
  assert.equal(keywordFit({ kind: "historic=temple", name: "Kōdai-ji Temple" }, ["temples"]), 1);
  assert.equal(keywordFit({ kind: "amenity=cafe", name: "Blue Bottle" }, ["anime"]), 0);
});

test("brief reading leaves unknowns alone", () => {
  const r = readBrief("somewhere nice");
  assert.deepEqual(r.vibe, {});
  assert.deepEqual(r.interests, []);
  assert.equal(r.party, undefined);
});

test("early risers are mornings even if nightlife is mentioned", () => {
  const r = readBrief("We are early risers, not into nightlife");
  assert.equal(r.vibe.circadian, 0.1);
  assert.ok(r.avoid.includes("nightlife"));
});
