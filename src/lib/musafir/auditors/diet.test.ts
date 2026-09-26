import { test } from "node:test";
import assert from "node:assert/strict";
import { auditDiet, dietKeyFor } from "./diet.ts";

test("diet: traveller wording maps to OSM keys; unknown needs map to null", () => {
  assert.equal(dietKeyFor("Pure Veg"), "vegetarian");
  assert.equal(dietKeyFor("gluten-free"), "gluten_free");
  assert.equal(dietKeyFor("Gluten_Free"), "gluten_free");
  assert.equal(dietKeyFor("  Coeliac "), "gluten_free");
  assert.equal(dietKeyFor("plant-based"), "vegan");
  assert.equal(dietKeyFor("Jain"), null);
  assert.equal(dietKeyFor("nut allergy"), null);
});

test("diet: yes/only verify, no conflicts, missing is unverified", () => {
  const r = auditDiet({ "diet:vegetarian": "only", "diet:halal": "no" }, ["vegetarian", "halal", "kosher"]);
  assert.deepEqual(
    r.checks.map((c) => [c.key, c.status, c.evidence]),
    [
      ["vegetarian", "VERIFIED", "diet:vegetarian=only"],
      ["halal", "CONFLICT", "diet:halal=no"],
      ["kosher", "UNVERIFIED", undefined],
    ],
  );
  assert.equal(r.verdict, "CONFLICT");
  assert.equal(r.label, "Listed as not halal");
});

test("diet: all requirements verified gives a VERIFIED verdict without claiming safety", () => {
  const r = auditDiet({ "diet:vegan": "yes", "diet:vegetarian": "yes" }, ["vegan", "veg"]);
  assert.equal(r.verdict, "VERIFIED");
  assert.equal(r.label, "Vegan, vegetarian listed");
  assert.doesNotMatch(`${r.label} ${r.disclaimer} ${r.checks.map((c) => c.detail).join(" ")}`, /\bsafe\b/i);
});

test("diet: only strict logical implications are inferred, and labelled", () => {
  const veganOnly = auditDiet({ "diet:vegan": "only" }, ["vegetarian", "dairy free"]);
  assert.deepEqual(veganOnly.checks.map((c) => [c.status, c.inferred, c.evidence]), [
    ["VERIFIED", true, "diet:vegan=only"],
    ["VERIFIED", true, "diet:vegan=only"],
  ]);
  assert.match(veganOnly.checks[0].detail, /inferred from diet:vegan=only/);

  const noVeg = auditDiet({ "diet:vegetarian": "no" }, ["vegan"]);
  assert.equal(noVeg.checks[0].status, "CONFLICT");
  assert.equal(noVeg.checks[0].inferred, true);

  // Vegetarian says nothing about vegan, and "no vegan" says nothing about vegetarian.
  assert.equal(auditDiet({ "diet:vegetarian": "only" }, ["vegan"]).checks[0].status, "UNVERIFIED");
  assert.equal(auditDiet({ "diet:vegan": "no" }, ["vegetarian"]).checks[0].status, "UNVERIFIED");
});

test("diet: a venue's own tag beats an inference", () => {
  const r = auditDiet({ "diet:vegan": "yes", "diet:dairy_free": "no" }, ["dairy free"]);
  assert.equal(r.checks[0].status, "CONFLICT");
  assert.equal(r.checks[0].inferred, undefined);
});

test("diet: non-standard values like 'limited' stay unverified", () => {
  const r = auditDiet({ "diet:vegetarian": "limited" }, ["vegetarian"]);
  assert.equal(r.checks[0].status, "UNVERIFIED");
  assert.equal(r.checks[0].evidence, "diet:vegetarian=limited");
  assert.match(r.checks[0].detail, /isn't a standard value/);
});

test("diet: cuisine=vegetarian counts as a vegetarian choice", () => {
  const r = auditDiet({ cuisine: "indian;vegetarian" }, ["vegetarian"]);
  assert.equal(r.checks[0].status, "VERIFIED");
  assert.equal(r.checks[0].evidence, "cuisine=vegetarian");
});

test("diet: needs OSM can't express are unverified, never guessed", () => {
  const r = auditDiet({ "diet:vegetarian": "only" }, ["Jain"]);
  assert.equal(r.verdict, "UNVERIFIED");
  assert.equal(r.checks[0].key, null);
  assert.match(r.checks[0].detail, /no tag for "Jain"/);
});

test("diet: allergy-like needs always get the confirm-with-venue disclaimer", () => {
  assert.match(auditDiet({ "diet:gluten_free": "yes" }, ["celiac"]).disclaimer, /allergies or intolerances/);
  assert.doesNotMatch(auditDiet({ "diet:vegetarian": "yes" }, ["vegetarian"]).disclaimer, /allergies/);
});

test("diet: blank and duplicate requirements are ignored; inputs aren't mutated", () => {
  const tags = Object.freeze({ "diet:vegetarian": "yes" });
  const reqs = Object.freeze(["Vegetarian", "vegetarian", "  ", ""]);
  const r = auditDiet(tags, reqs);
  assert.equal(r.checks.length, 1);
  assert.deepEqual(auditDiet(tags, []).verdict, "NO_REQUIREMENTS");
});
