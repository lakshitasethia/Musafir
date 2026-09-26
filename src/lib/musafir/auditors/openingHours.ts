/**
 * OSM `opening_hours` for the common subset, never guessed.
 *
 * Spec: https://wiki.openstreetmap.org/wiki/Key:opening_hours/specification
 *
 * Supported:
 *  - `24/7`
 *  - weekday selectors `Mo`…`Su`, ranges (`Mo-Fr`, wrapping `Sa-Mo`) and lists (`Mo,We,Fr`);
 *    a rule without a weekday selector applies to every day
 *  - time spans `HH:MM-HH:MM`, several per rule (`09:00-12:00,14:00-18:00`), end `24:00`,
 *    and spans past midnight (`22:00-02:00` or `22:00-26:00`); per the spec the
 *    overnight part belongs to the day it starts on
 *  - `off` / `closed`, with or without times
 *  - `;` normal rules (a later rule replaces the hours of the days it names) and
 *    `,` additional rules (hours are added)
 *  - `PH` / `SH` (public / school holidays): holidays aren't known here, so those
 *    rules are skipped and every answer carries a caveat
 *
 * Anything else (months, weeks, nth weekdays, sunrise/sunset, open ends `10:00+`,
 * comments, `||` fallback rules, a bare weekday selector) makes the whole value
 * UNKNOWN. A partial parse could turn "closed in winter" into "open", so the
 * auditor refuses rather than guesses.
 */
import { MINUTES_PER_DAY, toMinutes } from "../time.ts";

export const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
/** Largest end time accepted in extended notation (`22:00-26:00`); the spec allows up to 48:00. */
const MAX_EXTENDED_MINUTE = 2 * MINUTES_PER_DAY;

export interface Interval {
  /** Minutes since the start of the day, inclusive. */
  from: number;
  /** Minutes since the start of the day, exclusive. Up to 1440 once resolved to a day. */
  to: number;
}

export type ParsedHours =
  | {
      ok: true;
      raw: string;
      /**
       * Hours owned by each weekday (0 = Monday). Intervals may run past 1440;
       * the overflow is open time early the next day. Use `intervalsOn`.
       */
      week: Interval[][];
      /** Rules for public/school holidays were present and skipped. */
      holidayRulesSkipped: boolean;
    }
  | { ok: false; raw: string; reason: string };

const DAY_TOKEN = /^(Mo|Tu|We|Th|Fr|Sa|Su)$/i;
const HOLIDAY_TOKEN = /^(PH|SH)$/i;
const SPAN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

const unknown = (raw: string, reason: string): ParsedHours => ({ ok: false, raw, reason });

function dayIndex(token: string): number {
  return WEEKDAYS.findIndex((d) => d.toLowerCase() === token.toLowerCase());
}

/** `Mo-Fr,Su` → [0,1,2,3,4,6]; null when the selector isn't in the supported subset. */
function parseDays(selector: string): { days: number[]; holiday: boolean } | null {
  const days = new Set<number>();
  let holiday = false;
  for (const part of selector.split(",")) {
    if (HOLIDAY_TOKEN.test(part)) {
      holiday = true;
      continue;
    }
    const range = part.split("-");
    if (range.length === 1 && DAY_TOKEN.test(range[0])) {
      days.add(dayIndex(range[0]));
    } else if (range.length === 2 && DAY_TOKEN.test(range[0]) && DAY_TOKEN.test(range[1])) {
      const a = dayIndex(range[0]);
      const b = dayIndex(range[1]);
      for (let i = a; ; i = (i + 1) % 7) {
        days.add(i);
        if (i === b) break;
      }
    } else {
      return null;
    }
  }
  return { days: [...days].sort((x, y) => x - y), holiday };
}

function parseSpans(text: string): Interval[] | null {
  const out: Interval[] = [];
  for (const part of text.split(",")) {
    const m = SPAN.exec(part);
    if (!m) return null;
    const [h1, m1, h2, m2] = m.slice(1).map(Number);
    if (m1 > 59 || m2 > 59 || h1 > 24) return null;
    const from = h1 * 60 + m1;
    let to = h2 * 60 + m2;
    if (from >= MINUTES_PER_DAY) return null; // a span can't start at 24:00
    if (to === from) return null; // "09:00-09:00" is ambiguous (24 h or a typo)
    if (to < from) to += MINUTES_PER_DAY; // 22:00-02:00 runs past midnight
    if (to > MAX_EXTENDED_MINUTE) return null;
    out.push({ from, to });
  }
  return out;
}

function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.from - b.from);
  const out: Interval[] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.from <= last.to) last.to = Math.max(last.to, iv.to);
    else out.push({ ...iv });
  }
  return out;
}

function subtract(intervals: Interval[], cut: Interval[]): Interval[] {
  let out = intervals;
  for (const c of cut) {
    out = out.flatMap((iv) => {
      if (c.to <= iv.from || c.from >= iv.to) return [iv];
      const pieces: Interval[] = [];
      if (c.from > iv.from) pieces.push({ from: iv.from, to: c.from });
      if (c.to < iv.to) pieces.push({ from: c.to, to: iv.to });
      return pieces;
    });
  }
  return out;
}

/** Splits `a; b, Sa c` into normal rules, each a list of [first, ...additional] rules. */
function splitRules(value: string): string[][] {
  return value
    .split(";")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((normal) => {
      // A comma is an additional-rule separator only when a new weekday selector
      // follows something that already had hours; otherwise it lists days or spans.
      const pieces = normal.split(",").map((p) => p.trim());
      const rules: string[] = [pieces[0]];
      for (const piece of pieces.slice(1)) {
        const prev = rules[rules.length - 1];
        const startsSelector = /^(Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)\b/i.test(piece) && /\s/.test(piece);
        const prevComplete = /\d:\d{2}|\b(off|closed)\b/i.test(prev);
        if (startsSelector && prevComplete) rules.push(piece);
        else rules[rules.length - 1] = `${prev},${piece}`;
      }
      return rules;
    });
}

export function parseOpeningHours(input: string | null | undefined): ParsedHours {
  const raw = (input ?? "").trim();
  if (!raw) return unknown(raw, "no opening hours given");
  // Normalise typographic dashes and whitespace around separators, which real data is full of.
  const value = raw
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s*,\s*/g, ",")
    .replace(/\s+/g, " ");

  if (value === "24/7") {
    return { ok: true, raw, week: WEEKDAYS.map(() => [{ from: 0, to: MINUTES_PER_DAY }]), holidayRulesSkipped: false };
  }
  if (value.includes("||")) return unknown(raw, "fallback rules (||) are not supported");
  if (value.includes('"')) return unknown(raw, "comments are not supported");

  const week: Interval[][] = WEEKDAYS.map(() => []);
  let holidayRulesSkipped = false;

  for (const group of splitRules(value)) {
    for (const [i, rule] of group.entries()) {
      const additional = i > 0;
      const tokens = rule.split(" ");
      let days = [0, 1, 2, 3, 4, 5, 6];
      let rest = tokens;
      if (/^[A-Za-z]/.test(tokens[0]) && !/^(off|closed|open)$/i.test(tokens[0])) {
        const parsed = parseDays(tokens[0]);
        if (!parsed) return unknown(raw, `unsupported selector "${tokens[0]}"`);
        days = parsed.days;
        if (parsed.holiday) holidayRulesSkipped = true;
        rest = tokens.slice(1);
      }
      if (rest.length === 0) return unknown(raw, `"${rule}" has no hours (incomplete data)`);

      let state: "open" | "closed" = "open";
      const last = rest[rest.length - 1].toLowerCase();
      if (last === "off" || last === "closed") {
        state = "closed";
        rest = rest.slice(0, -1);
      } else if (last === "open") {
        rest = rest.slice(0, -1);
      }
      if (rest.length > 1) return unknown(raw, `unsupported rule "${rule}"`);

      let spans: Interval[];
      if (rest.length === 0) {
        if (state === "open") return unknown(raw, `"${rule}" has no hours (incomplete data)`);
        spans = [{ from: 0, to: MAX_EXTENDED_MINUTE }]; // closed all day, including overnight spill
      } else if (rest[0] === "24/7") {
        spans = [{ from: 0, to: MINUTES_PER_DAY }]; // e.g. "24/7; PH off"
      } else {
        const parsed = parseSpans(rest[0]);
        if (!parsed) return unknown(raw, `unsupported times "${rest[0]}"`);
        spans = parsed;
      }

      for (const d of days) {
        if (state === "closed") week[d] = subtract(week[d], spans);
        else week[d] = merge(additional ? [...week[d], ...spans] : spans);
      }
      if (state === "closed" && rest.length === 0 && !additional) for (const d of days) week[d] = [];
    }
  }
  return { ok: true, raw, week, holidayRulesSkipped };
}

/** Effective open intervals on a weekday (0 = Monday), including the previous day's overnight spill. */
export function intervalsOn(parsed: Extract<ParsedHours, { ok: true }>, weekday: number): Interval[] {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new RangeError(`Invalid weekday ${weekday}`);
  const own = parsed.week[weekday].map((iv) => ({ from: iv.from, to: Math.min(iv.to, MINUTES_PER_DAY) }));
  const spill = parsed.week[(weekday + 6) % 7]
    .filter((iv) => iv.to > MINUTES_PER_DAY)
    .map((iv) => ({ from: Math.max(0, iv.from - MINUTES_PER_DAY), to: iv.to - MINUTES_PER_DAY }));
  return merge([...own, ...spill].filter((iv) => iv.to > iv.from));
}

/** Weekday of a calendar date, 0 = Monday. The date is a local calendar day, so no timezone applies. */
export function weekdayOf(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RangeError(`Invalid date "${date}", expected YYYY-MM-DD`);
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) throw new RangeError(`Invalid date "${date}"`);
  return (d.getUTCDay() + 6) % 7;
}

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export type VisitStatus = "OPEN" | "CLOSED" | "PARTIAL" | "UNKNOWN";

export interface VisitCheck {
  status: VisitStatus;
  /** One calm sentence explaining the status. */
  reason: string;
  /** That day's open hours as "HH:MM–HH:MM", when known. */
  openHours?: string[];
  /** Set when holiday rules were skipped: the answer may differ on a public holiday. */
  caveat?: string;
}

/**
 * Is the venue open for the whole visit? PARTIAL means it opens after the visit
 * starts or closes before it ends. Invalid input (bad date or time, duration < 1,
 * a visit running past midnight) throws instead of being wrapped.
 */
export function checkVisit(hours: string | null | undefined, date: string, start: string, durationMinutes: number): VisitCheck {
  const weekday = weekdayOf(date);
  const from = toMinutes(start);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1) throw new RangeError(`Invalid duration ${durationMinutes}`);
  const to = from + durationMinutes;
  if (to > MINUTES_PER_DAY) throw new RangeError(`Visit ${start} + ${durationMinutes} min runs past midnight`);

  const parsed = parseOpeningHours(hours);
  if (!parsed.ok) {
    return { status: "UNKNOWN", reason: parsed.raw ? `Listed hours "${parsed.raw}" can't be read reliably (${parsed.reason}).` : "No opening hours in open data." };
  }
  const open = intervalsOn(parsed, weekday);
  const openHours = open.map((iv) => `${hhmm(iv.from)}–${iv.to === MINUTES_PER_DAY ? "24:00" : hhmm(iv.to)}`);
  const caveat = parsed.holidayRulesSkipped ? "Hours may differ on public holidays." : undefined;
  const covered = open.reduce((sum, iv) => sum + Math.max(0, Math.min(iv.to, to) - Math.max(iv.from, from)), 0);
  const day = WEEKDAYS[weekday];

  if (covered === durationMinutes) return { status: "OPEN", reason: `Open for the whole visit (${day}: ${openHours.join(", ")}).`, openHours, caveat };
  if (covered === 0) {
    const reason = open.length === 0 ? `Listed as closed on ${day}.` : `Closed at that time (${day}: ${openHours.join(", ")}).`;
    return { status: "CLOSED", reason, openHours, caveat };
  }
  const opensLate = !open.some((iv) => iv.from <= from && iv.to > from);
  const reason = opensLate
    ? `Opens after the visit starts (${day}: ${openHours.join(", ")}).`
    : `Closes before the visit ends (${day}: ${openHours.join(", ")}).`;
  return { status: "PARTIAL", reason, openHours, caveat };
}
