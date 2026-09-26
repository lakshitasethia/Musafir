import { test } from "node:test";
import assert from "node:assert/strict";
import { affectedOutdoor, coveredByExisting, localClock, windowsInHorizon } from "./sentinel.ts";
import { DayScheduleSchema } from "./schemas.ts";

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const node = (n: number, start: string, minutes: number, isOutdoor: boolean) => ({
  id: uid(n),
  type: "SOFT" as const,
  title: `S${n}`,
  category: "NATURE" as const,
  location: { lat: 0, lng: 0, city: "X" },
  timeSlot: { start, durationMinutes: minutes, bufferMinutes: 0 },
  isOutdoor,
  costEstimate: { amount: 0 },
});

test("localClock uses the destination offset, not the server clock", () => {
  const t = Date.parse("2026-09-26T20:30:00Z");
  assert.deepEqual(localClock(t, 5.5 * 3600), { date: "2026-09-27", minute: 2 * 60 }); // IST crosses midnight
  assert.deepEqual(localClock(t, -4 * 3600), { date: "2026-09-26", minute: 16 * 60 + 30 });
});

test("windowsInHorizon clips to the next two hours", () => {
  const w = [
    { fromMinute: 600, toMinute: 720, peakProbability: 80 },
    { fromMinute: 900, toMinute: 960, peakProbability: 70 },
  ];
  assert.deepEqual(windowsInHorizon(w, 660), [{ fromMinute: 660, toMinute: 720, peakProbability: 80 }]);
  assert.deepEqual(windowsInHorizon(w, 1000), []);
});

test("affectedOutdoor only flags outdoor stops overlapping the window", () => {
  const day = DayScheduleSchema.parse({
    dayIndex: 1,
    date: "2026-09-26",
    nodes: [node(1, "10:00", 60, true), node(2, "11:00", 60, false), node(3, "12:30", 60, true)],
    transitSegments: [],
    dailyFatigueScore: 0,
  });
  assert.deepEqual(affectedOutdoor(day, { fromMinute: 630, toMinute: 700 }), [uid(1)]);
  assert.deepEqual(affectedOutdoor(day, { fromMinute: 660, toMinute: 740 }), []);
});

test("coveredByExisting prevents duplicate cards on repeated polls", () => {
  assert.equal(coveredByExisting({ fromMinute: 600, toMinute: 660 }, [{ fromMinute: 630, toMinute: 720 }]), true);
  assert.equal(coveredByExisting({ fromMinute: 600, toMinute: 660 }, [{ fromMinute: 660, toMinute: 720 }]), false);
});
