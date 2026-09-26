import { test } from "node:test";
import assert from "node:assert/strict";
import { fromMinutes, toMinutes } from "./time.ts";
import { commuteBand, distanceMatrix, haversineMeters, legFatigueScore } from "./geo.ts";
import { ScheduleError, applyPatches, cascadeDelay, heal, policyFromVibe, type CascadeOptions } from "./reducer.ts";
import { z } from "zod";
import { newId } from "./ids.ts";
import type { DayScheduleInput, ItineraryNodeInput, TripPatch } from "./schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const JAIPUR = { lat: 26.9239, lng: 75.8267, city: "Jaipur" };

function node(n: number, type: "HARD" | "SOFT", start: string, duration: number, extra: Partial<ItineraryNodeInput> = {}): ItineraryNodeInput {
  return {
    id: uid(n),
    type,
    title: `Stop ${n}`,
    category: "CULTURE",
    location: JAIPUR,
    timeSlot: { start, durationMinutes: duration, bufferMinutes: 0 },
    costEstimate: { amount: 0 },
    ...extra,
  };
}
const day = (nodes: ItineraryNodeInput[]): DayScheduleInput => ({
  dayIndex: 1,
  date: "2026-10-01",
  nodes,
  transitSegments: [],
  dailyFatigueScore: 0,
});
let seq = 0;
const opts = (extra: CascadeOptions = {}): CascadeOptions => ({ transitMinutes: () => 0, idFactory: () => uid(9000 + seq++), ...extra });
const byNode = (patches: TripPatch[]) => new Map(patches.map((p) => [p.nodeId, p]));
const startOf = (d: ReturnType<typeof applyPatches>, n: number) => d.nodes.find((x) => x.id === uid(n))?.timeSlot.start;

// ── time ──────────────────────────────────────────────────────────
test("time: round-trips and rejects out-of-day values", () => {
  assert.equal(toMinutes("00:00"), 0);
  assert.equal(toMinutes("23:59"), 1439);
  assert.equal(fromMinutes(605), "10:05");
  assert.throws(() => toMinutes("24:00"), RangeError);
  assert.throws(() => toMinutes("9:00"), RangeError);
  assert.throws(() => fromMinutes(1440), RangeError);
  assert.throws(() => fromMinutes(-1), RangeError);
});

// ── geo ───────────────────────────────────────────────────────────
test("geo: haversine, bands and fatigue are deterministic", () => {
  const d = haversineMeters({ lat: 48.8566, lng: 2.3522 }, { lat: 51.5074, lng: -0.1278 });
  assert.ok(Math.abs(d - 343_500) < 1_500, `Paris–London ≈343.5km, got ${d}`);
  assert.equal(haversineMeters(JAIPUR, JAIPUR), 0);
  assert.equal(commuteBand(14), "HEALTHY");
  assert.equal(commuteBand(15), "MODERATE");
  assert.equal(commuteBand(35), "MODERATE");
  assert.equal(commuteBand(36), "SPIKE");
  assert.equal(legFatigueScore("WALK", 1000), 100);
  assert.equal(legFatigueScore("CAB", 0), 0);
});

test("geo: distanceMatrix falls back to haversine on network failure, bad body, timeout", async () => {
  const pts = [JAIPUR, { lat: 26.9855, lng: 75.8513 }];
  const failing = (async () => { throw new Error("offline"); }) as typeof fetch;
  assert.equal((await distanceMatrix(pts, { fetchImpl: failing })).source, "haversine");

  const badBody = (async () => new Response(JSON.stringify({ code: "Ok", durations: [[0, null], [1, 0]], distances: [[0, 1], [1, 0]] }))) as typeof fetch;
  assert.equal((await distanceMatrix(pts, { fetchImpl: badBody })).source, "haversine");

  const hanging = ((_: unknown, init?: RequestInit) =>
    new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as typeof fetch;
  assert.equal((await distanceMatrix(pts, { fetchImpl: hanging, timeoutMs: 20 })).source, "haversine");

  assert.equal((await distanceMatrix([JAIPUR])).source, "haversine");
});

test("geo: distanceMatrix uses OSRM distance and cab duration when valid", async () => {
  const pts = [JAIPUR, { lat: 26.9855, lng: 75.8513 }];
  const ok = (async () =>
    new Response(JSON.stringify({ code: "Ok", durations: [[0, 767.2], [770, 0]], distances: [[0, 9411.6], [9400, 0]] }))) as typeof fetch;
  const m = await distanceMatrix(pts, { fetchImpl: ok });
  assert.equal(m.source, "osrm");
  assert.equal(m.legs[0][1].mode, "CAB");
  assert.equal(m.legs[0][1].durationMinutes, Math.ceil(767.2 / 60 + 5));
  assert.equal(m.legs[0][0].mode, "WALK");
});

// ── reducer ───────────────────────────────────────────────────────
test("reducer: free gaps absorb a delay before anything else moves", () => {
  const r = cascadeDelay(day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "12:00", 60)]), { nodeId: uid(1), delayMinutes: 30, reason: "Metro delay" }, opts());
  assert.equal(r.patches.length, 1);
  assert.equal(r.patches[0].operation, "SHIFT_TIME");
  assert.equal(r.patches[0].shiftOffsetMinutes, 30);
  assert.equal(startOf(r.preview, 2), "12:00");
});

test("reducer: back-to-back SOFT nodes cascade", () => {
  const r = cascadeDelay(day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "11:00", 60)]), { nodeId: uid(1), delayMinutes: 30, reason: "x" }, opts());
  assert.deepEqual(r.preview.nodes.map((n) => n.timeSlot.start), ["10:30", "11:30"]);
  assert.deepEqual(r.conflicts, []);
});

test("reducer: SOFT buffer compresses before a HARD anchor, which never moves", () => {
  const soft = node(1, "SOFT", "10:00", 60, { timeSlot: { start: "10:00", durationMinutes: 60, bufferMinutes: 15 } });
  const r = cascadeDelay(day([soft, node(2, "HARD", "11:00", 90)]), { nodeId: uid(1), delayMinutes: 10, reason: "x" }, opts());
  const p = byNode(r.patches).get(uid(1));
  assert.equal(p?.operation, "REPLACE");
  assert.equal(p?.payload?.timeSlot.start, "10:10");
  assert.equal(p?.payload?.timeSlot.durationMinutes, 50);
  assert.equal(byNode(r.patches).has(uid(2)), false);
  assert.equal(startOf(r.preview, 2), "11:00");
});

test("reducer: with equal priority it skips the delayed stop so the rest of the plan stays put (min-cost)", () => {
  const r = cascadeDelay(
    day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "11:00", 60), node(3, "HARD", "12:00", 60)]),
    { nodeId: uid(1), delayMinutes: 30, reason: "x" },
    opts(),
  );
  const m = byNode(r.patches);
  assert.equal(m.get(uid(1))?.operation, "REMOVE");
  assert.equal(m.has(uid(2)), false);
  assert.deepEqual(r.conflicts.map((c) => c.code), ["SOFT_NODE_DROPPED"]);
  assert.equal(r.preview.nodes.length, 2);
  assert.equal(r.preview.transitSegments.length, 1);
});

test("reducer: a low-priority later stop is dropped instead of a high-priority delayed one", () => {
  const r = cascadeDelay(
    day([node(1, "SOFT", "10:00", 60, { metadata: { priority: 1 } }), node(2, "SOFT", "11:00", 60, { metadata: { priority: 0.1 } }), node(3, "HARD", "12:00", 60)]),
    { nodeId: uid(1), delayMinutes: 30, reason: "x" },
    opts(),
  );
  const m = byNode(r.patches);
  assert.equal(m.get(uid(2))?.operation, "REMOVE");
  assert.equal(m.get(uid(1))?.shiftOffsetMinutes, 30);
});

test("reducer: nodes after a satisfied HARD anchor are untouched", () => {
  const r = cascadeDelay(
    day([node(1, "SOFT", "10:00", 30), node(2, "HARD", "11:00", 60), node(3, "SOFT", "12:00", 60)]),
    { nodeId: uid(1), delayMinutes: 20, reason: "x" },
    opts(),
  );
  assert.deepEqual(r.patches.map((p) => p.nodeId), [uid(1)]);
});

test("reducer: lateness to a HARD anchor is measured from when the delayed traveller is free, even if the stop is skipped", () => {
  const transit = (a: { id: string }, b: { id: string }) => (a.id === uid(1) && b.id === uid(3) ? 60 : 10);
  const r = cascadeDelay(
    day([node(1, "HARD", "09:00", 60), node(2, "SOFT", "10:00", 30), node(3, "HARD", "10:40", 60)]),
    { nodeId: uid(2), delayMinutes: 60, reason: "x" },
    opts({ transitMinutes: transit }),
  );
  assert.equal(byNode(r.patches).get(uid(2))?.operation, "REMOVE");
  const c = r.conflicts.find((x) => x.code === "HARD_ANCHOR_UNREACHABLE");
  assert.equal(c?.nodeId, uid(3));
  assert.equal(c?.minutes, 30);
});

test("reducer: new adjacencies after a drop pay full transit, which can make a drop infeasible", () => {
  const transit = (a: { id: string }, b: { id: string }) => (a.id === uid(2) && b.id === uid(4) ? 60 : 0);
  const r = cascadeDelay(
    day([
      node(1, "HARD", "09:00", 60),
      node(2, "SOFT", "10:00", 30, { metadata: { priority: 1 } }),
      node(3, "SOFT", "10:30", 30, { metadata: { priority: 0 } }),
      node(4, "HARD", "11:00", 60),
    ]),
    { nodeId: uid(2), delayMinutes: 5, reason: "x" },
    opts({ transitMinutes: transit }),
  );
  const m = byNode(r.patches);
  assert.equal(m.get(uid(2))?.operation, "REMOVE"); // dropping 3 would leave 2→4 needing 60 min
  assert.equal(m.has(uid(3)), false);
  assert.equal(r.conflicts.some((c) => c.code === "HARD_ANCHOR_UNREACHABLE"), false);
});

test("reducer: segments above maxEnumerateItems fall back to greedy priority drops", () => {
  const nodes = Array.from({ length: 12 }, (_, i) =>
    node(i + 1, "SOFT", fromMinutes(480 + i * 30), 30, { metadata: { priority: i + 1 === 5 ? 0.1 : i + 1 === 9 ? 0.2 : 0.5 } }),
  );
  nodes.push(node(13, "HARD", "14:00", 60));
  const r = cascadeDelay(day(nodes), { nodeId: uid(1), delayMinutes: 45, reason: "x" }, opts({ policy: { maxEnumerateItems: 10 } }));
  const removed = r.patches.filter((p) => p.operation === "REMOVE").map((p) => p.nodeId);
  assert.deepEqual(removed, [uid(5), uid(9)]);
  assert.equal(r.conflicts.some((c) => c.code === "HARD_ANCHOR_UNREACHABLE"), false);
});

test("heal CLOSURE: removes a SOFT stop, reports a closed HARD booking without touching it", () => {
  const d = day([node(1, "SOFT", "10:00", 60), node(2, "HARD", "12:00", 60)]);
  const soft = heal(d, { kind: "CLOSURE", nodeId: uid(1), reason: "Closed today" }, opts());
  assert.deepEqual(soft.patches.map((p) => p.operation), ["REMOVE"]);
  const hard = heal(d, { kind: "CLOSURE", nodeId: uid(2), reason: "Closed today" }, opts());
  assert.deepEqual(hard.patches, []);
  assert.equal(hard.conflicts[0].code, "HARD_VENUE_CLOSED");
});

test("heal WEATHER: outdoor SOFT stops move after the rain and indoor stops slide ahead of them", () => {
  const d = day([
    node(1, "SOFT", "10:00", 60, { isOutdoor: true }),
    node(2, "SOFT", "11:00", 60),
    node(3, "HARD", "15:00", 60, { isOutdoor: true }),
  ]);
  const r = heal(d, { kind: "WEATHER", fromMinute: toMinutes("09:30"), toMinute: toMinutes("12:00"), reason: "Rain" }, opts());
  assert.equal(startOf(r.preview, 1), "12:00");
  assert.equal(startOf(r.preview, 2), "11:00");
  assert.deepEqual(r.affectedNodeIds, [uid(1)]);
  const locked = heal(d, { kind: "WEATHER", fromMinute: toMinutes("14:00"), toMinute: toMinutes("16:00"), reason: "Rain" }, opts());
  assert.equal(locked.conflicts[0].code, "WEATHER_EXPOSED_LOCKED");
  assert.deepEqual(locked.patches, []);
  assert.throws(() => heal(d, { kind: "WEATHER", fromMinute: 600, toMinute: 600, reason: "x" }), ScheduleError);
});

test("policyFromVibe: fast pacing makes drops costlier and compression cheaper", () => {
  const slow = policyFromVibe({ pacing: 0 });
  const fast = policyFromVibe({ pacing: 1 });
  assert.ok(fast.dropWeight > slow.dropWeight);
  assert.ok(fast.trimWeight < slow.trimWeight);
  assert.deepEqual(policyFromVibe({ pacing: 5 }), fast);
});

test("reducer: transit estimates never amplify a delay between originally adjacent nodes", () => {
  const r = cascadeDelay(day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "11:00", 60)]), { nodeId: uid(1), delayMinutes: 10, reason: "x" }, opts({ transitMinutes: () => 40 }));
  assert.equal(byNode(r.patches).get(uid(2))?.shiftOffsetMinutes, 10);
});

test("reducer: delay on a HARD node reports lateness and emits no patches", () => {
  const r = cascadeDelay(day([node(1, "HARD", "10:00", 60), node(2, "SOFT", "11:00", 60)]), { nodeId: uid(1), delayMinutes: 45, reason: "Strike" }, opts());
  assert.deepEqual(r.patches, []);
  assert.equal(r.conflicts[0].code, "HARD_ANCHOR_LATE");
  assert.equal(r.conflicts[0].minutes, 45);
});

test("reducer: a cascade crossing midnight drops what no longer fits", () => {
  const late = node(1, "SOFT", "23:00", 60, { timeSlot: { start: "23:00", durationMinutes: 60, bufferMinutes: 15 } });
  const r = cascadeDelay(day([late]), { nodeId: uid(1), delayMinutes: 30, reason: "x" }, opts());
  assert.equal(r.patches[0].operation, "REMOVE");
  assert.equal(r.conflicts[0].code, "PAST_END_OF_DAY");
  assert.equal(r.preview.nodes.length, 0);
});

test("reducer: buffer compression alone can save the last stop of the day", () => {
  const late = node(1, "SOFT", "22:30", 60, { timeSlot: { start: "22:30", durationMinutes: 60, bufferMinutes: 30 } });
  const r = cascadeDelay(day([late]), { nodeId: uid(1), delayMinutes: 45, reason: "x" }, opts());
  assert.equal(r.patches[0].payload?.timeSlot.start, "23:15");
  assert.equal(r.patches[0].payload?.timeSlot.durationMinutes, 45);
  assert.deepEqual(r.conflicts, []);
});

test("reducer: unsorted input gives the same result as sorted input", () => {
  const nodes = [node(1, "SOFT", "10:00", 60), node(2, "SOFT", "11:00", 60), node(3, "HARD", "13:00", 60)];
  const a = cascadeDelay(day(nodes), { nodeId: uid(1), delayMinutes: 45, reason: "x" }, opts({ idFactory: () => uid(1) }));
  const b = cascadeDelay(day([...nodes].reverse()), { nodeId: uid(1), delayMinutes: 45, reason: "x" }, opts({ idFactory: () => uid(1) }));
  assert.deepEqual(a.patches, b.patches);
  assert.deepEqual(a.preview, b.preview);
});

test("reducer: never mutates its input", () => {
  const input = day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "11:00", 60)]);
  const snapshot = structuredClone(input);
  cascadeDelay(input, { nodeId: uid(1), delayMinutes: 30, reason: "x" }, opts());
  assert.deepEqual(input, snapshot);
});

test("reducer: flags overlapping input, handles empty-change cases, rejects bad input", () => {
  const overlap = cascadeDelay(day([node(1, "SOFT", "10:00", 90), node(2, "HARD", "11:00", 60)]), { nodeId: uid(2), delayMinutes: 0, reason: "x" }, opts());
  assert.equal(overlap.conflicts[0].code, "INPUT_OVERLAP");
  assert.deepEqual(overlap.patches, []);

  const one = day([node(1, "SOFT", "10:00", 60)]);
  assert.throws(() => cascadeDelay(day([node(1, "SOFT", "10:00", 60), node(1, "SOFT", "12:00", 60)]), { nodeId: uid(1), delayMinutes: 5, reason: "x" }), ScheduleError);
  assert.throws(() => cascadeDelay(one, { nodeId: uid(7), delayMinutes: 5, reason: "x" }), ScheduleError);
  assert.throws(() => cascadeDelay(one, { nodeId: uid(1), delayMinutes: -5, reason: "x" }), ScheduleError);
  assert.throws(() => cascadeDelay(one, { nodeId: uid(1), delayMinutes: 1.5, reason: "x" }), ScheduleError);
  assert.throws(() => cascadeDelay(one, { nodeId: uid(1), delayMinutes: 5, reason: "x" }, { dayEndMinute: 2000 }), ScheduleError);
  assert.throws(() => cascadeDelay(day([node(1, "SOFT", "25:00", 60)]), { nodeId: uid(1), delayMinutes: 5, reason: "x" }));
});

test("applyPatches: is atomic and refuses to move HARD nodes", () => {
  const d = day([node(1, "HARD", "10:00", 60), node(2, "SOFT", "12:00", 60)]);
  const ok = { patchId: uid(50), targetDayIndex: 1, operation: "SHIFT_TIME", nodeId: uid(2), shiftOffsetMinutes: 15, reason: "x" };
  const bad = { ...ok, patchId: uid(51), nodeId: uid(1) };
  assert.throws(() => applyPatches(d, [ok, bad]), ScheduleError);
  assert.equal(startOf(applyPatches(d, [ok]), 2), "12:15");
  assert.throws(() => applyPatches(d, [{ ...ok, targetDayIndex: 2 }]), ScheduleError);
  assert.throws(() => applyPatches(d, [{ ...ok, shiftOffsetMinutes: 720 }]), ScheduleError);
});

test("applyPatches: rejects a REPLACE that unlocks, moves or resizes a HARD node", () => {
  const hard = node(1, "HARD", "10:00", 60);
  const d = day([hard]);
  const replace = (payload: ItineraryNodeInput) => ({ patchId: uid(60), targetDayIndex: 1, operation: "REPLACE", nodeId: uid(1), payload, reason: "llm" });
  assert.throws(() => applyPatches(d, [replace({ ...hard, type: "SOFT" })]), ScheduleError);
  assert.throws(() => applyPatches(d, [replace({ ...hard, timeSlot: { start: "10:00", durationMinutes: 30 } })]), ScheduleError);
  assert.equal(applyPatches(d, [replace({ ...hard, title: "Renamed" })]).nodes[0].title, "Renamed");
});

test("ids: fallback without crypto.randomUUID yields schema-valid v4 UUIDs", () => {
  const original = crypto.randomUUID;
  Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  try {
    const ids = Array.from({ length: 50 }, newId);
    for (const id of ids) assert.ok(z.uuid().safeParse(id).success, id);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
  }
});

test("transit segments prefer routed legs (OSRM) over estimates", () => {
  const d = day([node(1, "SOFT", "10:00", 60), node(2, "SOFT", "12:00", 60, { location: { lat: 26.95, lng: 75.85, city: "Jaipur" } })]);
  const plain = applyPatches(d, []);
  const routed = applyPatches(d, [], { routed: () => ({ mode: "CAB", durationMinutes: 42, distanceMeters: 9000 }) });
  assert.notEqual(plain.transitSegments[0].durationMinutes, 42);
  assert.equal(routed.transitSegments[0].durationMinutes, 42);
  assert.equal(routed.transitSegments[0].distanceMeters, 9000);
});
