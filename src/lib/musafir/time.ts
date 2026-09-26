/**
 * "HH:MM" <-> minutes-since-midnight. A day slot is always within [00:00, 23:59];
 * values outside that range are rejected rather than wrapped, because a wrapped
 * time would silently move a node onto the previous/next day.
 */
import { HHMM_REGEX } from "./schemas.ts";

export const MINUTES_PER_DAY = 24 * 60;

export function toMinutes(hhmm: string): number {
  if (!HHMM_REGEX.test(hhmm)) {
    throw new RangeError(`Invalid time "${hhmm}", expected HH:MM (00:00–23:59)`);
  }
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function isRepresentableMinute(minutes: number): boolean {
  return Number.isInteger(minutes) && minutes >= 0 && minutes < MINUTES_PER_DAY;
}

export function fromMinutes(minutes: number): string {
  if (!isRepresentableMinute(minutes)) {
    throw new RangeError(`Minute ${minutes} is outside a single day (0–${MINUTES_PER_DAY - 1})`);
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
