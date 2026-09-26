import { test } from "node:test";
import assert from "node:assert/strict";
import { planDays, planShape, type PlaceCandidate } from "./planner.ts";
import { applyPatches } from "./reducer.ts";
import { DayScheduleSchema } from "./schemas.ts";
import { toMinutes } from "./time.ts";

const center = { lat: 26.9239, lng: 75.8267 };
let n = 0;
const idFactory = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const place = (i: number, dLat: number, dLng: number, category: PlaceCandidate["category"], kind: string, isOutdoor = false): PlaceCandidate => ({
  sourceId: `node/${i}`,
  name: `Place ${i}`,
  lat: center.lat + dLat,
  lng: center.lng + dLng,
  category,
  kind,
  isOutdoor,
  source: "test",
});
const vibe = { pacing: 0.5, budget: 0.5, culturalDepth: 0.5, circadian: 0.5 };
const candidates = [
  place(1, 0.001, 0.001, "CULTURE", "tourism=museum"),
  place(2, 0.002, 0.0, "CULTURE", "historic=fort", true),
  place(3, -0.001, 0.002, "CULTURE", "tourism=gallery"),
  place(4, 0.02, 0.02, "NATURE", "leisure=park", true),
  place(5, 0.021, 0.019, "CULTURE", "tourism=attraction", true),
  place(6, 0.019, 0.021, "LEISURE", "amenity=cinema"),
  place(7, 0.0015, 0.0012, "DINING", "amenity=restaurant"),
  place(8, 0.0205, 0.0201, "DINING", "amenity=fast_food"),
  place(9, 0.0012, 0.0008, "DINING", "amenity=cafe"),
  place(10, 0.0022, 0.0001, "CULTURE", "tourism=museum"),
];
const days = [
  { dayIndex: 1, date: "2026-10-01" },
  { dayIndex: 2, date: "2026-10-02" },
];

test("planShape: pacing and circadian drive stops and the day window", () => {
  assert.equal(planShape({ ...vibe, pacing: 0 }).stopsPerDay, 2);
  assert.equal(planShape({ ...vibe, pacing: 1 }).stopsPerDay, 6);
  assert.equal(planShape({ ...vibe, circadian: 0 }).dayStart, 8 * 60);
  assert.equal(planShape({ ...vibe, circadian: 1 }).dayEnd, 23 * 60);
});

test("planDays: produces valid, non-overlapping, schema-valid days that never reuse a place", () => {
  const out = planDays({ days, candidates, vibe, center, radiusMeters: 3000, city: "Jaipur", idFactory });
  const used = new Set<string>();
  for (const d of out) {
    const schedule = applyPatches(
      DayScheduleSchema.parse({ dayIndex: d.dayIndex, date: "2026-10-01", nodes: [], transitSegments: [], dailyFatigueScore: 0 }),
      d.nodes.map((payload) => ({ patchId: idFactory(), targetDayIndex: d.dayIndex, operation: "INSERT", payload, reason: "plan" })),
    );
    for (let i = 1; i < schedule.nodes.length; i++) {
      const prev = schedule.nodes[i - 1];
      assert.ok(toMinutes(prev.timeSlot.start) + prev.timeSlot.durationMinutes <= toMinutes(schedule.nodes[i].timeSlot.start));
    }
    for (const node of d.nodes) {
      assert.equal(node.type, "SOFT");
      const id = node.metadata!.sourceId as string;
      assert.ok(!used.has(id), `reused ${id}`);
      used.add(id);
    }
  }
  assert.ok(out[0].nodes.length > 0 && out[1].nodes.length > 0);
});

test("planDays: each day is a geographic cluster", () => {
  const out = planDays({ days, candidates, vibe: { ...vibe, pacing: 0.25 }, center, radiusMeters: 3000, city: "Jaipur", idFactory });
  const far = (lat: number) => lat > center.lat + 0.01;
  for (const d of out) {
    const sights = d.nodes.filter((x) => x.category !== "DINING");
    const flags = new Set(sights.map((x) => far(x.location.lat)));
    assert.equal(flags.size, 1, `day ${d.dayIndex} mixes neighbourhoods`);
  }
});

test("planDays: budget steers dining, and the curator order is respected", () => {
  const cheap = planDays({ days: [days[0]], candidates, vibe: { ...vibe, budget: 0, circadian: 0.2 }, center, radiusMeters: 3000, city: "J", idFactory });
  const dining = cheap[0].nodes.filter((x) => x.category === "DINING").map((x) => x.metadata!.kind);
  assert.ok(dining.length > 0);
  assert.ok(dining.every((k) => k !== "amenity=restaurant") || dining[0] !== "amenity=restaurant");
  // Curation picks among comparable nearby places (it can't override walkability).
  const plain = planDays({ days: [days[0]], candidates, vibe: { ...vibe, pacing: 0 }, center, radiusMeters: 3000, city: "J", idFactory });
  const notChosen = candidates.find((c) => c.category !== "DINING" && c.lat < center.lat + 0.01 && !plain[0].nodes.some((x) => x.metadata!.sourceId === c.sourceId))!;
  const curated = planDays({ days: [days[0]], candidates, vibe: { ...vibe, pacing: 0 }, center, radiusMeters: 3000, city: "J", idFactory, curatedOrder: [notChosen.sourceId] });
  assert.ok(curated[0].nodes.some((x) => x.metadata!.sourceId === notChosen.sourceId), "curated pick lands on day 1");
});

test("planDays: no candidates gives empty days with a note, not a crash", () => {
  const out = planDays({ days, candidates: [], vibe, center, radiusMeters: 3000, city: "J", idFactory });
  assert.deepEqual(out.map((d) => d.nodes.length), [0, 0]);
  assert.match(out[0].note ?? "", /No places/);
});

test("planDays: near-identical OSM duplicates collapse into one stop", () => {
  const dupes = [
    { ...place(20, 0.001, 0.001, "CULTURE", "tourism=attraction"), name: "Albert Hall" },
    { ...place(21, 0.0012, 0.001, "CULTURE", "tourism=museum"), name: "Albert Hall Museum" },
    { ...place(22, 0.03, 0.03, "CULTURE", "tourism=museum"), name: "Albert Hall Museum Annex Far" },
  ];
  const out = planDays({ days: [days[0]], candidates: dupes, vibe: { ...vibe, pacing: 1 }, center, radiusMeters: 6000, city: "J", idFactory });
  const titles = out[0].nodes.map((x) => x.title);
  assert.equal(titles.filter((x) => x.startsWith("Albert Hall") && !x.includes("Far")).length, 1);
  const spaced = planDays({
    days: [days[0]],
    candidates: [
      { ...place(30, 0.001, 0.001, "LEISURE", "amenity=cinema"), name: "raj mandir cinemas" },
      { ...place(31, 0.0011, 0.001, "LEISURE", "amenity=cinema"), name: "Rajmandir Cinemas" },
    ],
    vibe: { ...vibe, pacing: 1 },
    center,
    radiusMeters: 6000,
    city: "J",
    idFactory,
  });
  assert.equal(spaced[0].nodes.length, 1);
});
