/**
 * Sentinel decisions (pure, zero-LLM). Given the forecast for a trip's location,
 * decide whether rain in the traveller's next few hours actually touches an
 * outdoor stop, and whether a card for it already exists.
 *
 * All times are the destination's *local* clock (from the forecast's UTC offset),
 * never the server clock.
 */
import type { DaySchedule } from "./schemas.ts";
import { toMinutes } from "./time.ts";

export const SENTINEL_HORIZON_MIN = 120;

export interface RainWindow {
  fromMinute: number;
  toMinute: number;
  peakProbability: number;
}

/** Local calendar date and minute-of-day at a place with the given UTC offset. */
export function localClock(nowMs: number, utcOffsetSeconds: number): { date: string; minute: number } {
  const local = new Date(nowMs + utcOffsetSeconds * 1000);
  return { date: local.toISOString().slice(0, 10), minute: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

/** Rain windows clipped to [now, now + horizon). */
export function windowsInHorizon(windows: readonly RainWindow[], nowMinute: number, horizon = SENTINEL_HORIZON_MIN): RainWindow[] {
  const end = nowMinute + horizon;
  return windows
    .filter((w) => w.toMinute > nowMinute && w.fromMinute < end)
    .map((w) => ({ ...w, fromMinute: Math.max(w.fromMinute, nowMinute), toMinute: Math.min(w.toMinute, end) }));
}

/** Outdoor stops (SOFT or HARD) overlapping the window that haven't finished yet. */
export function affectedOutdoor(day: DaySchedule, w: Pick<RainWindow, "fromMinute" | "toMinute">): string[] {
  return day.nodes
    .filter((n) => {
      if (!n.isOutdoor) return false;
      const s = toMinutes(n.timeSlot.start);
      return s < w.toMinute && s + n.timeSlot.durationMinutes > w.fromMinute;
    })
    .map((n) => n.id);
}

/** True if a card for an overlapping window already exists (idempotency across repeated polls). */
export function coveredByExisting(w: Pick<RainWindow, "fromMinute" | "toMinute">, existing: readonly { fromMinute: number; toMinute: number }[]): boolean {
  return existing.some((e) => e.fromMinute < w.toMinute && e.toMinute > w.fromMinute);
}
