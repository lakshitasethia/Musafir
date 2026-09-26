import { test } from "node:test";
import assert from "node:assert/strict";
import { pickClusterReplacement } from "./cluster.ts";
import type { ItineraryNode } from "./schemas.ts";

const node = (id: string, lat: number, lng: number): ItineraryNode => ({
  id,
  type: "SOFT",
  title: id,
  category: "CULTURE",
  location: { lat, lng, city: "X" },
  timeSlot: { start: "10:00", durationMinutes: 60, bufferMinutes: 0 },
  isOutdoor: false,
  costEstimate: { amount: 0, currency: "USD" },
});
// Toy travel model: 1 minute per 0.001° of latitude difference.
const minutes = (a: { lat: number }, b: { lat: number }) => Math.round(Math.abs(a.lat - b.lat) * 1000);

const prev = node("prev", 0, 0);
const far = node("far", 0.06, 0); // 60-minute spike
const next = node("next", 0.005, 0);

test("picks the nearby candidate that shortens the day the most", () => {
  const c = [
    { id: "a", name: "A", lat: 0.004, lng: 0 },
    { id: "b", name: "B", lat: 0.002, lng: 0 },
  ];
  const r = pickClusterReplacement(prev, far, next, c, ["prev", "far", "next"], minutes);
  assert.equal(r?.candidate.id, "a"); // a: 4+1=5, b: 2+3=5 → tie broken by id
  assert.equal(r?.before, 60 + 55);
  assert.ok(r!.saving >= 10);
});

test("offers nothing when no candidate is genuinely shorter or it's already in the day", () => {
  assert.equal(pickClusterReplacement(prev, node("near", 0.004, 0), next, [{ id: "a", name: "A", lat: 0.003, lng: 0 }], [], minutes), null);
  assert.equal(pickClusterReplacement(prev, far, next, [{ id: "a", name: "Next", lat: 0.004, lng: 0 }], ["next"], minutes), null);
  assert.equal(pickClusterReplacement(prev, far, next, [{ id: "a", name: "A", lat: 0.05, lng: 0 }], [], minutes), null); // still a spike
});
