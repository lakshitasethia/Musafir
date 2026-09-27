import assert from "node:assert/strict";
import { test } from "node:test";
import { englishTitle, isReadableLatin, placeSearchNames } from "./names.ts";

test("readable Latin detection", () => {
  assert.ok(isReadableLatin("Hawa Mahal"));
  assert.ok(isReadableLatin("Café Ōsaka"));
  assert.ok(!isReadableLatin("カフェバルドー"));
  assert.ok(!isReadableLatin("हवा महल"));
  assert.ok(!isReadableLatin("123"));
});

test("English name wins; native kept for the taxi card", () => {
  assert.deepEqual(englishTitle({ name: "हवा महल", nameEn: "Hawa Mahal", kind: "historic=palace", category: "CULTURE" }), {
    title: "Hawa Mahal",
    native: "हवा महल",
    generic: false,
  });
});

test("Latin local name is used as-is", () => {
  assert.deepEqual(englishTitle({ name: "Trattoria da Mario", kind: "amenity=restaurant", category: "DINING" }), { title: "Trattoria da Mario", generic: false });
});

test("no readable name → say what it is, never transliterate", () => {
  assert.deepEqual(englishTitle({ name: "カフェバルドー", kind: "amenity=cafe", category: "DINING" }), { title: "Café", native: "カフェバルドー", generic: true });
  assert.equal(englishTitle({ name: "寺", kind: "tourism=attraction", category: "CULTURE" }).title, "Landmark");
});

test("place search tries the full name, then the bare name", () => {
  assert.deepEqual(placeSearchNames("Phuket, Thailand"), ["Phuket, Thailand", "Phuket"]);
  assert.deepEqual(placeSearchNames("Tenerife (Canary Islands)"), ["Tenerife (Canary Islands)", "Tenerife"]);
  assert.deepEqual(placeSearchNames("  Goa  "), ["Goa"]);
  assert.deepEqual(placeSearchNames("x"), []);
});
