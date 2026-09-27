/**
 * Real-world social signals for the Digital Twin: what people are posting
 * about the weather where the traveller is. Public, key-free sources only:
 *  - Mastodon hashtag timelines (#<city>, #<city>rain, #<city>weather, #<city>flood…)
 *  - Lemmy (fediverse forums) post search
 *  - GDELT DOC API (worldwide news, updated every 15 min; 1 request / 5 s)
 * Posts are read by the domain model (Nugen-aligned first, then Groq/Gemini;
 * keyword rules without any LLM) into hazards with a severity. Nothing is
 * synthesised: a source that is down or silent is reported as such.
 */
import { z } from "zod";
import { llmJson } from "./llm.ts";
import { fetchJson, USER_AGENT } from "./osm.ts";

export const HAZARDS = ["rain", "flood", "storm", "heat", "wind", "closure", "traffic", "none"] as const;
export type Hazard = (typeof HAZARDS)[number];

export interface Signal {
  source: "mastodon" | "lemmy" | "gdelt";
  url: string;
  at: string;
  excerpt: string;
  hazard: Hazard;
  severity: number; // 0..1
}

export interface SocialReport {
  city: string;
  signals: Signal[];
  /** 0..1 per hazard: recency-weighted evidence from relevant posts. */
  index: Partial<Record<Hazard, number>>;
  sources: { name: string; status: string; count: number }[];
  classifiedBy: string;
  fetchedAt: string;
}

const TTL_MS = 15 * 60_000;
const WINDOW_DAYS = 7;
// 20 short posts keep one classification call well under a free-tier per-minute token budget.
const MAX_POSTS = 20;
const g = globalThis as typeof globalThis & { __musafirSocial?: Map<string, { at: number; value: SocialReport }>; __musafirGdeltAt?: { t: number } };
const memo = (g.__musafirSocial ??= new Map());
const gdeltGate = (g.__musafirGdeltAt ??= { t: 0 });

const HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json" };
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
const recent = (iso: string) => Date.now() - Date.parse(iso) < WINDOW_DAYS * 86_400_000;

type Raw = Omit<Signal, "hazard" | "severity">;

async function mastodon(city: string): Promise<Raw[]> {
  const slug = city.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]/g, "");
  if (slug.length < 3) return [];
  const tags = [slug, `${slug}rain`, `${slug}rains`, `${slug}weather`, `${slug}flood`, `${slug}floods`, `${slug}heat`];
  const out: Raw[] = [];
  for (const tag of tags) {
    const posts = (await fetchJson(`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=20`, { headers: HEADERS }, 8000).catch(() => [])) as {
      url?: string;
      uri: string;
      created_at: string;
      content: string;
      language?: string | null;
    }[];
    for (const p of posts) {
      if (!recent(p.created_at) || (p.language && p.language !== "en")) continue;
      out.push({ source: "mastodon", url: p.url ?? p.uri, at: p.created_at, excerpt: stripHtml(p.content).slice(0, 220) });
    }
  }
  return out;
}

async function lemmy(city: string): Promise<Raw[]> {
  const out: Raw[] = [];
  for (const q of [`${city} rain`, `${city} flood`, `${city} weather`]) {
    const body = (await fetchJson(`https://lemmy.world/api/v3/search?${new URLSearchParams({ q, type_: "Posts", sort: "New", limit: "10" })}`, { headers: HEADERS }, 8000).catch(() => null)) as {
      posts?: { post: { name: string; body?: string; ap_id: string; published: string } }[];
    } | null;
    for (const p of body?.posts ?? []) {
      const text = `${p.post.name} ${p.post.body ?? ""}`;
      if (!recent(p.post.published) || !text.toLowerCase().includes(city.toLowerCase())) continue;
      out.push({ source: "lemmy", url: p.post.ap_id, at: p.post.published, excerpt: stripHtml(text).slice(0, 220) });
    }
  }
  return out;
}

async function gdelt(city: string): Promise<Raw[]> {
  const wait = gdeltGate.t + 5500 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  gdeltGate.t = Date.now();
  const query = `"${city}" (rain OR flood OR flooding OR storm OR heatwave OR cyclone OR waterlogging)`;
  const params = new URLSearchParams({ query, mode: "artlist", format: "json", maxrecords: "20", timespan: `${WINDOW_DAYS}d`, sort: "datedesc" });
  const body = (await fetchJson(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, { headers: HEADERS }, 15_000)) as {
    articles?: { url: string; title: string; seendate: string; language?: string }[];
  };
  return (body.articles ?? [])
    .filter((a) => !a.language || a.language === "English")
    .map((a) => {
      const s = a.seendate; // 20260927T101500Z
      const at = /^\d{8}T\d{6}Z$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : new Date().toISOString();
      return { source: "gdelt" as const, url: a.url, at, excerpt: a.title.slice(0, 220) };
    });
}

/** Keyword reading (no-LLM fallback). */
export function keywordHazard(text: string): { hazard: Hazard; severity: number } {
  const t = text.toLowerCase();
  const severe = /\b(red alert|evacuat\w*|record|extreme|severe|deadly|killed|stranded|submerged|cloudburst)\b/.test(t);
  const hazard: Hazard = /\b(flood\w*|waterlog\w*|inundat\w*|submerged)\b/.test(t)
    ? "flood"
    : /\b(cyclone|typhoon|hurricane|thunderstorm|storm)\b/.test(t)
      ? "storm"
      : /\b(heat ?wave|heatstroke|scorching|hottest|\d{2}\s?°c)\b/.test(t)
        ? "heat"
        : /\b(rain\w*|downpour|showers?|monsoon|drizzle)\b/.test(t)
          ? "rain"
          : /\b(gale|gusts?|high winds?)\b/.test(t)
            ? "wind"
            : /\b(closed|shut|cancell?ed|suspended)\b/.test(t)
              ? "closure"
              : /\b(traffic|jam|gridlock)\b/.test(t)
                ? "traffic"
                : "none";
  return { hazard, severity: hazard === "none" ? 0 : severe ? 0.85 : 0.45 };
}

const ClassifySchema = z.object({
  posts: z.array(z.object({ i: z.number().int().min(0), hazard: z.enum(HAZARDS), severity: z.number().min(0).max(1) })),
});

async function classify(raw: Raw[], city: string): Promise<{ signals: Signal[]; by: string }> {
  if (raw.length === 0) return { signals: [], by: "—" };
  const r = await llmJson({
    tier: "fast",
    domain: true,
    timeoutMs: 12_000,
    schema: ClassifySchema,
    system:
      `You read public posts and news about travel conditions in ${city}. For each post, decide the weather-related hazard it reports for travellers ` +
      `(${HAZARDS.join(", ")}; "none" if it isn't about current conditions there) and a severity 0..1 (0.2 minor, 0.5 disruptive, 0.9 dangerous). ` +
      'Reply as JSON {"posts":[{"i","hazard","severity"}]} covering every index.',
    user: JSON.stringify(raw.map((p, i) => ({ i, text: p.excerpt.slice(0, 160) }))),
  });
  if (r.ok) {
    const by = new Map(r.value.posts.map((p) => [p.i, p]));
    return {
      signals: raw.map((p, i) => {
        const c = by.get(i) ?? { hazard: keywordHazard(p.excerpt).hazard, severity: keywordHazard(p.excerpt).severity };
        return { ...p, hazard: c.hazard, severity: Math.round(c.severity * 100) / 100 };
      }),
      by: r.via,
    };
  }
  return { signals: raw.map((p) => ({ ...p, ...keywordHazard(p.excerpt) })), by: "keyword rules (AI unavailable)" };
}

export async function socialSignals(city: string): Promise<SocialReport> {
  const key = city.trim().toLowerCase();
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const sources: SocialReport["sources"] = [];
  const raw: Raw[] = [];
  for (const [name, fn] of [
    ["Mastodon", mastodon],
    ["Lemmy", lemmy],
    ["GDELT news", gdelt],
  ] as const) {
    try {
      const got = await fn(city);
      raw.push(...got);
      sources.push({ name, status: got.length ? "ok" : "no recent posts", count: got.length });
    } catch (e) {
      sources.push({ name, status: `unreachable (${(e as Error).message.slice(0, 60)})`, count: 0 });
    }
  }
  const unique = [...new Map(raw.map((p) => [p.url, p])).values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_POSTS);
  const { signals, by } = await classify(unique, city);
  // Evidence per hazard: severity × recency (half-life 2 days), squashed to 0..1.
  const index: SocialReport["index"] = {};
  for (const s of signals) {
    if (s.hazard === "none") continue;
    const ageDays = (Date.now() - Date.parse(s.at)) / 86_400_000;
    index[s.hazard] = (index[s.hazard] ?? 0) + s.severity * Math.pow(0.5, ageDays / 2);
  }
  for (const k of Object.keys(index) as Hazard[]) index[k] = Math.round((1 - Math.exp(-index[k]! / 2)) * 100) / 100;
  const value: SocialReport = { city, signals: signals.filter((s) => s.hazard !== "none"), index, sources, classifiedBy: by, fetchedAt: new Date().toISOString() };
  memo.set(key, { at: Date.now(), value });
  return value;
}
