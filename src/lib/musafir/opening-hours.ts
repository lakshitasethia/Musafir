/**
 * Conservative reader for OSM `opening_hours` (https://wiki.openstreetmap.org/wiki/Key:opening_hours).
 * Handles the common forms — "24/7", weekday ranges and lists, several time
 * ranges, "off"/"closed", and ranges past midnight ("Fr-Sa 18:00-02:00").
 * Anything it doesn't understand (public holidays, months, sunrise/sunset,
 * week numbers, comments…) makes the answer "unknown" — never "closed".
 *
 * Owned by Aryan as core scheduling logic; Parth's auditors may extend or
 * replace it (CLAUDE.md §10).
 */
export type OpenStatus = "open" | "closed" | "unknown";

const DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"] as const;
type Interval = [number, number]; // minutes from local midnight; end may exceed 1440
type Week = (Interval[] | null)[]; // index 0 = Monday; null = not stated

const time = (hhmm: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 24 || min > 59 ? null : h * 60 + min;
};

function parseDays(sel: string): number[] | null {
  const out = new Set<number>();
  for (const part of sel.split(",")) {
    const range = /^(Mo|Tu|We|Th|Fr|Sa|Su)(?:-(Mo|Tu|We|Th|Fr|Sa|Su))?$/.exec(part.trim());
    if (!range) return null;
    const a = DAYS.indexOf(range[1] as (typeof DAYS)[number]);
    const b = range[2] ? DAYS.indexOf(range[2] as (typeof DAYS)[number]) : a;
    for (let i = a; ; i = (i + 1) % 7) {
      out.add(i);
      if (i === b) break;
    }
  }
  return [...out];
}

function parseTimes(spec: string): Interval[] | null {
  const out: Interval[] = [];
  for (const part of spec.split(",")) {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})\+?$/.exec(part.trim());
    if (!m) return null;
    const start = time(m[1]);
    let end = time(m[2]);
    if (start === null || end === null) return null;
    if (end <= start) end += 1440; // past midnight
    out.push([start, end]);
  }
  return out;
}

/** Parses into a weekly table, or null when any rule uses syntax we don't support. */
export function parseOpeningHours(raw: string): Week | null {
  const text = raw.trim();
  if (!text) return null;
  if (text === "24/7") return Array.from({ length: 7 }, () => [[0, 1440]] as Interval[]);
  const week: Week = Array(7).fill(null);
  for (let rule of text.split(";")) {
    rule = rule.trim();
    if (!rule) continue;
    // Public-holiday selectors: drop "PH" from day lists; a rule only about PH is skipped.
    rule = rule.replace(/(^|,)PH(?=,|\s|$)/g, "$1").replace(/^,|,(?=\s)/g, "").trim();
    if (!rule) continue;
    const m = /^(?:([A-Za-z,\- ]+?)\s+)?(off|closed|\d.*)$/.exec(rule);
    if (!m) {
      // Bare day selector without times ("Mo-Su") is not meaningful on its own.
      return null;
    }
    const days = m[1] ? parseDays(m[1].replace(/\s+/g, "")) : [0, 1, 2, 3, 4, 5, 6];
    if (!days) return null;
    const off = m[2] === "off" || m[2] === "closed";
    const intervals = off ? [] : parseTimes(m[2]);
    if (!intervals) return null;
    for (const d of days) week[d] = intervals; // later rules override earlier ones for those days
  }
  return week;
}

/** Monday = 0 … Sunday = 6, for a "YYYY-MM-DD" calendar date. */
export function weekdayIndex(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/**
 * Is the place open for the whole visit [startMin, endMin) on `date` (destination-local)?
 * A visit that starts open but runs past closing counts as "closed" — the traveller would be asked to leave.
 */
export function openStatus(raw: string | undefined, date: string, startMin: number, endMin: number): OpenStatus {
  if (!raw) return "unknown";
  const week = parseOpeningHours(raw);
  if (!week) return "unknown";
  const d = weekdayIndex(date);
  const today = week[d];
  const yesterday = week[(d + 6) % 7];
  if (today === null && yesterday === null) return "unknown"; // this weekday isn't described
  const windows: Interval[] = [...(today ?? []), ...(yesterday ?? []).filter(([, e]) => e > 1440).map(([s, e]) => [s - 1440, e - 1440] as Interval)];
  if (windows.some(([s, e]) => startMin >= s && endMin <= e)) return "open";
  return today === null ? "unknown" : "closed";
}
