/**
 * Traveller reports in plain words (pure). "stuck in traffic, 20 min late",
 * "the museum is closed", "it's pouring" → a typed disruption for the engine.
 * Grammar first; the server asks an LLM only when this returns null.
 */
export interface ReportStop {
  index: number; // 1-based
  title: string;
  startMinute: number;
  endMinute: number;
  isOutdoor: boolean;
}

export type ParsedReport =
  | { kind: "DELAY"; stop: number; minutes: number }
  | { kind: "CLOSURE"; stop: number }
  | { kind: "WEATHER"; fromMinute: number; toMinute: number };

/** How long a reported downpour is assumed to last when the traveller doesn't say. */
export const REPORTED_RAIN_MINUTES = 120;
const WORD_NUMBERS: Record<string, number> = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, fortyfive: 45, sixty: 60, ninety: 90, half: 30, an: 60, a: 60 };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

/** Which stop the traveller means: "stop 2", "the 2nd", a name they typed, else the current/next one. */
export function whichStop(text: string, stops: readonly ReportStop[], nowMinute: number): number | null {
  if (stops.length === 0) return null;
  const t = norm(text);
  const num = /\b(?:stop|no|number|#)\s*(\d{1,2})\b/.exec(t) ?? /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (num) {
    const n = Number(num[1]);
    if (n >= 1 && n <= stops.length) return n;
  }
  // Longest title word overlap wins ("the fort" → "Amber Fort").
  let best: { n: number; score: number } | null = null;
  for (const s of stops) {
    const words = norm(s.title)
      .split(" ")
      .filter((w) => w.length >= 4);
    const score = words.filter((w) => t.includes(w)).reduce((a, w) => a + w.length, 0);
    if (score > 0 && (!best || score > best.score)) best = { n: s.index, score };
  }
  if (best) return best.n;
  const current = stops.find((s) => s.startMinute <= nowMinute && s.endMinute > nowMinute) ?? stops.find((s) => s.startMinute >= nowMinute);
  return current?.index ?? null;
}

function minutesIn(t: string): number | null {
  const m = /(\d{1,3})\s*(?:min|mins|minutes|m)\b/.exec(t) ?? /(\d)\s*(?:h|hr|hrs|hour|hours)\b/.exec(t);
  if (m) return /h/.test(m[0].replace(/\d+\s*/, "").slice(0, 1)) ? Number(m[1]) * 60 : Number(m[1]);
  const w = /\b(half an hour|an hour|a hour|five|ten|fifteen|twenty|thirty|forty five|forty|sixty|ninety)\b/.exec(t);
  if (!w) return null;
  if (w[1] === "half an hour") return 30;
  if (w[1] === "an hour" || w[1] === "a hour") return 60;
  return WORD_NUMBERS[w[1]] ?? null;
}

function untilMinute(t: string): number | null {
  const m = /\buntil\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(t);
  if (!m) return null;
  let h = Number(m[1]) % 24;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  return h * 60 + Number(m[2] ?? 0);
}

export function parseReport(text: string, stops: readonly ReportStop[], nowMinute: number): ParsedReport | null {
  const t = norm(text);
  if (t.length < 3 || stops.length === 0) return null;
  if (/\b(rain\w*|pour\w*|downpour|storm\w*|drizzl\w*|thunder\w*|flood\w*|waterlog\w*|monsoon|wet)\b/.test(t)) {
    const from = Math.max(0, Math.min(1439, nowMinute));
    const until = untilMinute(t);
    const to = until !== null && until > from ? until : Math.min(1440, from + (minutesIn(t) ?? REPORTED_RAIN_MINUTES));
    return { kind: "WEATHER", fromMinute: from, toMinute: to };
  }
  if (/\b(closed|shut|shutting|not open|isn t open|isnt open|locked|cancel\w*|no entry|under renovation)\b/.test(t)) {
    const stop = whichStop(t, stops, nowMinute);
    return stop ? { kind: "CLOSURE", stop } : null;
  }
  if (/\b(late|delay\w*|stuck|traffic|running behind|behind schedule|missed|slow|jam)\b/.test(t)) {
    const minutes = minutesIn(t);
    const stop = whichStop(t, stops, nowMinute);
    return stop && minutes ? { kind: "DELAY", stop, minutes: Math.min(600, minutes) } : null;
  }
  return null;
}
