import assert from "node:assert/strict";
import { test } from "node:test";
import { daysPerCity, planRoute, type CityOption } from "./route.ts";

const city = (id: string, lat: number, lng: number, popularity: number): CityOption => ({ id, name: id, lat, lng, popularity });
// Rough real positions (Japan).
const tokyo = city("Tokyo", 35.68, 139.69, 300);
const kyoto = city("Kyoto", 35.01, 135.77, 200);
const osaka = city("Osaka", 34.69, 135.5, 180);
const nara = city("Nara", 34.68, 135.8, 120);
const sapporo = city("Sapporo", 43.06, 141.35, 150); // ~830 km from Tokyo
const JAPAN = [kyoto, sapporo, nara, tokyo, osaka];
const days = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

test("days per city follows pacing", () => {
  assert.equal(daysPerCity(0), 3);
  assert.equal(daysPerCity(0.9), 2);
});

test("short trip stays in the most popular city", () => {
  const r = planRoute(JAPAN, days(2), { pacing: 0.5 });
  assert.equal(r.length, 1);
  assert.equal(r[0].city.id, "Tokyo");
  assert.deepEqual(r[0].dayIndexes, [1, 2]);
});

test("longer trip adds reachable cities, skips far ones, covers every day once", () => {
  const r = planRoute(JAPAN, days(7), { pacing: 0.2 }); // 3 days/city → 2 cities
  assert.deepEqual(r.map((s) => s.city.id), ["Tokyo", "Kyoto"]);
  assert.deepEqual(r.flatMap((s) => s.dayIndexes), days(7));
  assert.equal(r[0].dayIndexes.length, 4, "spare day goes to the more popular city");
  const fast = planRoute(JAPAN, days(8), { pacing: 0.9 }); // 2 days/city → 4 cities
  assert.ok(!fast.some((s) => s.city.id === "Sapporo"), "Sapporo is beyond the leg limit");
  assert.deepEqual(fast.flatMap((s) => s.dayIndexes), days(8));
});

test("route is ordered nearest-neighbour", () => {
  const r = planRoute(JAPAN, days(8), { pacing: 0.9 });
  const ids = r.map((s) => s.city.id);
  assert.equal(ids[0], "Tokyo");
  // After Tokyo the Kansai cities come together, never Tokyo → Osaka → Tokyo-ish zigzag.
  assert.deepEqual(new Set(ids.slice(1)), new Set(["Kyoto", "Osaka", "Nara"]));
});

test("a curated preference beats popularity", () => {
  const r = planRoute(JAPAN, days(3), { pacing: 0.2, preferredIds: ["Kyoto"] });
  assert.equal(r[0].city.id, "Kyoto");
});

test("edge cases: no cities, no days, cities without coordinates", () => {
  assert.deepEqual(planRoute([], days(3), { pacing: 0.5 }), []);
  assert.deepEqual(planRoute(JAPAN, [], { pacing: 0.5 }), []);
  assert.deepEqual(planRoute([city("X", NaN, 0, 1)], days(2), { pacing: 0.5 }), []);
});
