/**
 * Traveller says it in plain words (pure). Two families:
 *  - what went wrong: "20 min late", "the museum is closed", "it's pouring"
 *  - what they want changed, touching ONLY the stop they name:
 *      "I don't want the museum" → REMOVE that stop
 *      "change the cafe", "swap Albert Hall for a park" → REPLACE (real alternatives)
 *      "move the fort to 4pm", "push lunch 30 min" → MOVE that stop
 * Edits require an explicit target (name, number or type) — never a guess.
 * Grammar first; the server asks an LLM only when this returns null.
 */
export interface ReportStop {
  index: number; // 1-based
  title: string;
  startMinute: number;
  endMinute: number;
  isOutdoor: boolean;
  /** NodeCategory, e.g. "DINING", "CULTURE". */
  category?: string;
  /** OSM "key=value", e.g. "amenity=cafe". */
  kind?: string;
}

export type ParsedReport =
  | { kind: "DELAY"; stop: number; minutes: number }
  | { kind: "CLOSURE"; stop: number }
  | { kind: "WEATHER"; fromMinute: number; toMinute: number }
  | { kind: "REMOVE"; stop: number }
  | { kind: "REPLACE"; stop: number; want?: string }
  | { kind: "MOVE"; stop: number; toMinute?: number; byMinutes?: number };

/** A named target matched more than one stop: ask which. */
export interface Ambiguous {
  kind: "AMBIGUOUS";
  candidates: number[];
}

/** How long a reported downpour is assumed to last when the traveller doesn't say. */
export const REPORTED_RAIN_MINUTES = 120;
const WORD_NUMBERS: Record<string, number> = { five: 5, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, fortyfive: 45, sixty: 60, ninety: 90, half: 30, an: 60, a: 60 };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}: ]+/gu, " ").replace(/\s+/g, " ").trim();

/** Stop types people name ("the cafe") → how to recognise them on a stop. */
const TYPE_WORDS: { re: RegExp; test: (s: ReportStop) => boolean }[] = [
  { re: /\b(cafe|coffee|caf)\b/, test: (s) => /cafe|coffee/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(museum|gallery)\b/, test: (s) => /museum|gallery/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(temple|mandir|shrine|church|mosque)\b/, test: (s) => /temple|mandir|shrine|church|mosque|place_of_worship/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(fort|palace|castle|mahal)\b/, test: (s) => /fort|palace|castle|mahal/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(park|garden)\b/, test: (s) => /park|garden|bagh/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(zoo|aquarium)\b/, test: (s) => /zoo|aquarium/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(cinema|movie|theatre|theater)\b/, test: (s) => /cinema|theatre|theater/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(mall|market|bazaar|shop\w*)\b/, test: (s) => /mall|market|bazaar|shop/i.test(`${s.kind} ${s.title}`) },
  { re: /\b(restaurant|lunch|dinner|meal|food|eat\w*)\b/, test: (s) => s.category === "DINING" && !/cafe|coffee/i.test(`${s.kind} ${s.title}`) },
];

/** Stops the text explicitly names: "stop 3", "the 2nd", a title word, or a type word. Empty = none named. */
export function namedStops(text: string, stops: readonly ReportStop[]): number[] {
  const t = norm(text);
  const num = /\b(?:stop|no|number|#)\s*(\d{1,2})\b/.exec(t) ?? /\b(\d{1,2})(?:st|nd|rd|th)\b/.exec(t);
  if (num) {
    const n = Number(num[1]);
    if (n >= 1 && n <= stops.length) return [n];
  }
  // Title words (4+ letters): the stop sharing the most letters with the text wins.
  let best: { n: number; score: number }[] = [];
  for (const s of stops) {
    const score = norm(s.title)
      .split(" ")
      .filter((w) => w.length >= 4 && t.includes(w))
      .reduce((a, w) => a + w.length, 0);
    if (score === 0) continue;
    if (!best.length || score > best[0].score) best = [{ n: s.index, score }];
    else if (score === best[0].score) best.push({ n: s.index, score });
  }
  if (best.length) return best.map((b) => b.n);
  for (const tw of TYPE_WORDS) if (tw.re.test(t)) return stops.filter(tw.test).map((s) => s.index);
  return [];
}

/** Which stop a *disruption* is about: the named one, else the current/next (context is fine for "I'm late"). */
export function whichStop(text: string, stops: readonly ReportStop[], nowMinute: number): number | null {
  if (stops.length === 0) return null;
  const named = namedStops(text, stops);
  if (named.length >= 1) return named[0];
  const current = stops.find((s) => s.startMinute <= nowMinute && s.endMinute > nowMinute) ?? stops.find((s) => s.startMinute >= nowMinute);
  return current?.index ?? null;
}

function minutesIn(t: string): number | null {
  const hm = /(\d{1,3})\s*(min|mins|minutes|m|h|hr|hrs|hour|hours)\b/.exec(t);
  if (hm) return /^h/.test(hm[2]) ? Number(hm[1]) * 60 : Number(hm[1]);
  const w = /\b(half an hour|an hour|a hour|five|ten|fifteen|twenty|thirty|forty five|forty|sixty|ninety)\b/.exec(t);
  if (!w) return null;
  if (w[1] === "half an hour") return 30;
  if (w[1] === "an hour" || w[1] === "a hour") return 60;
  return WORD_NUMBERS[w[1]] ?? null;
}

function clockIn(t: string, after: RegExp): number | null {
  const m = new RegExp(`${after.source}\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\b`).exec(t);
  if (!m) return null;
  let h = Number(m[1]) % 24;
  if (m[3] === "pm" && h < 12) h += 12;
  if (m[3] === "am" && h === 12) h = 0;
  // "4" with no am/pm during travel hours means 16:00, not 04:00.
  if (!m[3] && h >= 1 && h <= 7) h += 12;
  return h * 60 + Number(m[2] ?? 0);
}

export function parseReport(text: string, stops: readonly ReportStop[], nowMinute: number): ParsedReport | Ambiguous | null {
  const t = norm(text);
  if (t.length < 3 || stops.length === 0) return null;
  const target = () => {
    const named = namedStops(t, stops);
    if (named.length === 0) return null;
    return named.length === 1 ? named[0] : ({ kind: "AMBIGUOUS", candidates: named } as Ambiguous);
  };

  // ── Edits (need an explicit target) ──
  if (/\b(swap|replace|change|switch|instead of|different|another|something else|other than)\b/.test(t)) {
    const stop = target();
    if (stop !== null) {
      if (typeof stop !== "number") return stop;
      // What they'd like instead: "... for a park", "... with something indoor", "a vegetarian place instead".
      const w = /\b(?:for|with|to)\s+(?:something|some|an|a)?\s*([a-z][a-z ]{1,40})$/.exec(t) ?? /\b(?:something|some|an|a)\s+([a-z][a-z ]{1,30})\s+instead\b/.exec(t);
      const want = w?.[1]
        .replace(/\b(please|instead|thanks?|nearby|near by|else|other)\b/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { kind: "REPLACE", stop, ...(want && want.length >= 3 ? { want } : {}) };
    }
  }
  if (/\b(don t want|dont want|do not want|not interested|skip|remove|drop|cancel|no need|get rid of|not into|delete)\b/.test(t)) {
    const stop = target();
    if (stop !== null) return typeof stop === "number" ? { kind: "REMOVE", stop } : stop;
  }
  if (/\b(move|shift|reschedule|push|pull|postpone|prepone|later|earlier)\b/.test(t) && !/\blate\b/.test(t)) {
    const stop = target();
    if (stop !== null) {
      if (typeof stop !== "number") return stop;
      const to = clockIn(t, /\b(?:to|at)/);
      if (to !== null) return { kind: "MOVE", stop, toMinute: to };
      const mins = minutesIn(t);
      if (mins) return { kind: "MOVE", stop, byMinutes: /\b(earlier|pull|prepone|forward)\b/.test(t) ? -mins : mins };
    }
  }

  // ── What went wrong ──
  if (/\b(rain\w*|pour\w*|downpour|storm\w*|drizzl\w*|thunder\w*|flood\w*|waterlog\w*|monsoon|wet)\b/.test(t)) {
    const from = Math.max(0, Math.min(1439, nowMinute));
    const until = clockIn(t, /\buntil/);
    const to = until !== null && until > from ? until : Math.min(1440, from + (minutesIn(t) ?? REPORTED_RAIN_MINUTES));
    return { kind: "WEATHER", fromMinute: from, toMinute: to };
  }
  if (/\b(closed|shut|shutting|not open|isn t open|isnt open|locked|under renovation|no entry)\b/.test(t)) {
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
