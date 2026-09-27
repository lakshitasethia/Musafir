/**
 * Destination resolver. Decides whether what the traveller typed is a place
 * (city/town), a region (state, province, island group…), a country or a
 * continent — and for areas, which cities are worth visiting.
 *
 * Sources (all free, no key, reachable where OSM mirrors are blocked):
 *  - Wikidata search + SPARQL: the item, its class, coordinates and
 *    popularity (number of Wikipedia/Wikivoyage language editions).
 *  - Wikivoyage: the editor-curated "Cities" section of the area's article —
 *    the places travel writers actually recommend (usually ≤ 9).
 *  - Fallback when Wikivoyage has no list: the area's best-known cities from
 *    Wikidata, ranked by popularity.
 * Nothing is hardcoded; continents are refused with a clear message.
 */
import type { CityOption } from "@/lib/musafir/route.ts";
import { placeSearchNames } from "@/lib/musafir/names.ts";
import { cached, fetchJson, USER_AGENT } from "./osm.ts";

export type DestinationScale = "place" | "region" | "country" | "continent";

export interface ResolvedDestination {
  scale: DestinationScale;
  qid: string;
  name: string;
  description?: string;
  lat?: number;
  lng?: number;
  /** Candidate cities for region/country, most popular first. */
  cities: CityOption[];
  citySource?: "wikivoyage" | "wikidata";
}

const HEADERS = { "User-Agent": USER_AGENT, Accept: "application/json" };
const SPARQL_HEADERS = { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" };
/** Wikidata classes (P31/P279*) that decide the scale. */
const SETTLEMENT = "Q486972";
const COUNTRY = "Q6256";
const SOVEREIGN_STATE = "Q3624078";
const CONTINENT = "Q5107";
const ADMIN_AREA = "Q56061";
const GEO_REGION = "Q82794";
const ISLAND = "Q23442";
/** City-like classes for the Wikidata fallback (direct P31 only, keeps WDQS fast). */
const CITY_CLASSES = ["Q515", "Q1549591", "Q200250", "Q1637706", "Q5119", "Q3957", "Q15284", "Q1093829"];
const MAX_CITY_OPTIONS = 12;

type Binding = Record<string, { value: string } | undefined>;

async function sparql(query: string): Promise<Binding[]> {
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ format: "json", query })}`;
  const body = (await fetchJson(url, { headers: SPARQL_HEADERS }, 25_000)) as { results?: { bindings?: Binding[] } };
  return body.results?.bindings ?? [];
}

const point = (wkt?: string) => {
  const m = wkt ? /Point\(([-\d.eE]+) ([-\d.eE]+)\)/.exec(wkt) : null;
  return m ? { lat: Number(m[2]), lng: Number(m[1]) } : undefined;
};
const qidOf = (uri?: string) => uri?.split("/").pop() ?? "";
const truthy = (v?: { value: string }) => v?.value === "true" || v?.value === "1";

/** "Phuket, Thailand" → tries "Phuket, Thailand", then "Phuket" (see placeSearchNames). */
export async function resolveDestination(input: string): Promise<ResolvedDestination | null> {
  for (const q of placeSearchNames(input)) {
    const d = await resolveOne(q);
    if (d) return d;
  }
  return null;
}

async function resolveOne(q: string): Promise<ResolvedDestination | null> {
  return cached(`destination:v6:${q.toLowerCase()}`, async () => {
    const search = (await fetchJson(
      `https://www.wikidata.org/w/api.php?${new URLSearchParams({ action: "wbsearchentities", search: q, language: "en", uselang: "en", type: "item", limit: "6", format: "json" })}`,
      { headers: HEADERS },
      10_000,
    )) as { search?: { id: string; label?: string; description?: string }[] };
    const hits = search.search ?? [];
    if (hits.length === 0) {
      // "Lisbon, Portugal" / "Tulum, Mexico": Wikidata search wants the bare name.
      const bare = q.split(",")[0].trim();
      return bare !== q && bare.length >= 2 ? resolveDestination(bare) : null;
    }

    const rows = await sparql(`SELECT ?item ?loc ?sl ?wv ?isPlace ?isCountry ?isContinent ?isRegion WHERE {
  VALUES ?item { ${hits.map((h) => `wd:${h.id}`).join(" ")} }
  OPTIONAL { ?item wdt:P625 ?loc }
  OPTIONAL { ?item wikibase:sitelinks ?sl }
  OPTIONAL { ?wvp schema:about ?item ; schema:isPartOf <https://en.wikivoyage.org/> ; schema:name ?wv }
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:${SETTLEMENT} } AS ?isPlace)
  # direct membership only: Indian/US states sit under "country" via subclass chains
  BIND(EXISTS { ?item wdt:P31 wd:${SOVEREIGN_STATE} } || EXISTS { ?item wdt:P31 wd:${COUNTRY} } AS ?isCountry)
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:${CONTINENT} } AS ?isContinent)
  BIND(EXISTS { ?item wdt:P31/wdt:P279* wd:${ADMIN_AREA} } || EXISTS { ?item wdt:P31/wdt:P279* wd:${GEO_REGION} } || EXISTS { ?item wdt:P31/wdt:P279* wd:${ISLAND} } AS ?isRegion)
}`);
    const byId = new Map(rows.map((r) => [qidOf(r.item?.value), r]));
    // Among the geographic hits, the best known wins ("Kansai" is the Japanese region, not a village in Papua;
    // "Paris" is Paris, France). A region without one coordinate still counts if Wikivoyage covers it.
    const geographic = hits
      .map((hit, rank) => ({ hit, rank, r: byId.get(hit.id) }))
      .filter(({ r }) => {
        if (!r) return false;
        return !!point(r.loc?.value) || truthy(r.isContinent) || truthy(r.isCountry) || (truthy(r.isRegion) && !!r.wv?.value);
      })
      .sort((a, b) => Number(b.r!.sl?.value ?? 0) - Number(a.r!.sl?.value ?? 0) || a.rank - b.rank);
    for (const { hit, r: row } of geographic) {
      const r = row!;
      const pos = point(r.loc?.value);
      const isContinent = truthy(r.isContinent);
      const isPlace = truthy(r.isPlace);
      const isCountry = truthy(r.isCountry);
      const isRegion = truthy(r.isRegion);
      // A settlement wins even when it is also an admin area (Delhi, Singapore, Tokyo).
      const scale: DestinationScale = isContinent ? "continent" : isPlace ? "place" : isCountry ? "country" : isRegion ? "region" : "place";
      const base = { scale, qid: hit.id, name: hit.label ?? q, description: hit.description, ...pos };
      if (scale === "place" || scale === "continent") return { ...base, cities: [] };
      const fromVoyage = r.wv?.value ? await wikivoyageCities(r.wv.value).catch(() => []) : [];
      if (fromVoyage.length >= 2) return { ...base, cities: fromVoyage, citySource: "wikivoyage" as const };
      // Small or obscure areas: relax the fame bar before giving up on a city list.
      let fromData = await wikidataCities(hit.id, scale).catch(() => []);
      if (fromData.length < 2) fromData = await wikidataCities(hit.id, scale, 3).catch(() => fromData);
      return { ...base, cities: fromData, citySource: fromData.length ? ("wikidata" as const) : undefined };
    }
    return null;
  });
}

/** Parses the "Cities" section of a Wikivoyage region/country article. */
async function wikivoyageCities(page: string): Promise<CityOption[]> {
  const api = (params: Record<string, string>) =>
    fetchJson(`https://en.wikivoyage.org/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", redirects: "1", ...params })}`, { headers: HEADERS }, 12_000);
  const sections = (await api({ action: "parse", page, prop: "sections" })) as { parse?: { sections?: { line: string; index: string }[] } };
  const sec = sections.parse?.sections?.find((s) => /^(cities|cities and towns|towns|cities & towns)$/i.test(s.line.trim()));
  if (!sec) return [];
  const text = ((await api({ action: "parse", page, section: sec.index, prop: "wikitext" })) as { parse?: { wikitext?: string } }).parse?.wikitext ?? "";

  const entries: { name: string; qid?: string; lat?: number; lng?: number; blurb?: string }[] = [];
  // {{marker|type=city|name=[[Kochi]]|lat=…|long=…|wikidata=Q…}} — may span lines.
  for (const m of text.matchAll(/\{\{\s*marker([\s\S]*?)\}\}([^\n]*)/gi)) {
    const body = m[1];
    const field = (k: string) => new RegExp(`\\|\\s*${k}\\s*=\\s*([^|}]*)`, "i").exec(body)?.[1]?.trim();
    // name=[[Target#anchor|Label]] may contain pipes, so match the whole link first.
    const rawName = (/\|\s*name\s*=\s*(\[\[[^\]]*\]\]|[^|}]*)/i.exec(body)?.[1] ?? "").trim();
    const link = /^\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/.exec(rawName);
    const name = (link ? (link[2] ?? link[1]) : rawName).trim();
    if (!name) continue;
    const lat = Number(field("lat"));
    const lng = Number(field("long"));
    entries.push({ name, qid: field("wikidata") || undefined, lat: Number.isFinite(lat) && field("lat") ? lat : undefined, lng: Number.isFinite(lng) && field("long") ? lng : undefined, blurb: cleanBlurb(m[2]) });
  }
  if (entries.length === 0) {
    for (const m of text.matchAll(/^\*\s*\[\[([^\]|]+)(?:\|[^\]]*)?\]\]([^\n]*)/gm)) entries.push({ name: m[1].trim(), blurb: cleanBlurb(m[2]) });
  }
  if (entries.length === 0) return [];

  // Each city's own Wikivoyage article item: fills missing ids, and its popularity is used when the
  // list's marker points at a narrower item (Wikivoyage's "Tokyo" marker is the special wards).
  const props = (await api({ action: "query", prop: "pageprops", ppprop: "wikibase_item", titles: entries.slice(0, 40).map((e) => e.name).join("|") })) as {
    query?: { pages?: { title: string; pageprops?: { wikibase_item?: string } }[]; redirects?: { from: string; to: string }[]; normalized?: { from: string; to: string }[] };
  };
  const rename = new Map([...(props.query?.normalized ?? []), ...(props.query?.redirects ?? [])].map((r) => [r.from, r.to]));
  const articleQid = new Map((props.query?.pages ?? []).map((p) => [p.title, p.pageprops?.wikibase_item]));
  const resolve = (name: string) => {
    let t = name;
    for (let i = 0; i < 3 && rename.has(t); i++) t = rename.get(t)!;
    return articleQid.get(t);
  };
  const alt = new Map(entries.map((e) => [e, resolve(e.name)]));
  for (const e of entries) e.qid ??= alt.get(e);
  const ids = [...new Set(entries.flatMap((e) => [e.qid, alt.get(e)]).filter((q): q is string => !!q))];
  const facts = ids.length
    ? await sparql(`SELECT ?item ?itemLabel ?loc ?sl WHERE {
  VALUES ?item { ${ids.map((q) => `wd:${q}`).join(" ")} }
  OPTIONAL { ?item wdt:P625 ?loc }
  OPTIONAL { ?item wikibase:sitelinks ?sl }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}`)
    : [];
  const byQid = new Map(facts.map((f) => [qidOf(f.item?.value), f]));
  // Popularity = how many people read the city's Wikivoyage guide (travel intent), last ~60 days.
  // If any lookup fails, every city falls back to Wikidata language editions so the scale stays comparable.
  const views = await Promise.allSettled(
    entries.map((e) => {
      let t = e.name;
      for (let i = 0; i < 3 && rename.has(t); i++) t = rename.get(t)!;
      return guideViews(t);
    }),
  );
  const useViews = views.every((v) => v.status === "fulfilled");
  const editions = entries.map((e) => {
    const f = e.qid ? byQid.get(e.qid) : undefined;
    const a = alt.get(e) ? byQid.get(alt.get(e)!) : undefined;
    return Math.max(Number(f?.sl?.value ?? 0), Number(a?.sl?.value ?? 0));
  });
  const readers = views.map((v) => (v.status === "fulfilled" ? v.value : 0));
  const maxEd = Math.max(1, ...editions);
  const maxRead = Math.max(1, ...readers);
  return entries
    .map((e, i): CityOption | null => {
      const f = e.qid ? byQid.get(e.qid) : undefined;
      const a = alt.get(e) ? byQid.get(alt.get(e)!) : undefined;
      const pos = e.lat !== undefined && e.lng !== undefined ? { lat: e.lat, lng: e.lng } : point(f?.loc?.value ?? a?.loc?.value);
      if (!pos) return null;
      // Blend: guide readership (travel intent) + language editions (global fame); 0–1000.
      const share = useViews ? 0.5 * (readers[i] / maxRead) + 0.5 * (editions[i] / maxEd) : editions[i] / maxEd;
      return { id: e.qid ?? e.name, name: e.name, ...pos, popularity: Math.round(share * 1000), blurb: e.blurb };
    })
    .filter((c): c is CityOption => c !== null)
    .sort((a, b) => b.popularity - a.popularity)
    .slice(0, MAX_CITY_OPTIONS);
}

/** Monthly user page views of an English Wikivoyage guide over the last two full months. */
async function guideViews(title: string): Promise<number> {
  const now = new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
  const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikivoyage/all-access/user/${encodeURIComponent(title.replace(/ /g, "_"))}/monthly/${ymd(start)}/${ymd(end)}`;
  const body = (await fetchJson(url, { headers: HEADERS }, 10_000)) as { items?: { views: number }[] };
  return (body.items ?? []).reduce((n, it) => n + it.views, 0);
}

function cleanBlurb(raw: string): string | undefined {
  const t = raw
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/^[\s—–:-]+/, "")
    .trim();
  return t ? t.slice(0, 160) : undefined;
}

async function wikidataCities(qid: string, scale: "region" | "country", minEditions = 15): Promise<CityOption[]> {
  // Region membership is P131 up to 3 levels deep (unbounded P131+ times out on big states).
  const within = scale === "country" ? `?city wdt:P17 wd:${qid} .` : `?city wdt:P131/wdt:P131?/wdt:P131? wd:${qid} .`;
  const rows = await sparql(`SELECT DISTINCT ?city ?cityLabel ?loc ?sl WHERE {
  VALUES ?cls { ${CITY_CLASSES.map((c) => `wd:${c}`).join(" ")} }
  ?city wdt:P31 ?cls ; wdt:P625 ?loc ; wikibase:sitelinks ?sl .
  ${within}
  FILTER(?sl >= ${minEditions})
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
} ORDER BY DESC(?sl) LIMIT 30`);
  const seen = new Set<string>();
  return rows
    .map((r): CityOption | null => {
      const id = qidOf(r.city?.value);
      const pos = point(r.loc?.value);
      const name = r.cityLabel?.value ?? "";
      if (!pos || !name || /^Q\d+$/.test(name) || seen.has(id)) return null;
      seen.add(id);
      return { id, name, ...pos, popularity: Number(r.sl?.value ?? 0) };
    })
    .filter((c): c is CityOption => c !== null)
    .slice(0, MAX_CITY_OPTIONS);
}
