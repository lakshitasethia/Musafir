/**
 * Hazard labels for social-signal reading, and a tolerant reader for the
 * models' replies. The Nugen-aligned model answers in its own shapes
 * ({"0":{"hazard":"heat","severity":0.9}}, "Flooding", "Moderate") where Groq
 * follows the requested {"posts":[{"i","hazard","severity"}]}; both are read
 * here into the one shape. Anything that can't be read is left out, and the
 * caller falls back to keyword rules for that post.
 */
export const HAZARDS = ["rain", "flood", "storm", "heat", "wind", "closure", "traffic", "none"] as const;
export type Hazard = (typeof HAZARDS)[number];

export interface ClassifiedPost {
  i: number;
  hazard: Hazard;
  severity: number;
}

/** Synonyms and inflections models use for each label (matched on the start of the word). */
const HAZARD_WORDS: [RegExp, Hazard][] = [
  [/^(flood|waterlog|inundat|submerg)/, "flood"],
  [/^(storm|thunder|cyclone|typhoon|hurricane)/, "storm"],
  [/^(heat|hot|scorch)/, "heat"],
  [/^(rain|downpour|shower|monsoon|drizzle|precipitation)/, "rain"],
  [/^(wind|gust|gale)/, "wind"],
  [/^(closure|closed|shut|cancel|suspend)/, "closure"],
  [/^(traffic|jam|gridlock|congestion)/, "traffic"],
  [/^(none|no|n\/a|nothing|unrelated|irrelevant)$/, "none"],
];

/** Severity words, on the 0..1 scale the prompt asks for (0.2 minor, 0.5 disruptive, 0.9 dangerous). */
const SEVERITY_WORDS: [RegExp, number][] = [
  [/^(none|nil|no\b)/, 0],
  [/^(extreme|dangerous|critical|very high|severe)/, 0.9],
  [/^(high|major|heavy)/, 0.8],
  [/^(moderate|medium|disruptive)/, 0.5],
  [/^(minor|low|mild|light|slight)/, 0.2],
];

export function hazardLabel(value: unknown): Hazard | null {
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  if ((HAZARDS as readonly string[]).includes(t)) return t as Hazard;
  // Word by word ("Road closed", "heavy_rain"); a named hazard wins over "none"/"no".
  const words = t.split(/[\s_\-/,]+/).filter(Boolean);
  for (const [re, hazard] of HAZARD_WORDS) if (words.some((w) => re.test(w))) return hazard;
  return null;
}

/** 0..1; also reads 0..10 and 0..100 scales, numeric strings and severity words. */
export function severityValue(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  if (Number.isFinite(n)) {
    if (n < 0) return null;
    if (n <= 1) return n;
    if (n <= 10) return n / 10;
    if (n <= 100) return n / 100;
    return null;
  }
  if (typeof value !== "string") return null;
  const t = value.trim().toLowerCase();
  return SEVERITY_WORDS.find(([re]) => re.test(t))?.[1] ?? null;
}

function readPost(item: unknown, fallbackIndex: number): ClassifiedPost | null {
  if (!item || typeof item !== "object") return null;
  const o = item as Record<string, unknown>;
  const rawIndex = o.i ?? o.index ?? o.id;
  const i = rawIndex === undefined ? fallbackIndex : Number(rawIndex);
  if (!Number.isInteger(i) || i < 0) return null;
  const hazard = hazardLabel(o.hazard);
  if (!hazard) return null;
  const severity = hazard === "none" ? 0 : severityValue(o.severity);
  if (severity === null) return null;
  return { i, hazard, severity };
}

/**
 * Reads a classify reply in any of the shapes models use:
 * {"posts":[{i,…}]}, a bare array, {"0":{…},"1":{…}} keyed by index, or one {hazard, severity} for a single post.
 * Returns null when nothing in it is readable.
 */
export function readClassifyReply(reply: unknown): { posts: ClassifiedPost[] } | null {
  if (typeof reply === "string") return salvage(reply);
  if (!reply || typeof reply !== "object") return null;
  const o = reply as Record<string, unknown>;
  let entries: [unknown, number][];
  const list = Array.isArray(reply) ? reply : Array.isArray(o.posts) ? o.posts : null;
  if (list) entries = list.map((item, k) => [item, k]);
  else if ("hazard" in o) entries = [[o, 0]];
  else {
    const keyed = o.posts && typeof o.posts === "object" ? (o.posts as Record<string, unknown>) : o;
    entries = Object.entries(keyed)
      .filter(([k]) => /^\d+$/.test(k))
      .map(([k, v]) => [v && typeof v === "object" && !Array.isArray(v) ? { i: Number(k), ...(v as object) } : null, Number(k)]);
  }
  const posts = entries.map(([item, k]) => readPost(item, k)).filter((p): p is ClassifiedPost => p !== null);
  return posts.length ? { posts } : null;
}

/**
 * Reply text that isn't valid JSON as a whole — Nugen's longer replies nest braces wrongly
 * ({"0":{…},{"1":{…}}}}) — read post by post from each innermost {...}, keyed by a preceding "N": if any.
 */
function salvage(text: string): { posts: ClassifiedPost[] } | null {
  const posts: ClassifiedPost[] = [];
  let k = 0;
  for (const m of text.matchAll(/(?:"(\d+)"\s*:\s*)?(\{[^{}]*\})/g)) {
    let item: unknown;
    try {
      item = JSON.parse(m[2]!);
    } catch {
      continue;
    }
    const post = readPost(m[1] !== undefined && item && typeof item === "object" ? { i: Number(m[1]), ...item } : item, k++);
    if (post) posts.push(post);
  }
  return posts.length ? { posts } : null;
}
