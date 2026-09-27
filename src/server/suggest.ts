/**
 * "Where should I go?" — destination suggestions when the traveller hasn't
 * named a place (or wrote something like "anywhere to chill").
 *
 *  1. Ideas: the LLM proposes destination *names* with a one-line reason, from
 *     the brief, faders and travel month. Without an LLM, Wikivoyage's own
 *     search on the traveller's words supplies the names instead.
 *  2. Every idea is verified: it must resolve to a real place/region/country
 *     (destinations.ts). Unresolvable ideas are dropped, never shown.
 *  3. Facts on each card are data, not model text: what it is (Wikidata),
 *     its recommended towns (Wikivoyage), and last year's weather on the same
 *     dates (Open-Meteo archive).
 */
import { z } from "zod";
import type { VibeConfig } from "@/lib/musafir/schemas.ts";
import { resolveDestination } from "./destinations.ts";
import { llmJson } from "./llm.ts";
import { fetchJson, USER_AGENT } from "./osm.ts";

const MAX_IDEAS = 9;
const MAX_CARDS = 6;
const IdeasSchema = z.object({
  ideas: z
    .array(
      z.object({
        name: z.string().trim().min(2).max(80),
        why: z.string().trim().min(3).max(160),
      }),
    )
    .max(MAX_IDEAS),
});

export interface SuggestionCard {
  name: string;
  scale: string;
  description?: string;
  towns: string[];
  why?: string;
  /** Same dates last year at the destination (Open-Meteo archive). */
  weather?: {
    avgHighC: number;
    rainyDays: number;
    days: number;
    basis: string;
  };
  lat?: number;
  lng?: number;
}

export interface SuggestInput {
  text?: string;
  vibe: VibeConfig;
  startDate: string;
  endDate: string;
  /** Destinations to leave out (e.g. ones already shown). */
  exclude?: string[];
}

async function ideasFromLlm(
  input: SuggestInput,
): Promise<{ ideas: { name: string; why?: string }[]; via: string } | null> {
  const month = new Date(`${input.startDate}T00:00:00Z`).toLocaleString("en", {
    month: "long",
    timeZone: "UTC",
  });
  const days =
    Math.round(
      (Date.parse(input.endDate) - Date.parse(input.startDate)) / 86_400_000,
    ) + 1;
  const r = await llmJson({
    tier: "fast",
    timeoutMs: 8000,
    schema: IdeasSchema,
    system:
      'You suggest real travel destinations (a city, region or country) that suit a traveller. Reply as JSON {"ideas":[{"name","why"}]}. ' +
      "Names must be real places as written in English Wikipedia. 'why' is one short sentence tied to what they asked for and the season. " +
      "Offer variety (different countries and trip styles). Never invent prices or facts.",
    user: JSON.stringify({
      said: input.text || null,
      month,
      days,
      pace01: input.vibe.pacing,
      budget01: input.vibe.budget,
      localOverIconic01: input.vibe.culturalDepth,
      nightOwl01: input.vibe.circadian,
      interests: input.vibe.interests ?? [],
      keywords: input.vibe.keywords ?? [],
      avoid: input.vibe.avoid ?? [],
      party: input.vibe.party,
      exclude: input.exclude ?? [],
    }),
  });
  return r.ok ? { ideas: r.value.ideas, via: r.via } : null;
}

/** No-LLM path: Wikivoyage full-text search on the traveller's words (+ interests). */
async function ideasFromWikivoyage(
  input: SuggestInput,
): Promise<{ name: string }[]> {
  const words =
    [
      input.text ?? "",
      ...(input.vibe.interests ?? []),
      ...(input.vibe.keywords ?? []),
    ]
      .join(" ")
      .trim() || "travel destination";
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: words,
    srnamespace: "0",
    srlimit: String(MAX_IDEAS * 2),
    format: "json",
    formatversion: "2",
  });
  const body = (await fetchJson(
    `https://en.wikivoyage.org/w/api.php?${params}`,
    { headers: { "User-Agent": USER_AGENT } },
    10_000,
  )) as {
    query?: { search?: { title: string }[] };
  };
  // Skip itinerary/topic pages ("Rail travel in India", "Diving") — keep plain place names.
  return (body.query?.search ?? [])
    .map((s) => ({ name: s.title }))
    .filter(
      (s) =>
        !/\b(in|travel|guide|phrasebook|itinerary|tips)\b/i.test(s.name) &&
        !s.name.includes("/"),
    );
}

async function lastYearWeather(
  lat: number,
  lng: number,
  start: string,
  end: string,
): Promise<SuggestionCard["weather"]> {
  const shift = (d: string) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCFullYear(x.getUTCFullYear() - 1);
    return x.toISOString().slice(0, 10);
  };
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    start_date: shift(start),
    end_date: shift(end),
    daily: "temperature_2m_max,precipitation_sum",
    timezone: "auto",
  });
  const body = (await fetchJson(
    `https://archive-api.open-meteo.com/v1/archive?${params}`,
    {},
    10_000,
  )) as {
    daily?: {
      temperature_2m_max?: (number | null)[];
      precipitation_sum?: (number | null)[];
    };
  };
  const highs = (body.daily?.temperature_2m_max ?? []).filter(
    (v): v is number => typeof v === "number",
  );
  const rain = (body.daily?.precipitation_sum ?? []).filter(
    (v): v is number => typeof v === "number",
  );
  if (highs.length === 0) return undefined;
  return {
    avgHighC: Math.round(highs.reduce((a, b) => a + b, 0) / highs.length),
    rainyDays: rain.filter((mm) => mm >= 1).length,
    days: highs.length,
    basis: "same dates last year (Open-Meteo archive)",
  };
}

/** Runs `fn` over items with at most `limit` in flight (Wikidata's query service throttles bursts). */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (x: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

// Not cached as a whole (a partial answer shouldn't stick); each destination lookup is cached on its own.
export async function suggestDestinations(
  input: SuggestInput,
): Promise<{ cards: SuggestionCard[]; via: string }> {
  {
    const llm = await ideasFromLlm(input).catch(() => null);
    const ideas = llm?.ideas.length
      ? llm.ideas
      : await ideasFromWikivoyage(input).catch(() => []);
    const via = llm?.ideas.length
      ? `ideas by ${llm.via}, checked against Wikidata/Wikivoyage`
      : "Wikivoyage search (AI unavailable)";
    const excluded = new Set((input.exclude ?? []).map((e) => e.toLowerCase()));
    const verified = await mapLimited(
      ideas
        .filter((i) => !excluded.has(i.name.toLowerCase()))
        .slice(0, MAX_IDEAS),
      3,
      async (idea): Promise<SuggestionCard | null> => {
        const d = await resolveDestination(idea.name);
        if (!d || d.scale === "continent") return null;
        // Weather where visitors stay: an area's top recommended town, not its geographic centre
        // (Tenerife's centre is a 3,700 m volcano).
        const pos = d.cities[0]
          ? { lat: d.cities[0].lat, lng: d.cities[0].lng }
          : d.lat !== undefined && d.lng !== undefined
            ? { lat: d.lat, lng: d.lng }
            : undefined;
        const weather = pos
          ? await lastYearWeather(
              pos.lat,
              pos.lng,
              input.startDate,
              input.endDate,
            ).catch(() => undefined)
          : undefined;
        return {
          name: d.name,
          scale: d.scale,
          description: d.description,
          towns: d.cities.slice(0, 4).map((c) => c.name),
          why: "why" in idea ? (idea as { why?: string }).why : undefined,
          weather,
          ...pos,
        };
      },
    );
    const seen = new Set<string>();
    const cards = verified
      .flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []))
      .filter((c) => !seen.has(c.name) && seen.add(c.name))
      .slice(0, MAX_CARDS);
    return { cards, via };
  }
}
