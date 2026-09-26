import { test } from "node:test";
import assert from "node:assert/strict";
import { noClaimDietChecker, rankMealOptions, type DietChecker } from "./dining.ts";

const minutes = (a: { lat: number }, b: { lat: number }) => Math.round(Math.abs(a.lat - b.lat) * 1000);
const here = { lat: 0, lng: 0 };
const places = [
  { id: "far-veg", name: "Far Veg", lat: 0.02, lng: 0, diet: { "diet:vegetarian": "only" } },
  { id: "near", name: "Near", lat: 0.001, lng: 0 },
  { id: "meat", name: "Meat", lat: 0.002, lng: 0, diet: { "diet:vegetarian": "no" } },
];

test("default checker never claims dietary safety", () => {
  assert.equal(noClaimDietChecker({ "diet:vegan": "only" }, ["vegan"]), "unverified");
  assert.equal(noClaimDietChecker(undefined, []), "not-needed");
});

test("without restrictions, the nearest places win", () => {
  assert.deepEqual(rankMealOptions(here, undefined, places, [], minutes).map((o) => o.candidate.id), ["near", "meat", "far-veg"]);
});

test("with a real checker, verified beats unverified and conflicts are never offered", () => {
  const check: DietChecker = (tags) => (tags?.["diet:vegetarian"] === "only" || tags?.["diet:vegetarian"] === "yes" ? "verified" : tags?.["diet:vegetarian"] === "no" ? "conflicts" : "unverified");
  const r = rankMealOptions(here, undefined, places, ["vegetarian"], minutes, check);
  assert.deepEqual(r.map((o) => [o.candidate.id, o.diet]), [["far-veg", "verified"], ["near", "unverified"]]);
});
