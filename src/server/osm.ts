/**
 * OpenStreetMap clients (free, no key):
 *  - Nominatim place search for adding stops. Usage policy: ≤1 request/s,
 *    identifying User-Agent, cache results, no per-keystroke autocomplete.
 *  - Overpass for nearby candidate venues, cached by rounded bounding box.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { haversineMeters } from "@/lib/musafir/geo.ts";
import { DATA_DIR } from "./store.ts";
import type { NodeCategory } from "@/lib/musafir/schemas.ts";

export const USER_AGENT = `Musafir/0.1 (hackathon travel demo${process.env.OSM_CONTACT_EMAIL ? `; ${process.env.OSM_CONTACT_EMAIL}` : ""})`;
const CACHE_TTL_MS = 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;

type CacheEntry<T> = { at: number; value: T };
const g = globalThis as typeof globalThis & {
  __musafirOsm?: { cache: Map<string, CacheEntry<unknown>>; nominatimChain: Promise<unknown>; lastNominatim: number; nominatimCooldownUntil?: number };
};
const osm = (g.__musafirOsm ??= { cache: new Map(), nominatimChain: Promise.resolve(), lastNominatim: 0, nominatimCooldownUntil: 0 });
/** After a 429, leave Nominatim alone for this long — retrying extends the block. */
const NOMINATIM_COOLDOWN_MS = 10 * 60_000;

/** A provider told us to slow down (HTTP 429). */
export class RateLimitError extends Error {
  constructor(host: string) {
    super(`OpenStreetMap search (${host}) is rate-limiting us — try again in a few minutes`);
  }
}

// ── Disk cache: results survive restarts and outages (place data changes slowly). ──
const DISK_TTL_MS = 7 * 24 * 60 * 60_000;
const DISK_FILE = path.join(DATA_DIR, "osm-cache.json");
const dg = globalThis as typeof globalThis & {
  __musafirOsmDisk?: { map: Promise<Map<string, CacheEntry<unknown>>> | null; timer: ReturnType<typeof setTimeout> | null };
};
const disk = (dg.__musafirOsmDisk ??= { map: null, timer: null });
function diskMap() {
  disk.map ??= fs
    .readFile(DISK_FILE, "utf8")
    .then((raw) => new Map(Object.entries(JSON.parse(raw) as Record<string, CacheEntry<unknown>>)))
    .catch(() => new Map<string, CacheEntry<unknown>>());
  return disk.map;
}
function scheduleDiskWrite() {
  if (disk.timer) return;
  disk.timer = setTimeout(async () => {
    disk.timer = null;
    try {
      const m = await diskMap();
      for (const [k, v] of m) if (Date.now() - v.at > DISK_TTL_MS * 2) m.delete(k);
      await fs.mkdir(DATA_DIR, { recursive: true });
      const tmp = `${DISK_FILE}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(Object.fromEntries(m)), "utf8");
      await fs.rename(tmp, DISK_FILE);
    } catch {
      /* cache is best-effort */
    }
  }, 2000);
}
const worthKeeping = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined);

/**
 * Memory (1 h) → disk (7 days) → network. If the network fails, an older disk
 * entry is served rather than an error: stale place names beat an empty day.
 */
export async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = osm.cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const m = await diskMap();
  const stored = m.get(key) as CacheEntry<T> | undefined;
  if (stored && Date.now() - stored.at < DISK_TTL_MS) {
    osm.cache.set(key, stored);
    return stored.value;
  }
  try {
    const value = await fn();
    if (worthKeeping(value)) {
      const entry = { at: Date.now(), value };
      osm.cache.set(key, entry);
      m.set(key, entry);
      scheduleDiskWrite();
    }
    return value;
  } catch (e) {
    if (stored) return stored.value;
    throw e;
  }
}

export async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { "User-Agent": USER_AGENT, ...init.headers } });
    if (res.status === 429) throw new RateLimitError(new URL(url).host);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ── Category inference from OSM tags (deterministic) ────────────────
export function categoryFromOsm(cls: string, type: string): { category: NodeCategory; isOutdoor: boolean } {
  if (cls === "tourism" && ["hotel", "guest_house", "hostel", "motel", "apartment"].includes(type)) return { category: "ACCOMMODATION", isOutdoor: false };
  if (["railway", "public_transport", "aeroway", "highway"].includes(cls)) return { category: "TRANSIT", isOutdoor: false };
  if (cls === "amenity" && ["restaurant", "cafe", "fast_food", "bar", "pub", "food_court", "ice_cream"].includes(type)) return { category: "DINING", isOutdoor: false };
  if (cls === "natural" || (cls === "leisure" && ["park", "garden", "nature_reserve", "beach_resort"].includes(type))) return { category: "NATURE", isOutdoor: true };
  if (cls === "tourism" && ["viewpoint", "zoo", "theme_park"].includes(type)) return { category: "LEISURE", isOutdoor: true };
  if (cls === "historic" || (cls === "tourism" && ["museum", "gallery", "attraction", "artwork"].includes(type)) || (cls === "amenity" && ["arts_centre", "theatre", "place_of_worship"].includes(type))) {
    return { category: "CULTURE", isOutdoor: type === "attraction" || cls === "historic" };
  }
  return { category: "LEISURE", isOutdoor: false };
}

// ── Nominatim ────────────────────────────────────────────────────────
export interface PlaceResult {
  displayName: string;
  name: string;
  nativeName?: string;
  lat: number;
  lng: number;
  city: string;
  neighborhood?: string;
  category: NodeCategory;
  isOutdoor: boolean;
}

interface NominatimItem {
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  class?: string;
  type: string;
  address?: Record<string, string>;
  namedetails?: Record<string, string>;
  extratags?: Record<string, string>;
}

function throttledNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const run = osm.nominatimChain.catch(() => undefined).then(async () => {
    if (Date.now() < (osm.nominatimCooldownUntil ?? 0)) throw new RateLimitError("nominatim.openstreetmap.org");
    const wait = osm.lastNominatim + NOMINATIM_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    osm.lastNominatim = Date.now();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RateLimitError) osm.nominatimCooldownUntil = Date.now() + NOMINATIM_COOLDOWN_MS;
      throw e;
    }
  });
  osm.nominatimChain = run;
  return run;
}

export async function searchPlaces(query: string, near?: { lat: number; lng: number }): Promise<PlaceResult[]> {
  const q = query.trim().slice(0, 200);
  if (q.length < 2) return [];
  const params = new URLSearchParams({ q, format: "jsonv2", limit: "6", addressdetails: "1", namedetails: "1", "accept-language": "en" });
  if (near) {
    const d = 0.5; // ~50 km viewbox bias, not a hard bound
    params.set("viewbox", `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }
  if (process.env.OSM_CONTACT_EMAIL) params.set("email", process.env.OSM_CONTACT_EMAIL);
  const key = `nominatim:${params}`;
  return cached(key, () =>
    withFallback(
      () =>
    throttledNominatim(async () => {
      const items = (await fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {}, 8000)) as NominatimItem[];
      return items.map((it) => {
        const a = it.address ?? {};
        const { category, isOutdoor } = categoryFromOsm(it.category ?? it.class ?? "", it.type);
        const native = it.namedetails?.name;
        const name = it.name || it.display_name.split(",")[0];
        return {
          displayName: it.display_name,
          name,
          nativeName: native && native !== name ? native : undefined,
          lat: Number(it.lat),
          lng: Number(it.lon),
          city: a.city ?? a.town ?? a.village ?? a.county ?? a.state ?? "",
          neighborhood: a.suburb ?? a.neighbourhood ?? a.quarter,
          category,
          isOutdoor,
        };
      });
    }),
      () => withFallback(() => photonSearch(q, near), () => openKnowledgeSearch(q, near)),
    ),
  );
}

// ── Overpass ─────────────────────────────────────────────────────────
export type CandidatePurpose = "INDOOR" | NodeCategory;

const PURPOSE_FILTERS: Record<CandidatePurpose, string[]> = {
  INDOOR: [
    `["tourism"~"^(museum|gallery|aquarium)$"]`,
    `["amenity"~"^(cafe|library|arts_centre|cinema|theatre)$"]`,
    `["shop"="mall"]`,
  ],
  CULTURE: [`["tourism"~"^(museum|gallery|attraction)$"]`, `["historic"~"^(monument|fort|castle|palace|temple|ruins)$"]`, `["amenity"~"^(arts_centre|theatre)$"]`],
  DINING: [`["amenity"~"^(restaurant|cafe|food_court)$"]`],
  NATURE: [`["leisure"~"^(park|garden|nature_reserve)$"]`],
  LEISURE: [`["leisure"~"^(park|sports_centre|water_park)$"]`, `["amenity"="cinema"]`, `["shop"="mall"]`, `["tourism"="viewpoint"]`],
  ACCOMMODATION: [`["tourism"~"^(hotel|guest_house|hostel)$"]`],
  TRANSIT: [],
};

export interface VenueCandidate {
  osmId: string;
  name: string;
  nameEn?: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  category: NodeCategory;
  isOutdoor: boolean;
  openingHours?: string;
  wheelchair?: string;
  cuisine?: string;
  kind: string;
  /** Which open-data service produced this candidate. */
  source: "overpass" | "nominatim" | "photon" | "wikidata";
  /** OSM `diet:*` tags, verbatim (e.g. { "diet:vegetarian": "yes" }). */
  diet?: Record<string, string>;
  /** OSM `stars` tag for accommodation, verbatim; absent when not mapped. */
  stars?: string;
  /** How well known the place is: Wikidata language editions, or 5 when OSM only links a Wikidata/Wikipedia entry. */
  notability?: number;
  website?: string;
}

function dietTags(tags: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!tags) return undefined;
  const out = Object.fromEntries(Object.entries(tags).filter(([k]) => k.startsWith("diet:")));
  return Object.keys(out).length ? out : undefined;
}

interface OverpassElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

const TAG_CLASSES = ["tourism", "amenity", "historic", "leisure", "shop", "natural"] as const;

/** Public Overpass instances, tried in order. Override with OVERPASS_URLS (comma-separated). */
const OVERPASS_URLS = (process.env.OVERPASS_URLS || "https://overpass-api.de/api/interpreter,https://overpass.kumi.systems/api/interpreter,https://overpass.private.coffee/api/interpreter")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const LANDMARK_PURPOSES = new Set<CandidatePurpose>(["CULTURE", "NATURE", "LEISURE"]);
/** Fewer Wikidata hits than this and we still ask Nominatim (thin coverage in some towns). */
const MIN_USEFUL_RESULTS = 5;

/** Keyword searches used when every Overpass instance is unreachable. */
const NOMINATIM_KEYWORDS: Record<CandidatePurpose, string[]> = {
  INDOOR: ["museum", "cafe", "library"],
  CULTURE: ["museum", "temple", "monument"],
  DINING: ["restaurant", "cafe"],
  NATURE: ["park", "garden"],
  LEISURE: ["park", "cinema"],
  ACCOMMODATION: ["hotel", "guest house", "hostel"],
  TRANSIT: [],
};

/** After every Overpass instance fails, skip Overpass for this long (circuit breaker). */
const OVERPASS_COOLDOWN_MS = 5 * 60_000;
const breaker = ((globalThis as typeof globalThis & { __musafirOverpassDownUntil?: { until: number } }).__musafirOverpassDownUntil ??= { until: 0 });

async function overpassCandidates(center: { lat: number; lng: number }, purpose: CandidatePurpose, r: number): Promise<VenueCandidate[]> {
  if (Date.now() < breaker.until) throw new Error("Overpass unreachable recently; skipping for a few minutes");
  const lat = Number(center.lat.toFixed(3));
  const lng = Number(center.lng.toFixed(3));
  const body = `[out:json][timeout:10];(${PURPOSE_FILTERS[purpose].map((f) => `nwr(around:${r},${lat},${lng})["name"]${f};`).join("")});out center tags 60;`;
  const errors: string[] = [];
  for (const url of OVERPASS_URLS) {
    try {
      const data = (await fetchJson(
        url,
        { method: "POST", body: new URLSearchParams({ data: body }), headers: { "Content-Type": "application/x-www-form-urlencoded" } },
        7000,
      )) as { elements?: OverpassElement[] };
      const seen = new Set<string>();
      const out: VenueCandidate[] = [];
      for (const el of data.elements ?? []) {
        const pos = el.lat !== undefined && el.lon !== undefined ? { lat: el.lat, lng: el.lon } : el.center ? { lat: el.center.lat, lng: el.center.lon } : null;
        const tags = el.tags ?? {};
        if (!pos || !tags.name || seen.has(tags.name)) continue;
        seen.add(tags.name);
        const cls = TAG_CLASSES.find((c) => tags[c]) ?? "amenity";
        const { category, isOutdoor } = categoryFromOsm(cls, tags[cls] ?? "");
        out.push({
          osmId: `${el.type}/${el.id}`,
          name: tags.name,
          nameEn: [tags["name:en"], tags.int_name, tags["name:latin"]].find((n) => n && n !== tags.name),
          ...pos,
          distanceMeters: Math.round(haversineMeters(center, pos)),
          category: purpose === "INDOOR" ? category : purpose,
          isOutdoor: purpose === "INDOOR" ? false : isOutdoor,
          openingHours: tags.opening_hours,
          wheelchair: tags.wheelchair,
          cuisine: tags.cuisine,
          kind: `${cls}=${tags[cls] ?? "?"}`,
          source: "overpass",
          diet: dietTags(tags),
          stars: tags.stars,
          website: tags.website ?? tags["contact:website"],
          notability: tags.wikidata || tags.wikipedia ? 5 : 0,
        });
      }
      return out;
    } catch (e) {
      errors.push(`${new URL(url).host}: ${(e as Error).message}`);
    }
  }
  breaker.until = Date.now() + OVERPASS_COOLDOWN_MS;
  throw new Error(`all Overpass instances failed (${errors.join("; ")})`);
}

async function nominatimCandidates(center: { lat: number; lng: number }, purpose: CandidatePurpose, r: number): Promise<VenueCandidate[]> {
  const dLat = r / 111_320;
  const dLng = r / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  const viewbox = `${center.lng - dLng},${center.lat + dLat},${center.lng + dLng},${center.lat - dLat}`;
  const out: VenueCandidate[] = [];
  const seen = new Set<string>();
  for (const keyword of NOMINATIM_KEYWORDS[purpose]) {
    const params = new URLSearchParams({ q: keyword, format: "jsonv2", limit: "10", bounded: "1", viewbox, namedetails: "1", extratags: "1", "accept-language": "en" });
    if (process.env.OSM_CONTACT_EMAIL) params.set("email", process.env.OSM_CONTACT_EMAIL);
    const items = await throttledNominatim(
      () => fetchJson(`https://nominatim.openstreetmap.org/search?${params}`, {}, 8000) as Promise<NominatimItem[]>,
    );
    for (const it of items) {
      const pos = { lat: Number(it.lat), lng: Number(it.lon) };
      const name = it.name || it.display_name.split(",")[0];
      const distanceMeters = Math.round(haversineMeters(center, pos));
      if (!name || seen.has(name) || distanceMeters > r) continue;
      seen.add(name);
      const cls = it.category ?? it.class ?? "";
      const { category, isOutdoor } = categoryFromOsm(cls, it.type);
      const native = it.namedetails?.name;
      out.push({
        osmId: `nominatim/${cls}/${it.type}/${name}`,
        name: native ?? name,
        nameEn: native && native !== name ? name : undefined,
        ...pos,
        distanceMeters,
        category: purpose === "INDOOR" ? category : purpose,
        isOutdoor: purpose === "INDOOR" ? false : isOutdoor,
        kind: `${cls}=${it.type}`,
        source: "nominatim",
        diet: dietTags(it.extratags),
        openingHours: it.extratags?.opening_hours,
        stars: it.extratags?.stars,
        website: it.extratags?.website ?? it.extratags?.["contact:website"],
        notability: it.extratags?.wikidata || it.extratags?.wikipedia ? 5 : 0,
      });
    }
  }
  return out;
}

/**
 * Real venues near a point: Overpass (rich tags incl. opening hours) with
 * mirror fallback, then Nominatim keyword search inside the same radius when
 * every Overpass instance is unreachable (some networks block them).
 */
export async function nearbyCandidates(
  center: { lat: number; lng: number },
  purpose: CandidatePurpose,
  radiusMeters = 800,
): Promise<VenueCandidate[]> {
  if (PURPOSE_FILTERS[purpose].length === 0) return [];
  const r = Math.round(Math.min(Math.max(radiusMeters, 100), 3000));
  // Cache by ~110 m grid cell so nearby requests share results.
  const key = `venues:v3:${purpose}:${center.lat.toFixed(3)}:${center.lng.toFixed(3)}:${r}`;
  return cached(key, async () => {
    let list: VenueCandidate[];
    try {
      list = await overpassCandidates(center, purpose, r);
    } catch (overpassError) {
      // Landmark-type lookups go to Wikidata before hammering Nominatim with keyword sweeps
      // (Nominatim's policy discourages bulk POI queries); food/hotels keep Nominatim's better coverage.
      if (LANDMARK_PURPOSES.has(purpose)) {
        try {
          const wiki = await wikidataCandidates(center, purpose, r);
          if (wiki.length >= MIN_USEFUL_RESULTS) return wiki.sort((a, b) => a.distanceMeters - b.distanceMeters);
        } catch {
          /* fall through to Nominatim */
        }
      }
      try {
        list = await nominatimCandidates(center, purpose, r);
      } catch (nominatimError) {
        try {
          list = await photonCandidates(center, purpose, r);
        } catch (photonError) {
          try {
            list = await wikidataCandidates(center, purpose, r);
            return list.sort((a, b) => a.distanceMeters - b.distanceMeters);
          } catch {
            /* fall through to the most useful error */
          }
          const limited = [nominatimError, photonError].find((e) => e instanceof RateLimitError);
          if (limited) throw limited;
          throw new Error(
            `no map data source reachable (${(overpassError as Error).message}; ${(nominatimError as Error).message}; Photon: ${(photonError as Error).message})`,
          );
        }
      }
    }
    return list.sort((a, b) => a.distanceMeters - b.distanceMeters);
  });
}

/**
 * Address in the place's local script (no accept-language → OSM default names),
 * for the Taxi Rescue card. Throttled and cached like search.
 */
export async function reverseLocal(lat: number, lng: number): Promise<{ localAddress: string; localName?: string } | null> {
  const params = new URLSearchParams({ lat: lat.toFixed(6), lon: lng.toFixed(6), format: "jsonv2", zoom: "18", namedetails: "1" });
  if (process.env.OSM_CONTACT_EMAIL) params.set("email", process.env.OSM_CONTACT_EMAIL);
  return cached(`reverse:${params}`, () =>
    withFallback(
      () =>
        throttledNominatim(async () => {
          const r = (await fetchJson(`https://nominatim.openstreetmap.org/reverse?${params}`, {}, 8000)) as { display_name?: string; namedetails?: Record<string, string> };
          return r.display_name ? { localAddress: r.display_name, localName: r.namedetails?.name } : null;
        }),
      () => photonReverse(lat, lng),
    ),
  );
}

// ── Photon (photon.komoot.io): free, keyless OSM search — third source when the others fail. ──
const PHOTON = "https://photon.komoot.io";
interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: Record<string, string | number | undefined> & { name?: string; osm_key?: string; osm_value?: string; osm_type?: string; osm_id?: number };
}

async function withFallback<T>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await primary();
  } catch (primaryError) {
    try {
      return await fallback();
    } catch {
      throw primaryError;
    }
  }
}

const photonCity = (p: PhotonFeature["properties"]) => String(p.city ?? p.county ?? p.state ?? "");

async function photonSearch(q: string, near?: { lat: number; lng: number }): Promise<PlaceResult[]> {
  const params = new URLSearchParams({ q, limit: "6", lang: "en" });
  if (near) {
    params.set("lat", String(near.lat));
    params.set("lon", String(near.lng));
  }
  const body = (await fetchJson(`${PHOTON}/api/?${params}`, {}, 8000)) as { features?: PhotonFeature[] };
  return (body.features ?? [])
    .filter((f) => f.properties.name)
    .map((f) => {
      const p = f.properties;
      const { category, isOutdoor } = categoryFromOsm(String(p.osm_key ?? ""), String(p.osm_value ?? ""));
      const [lng, lat] = f.geometry.coordinates;
      return {
        displayName: [p.name, p.street, p.district, photonCity(p), p.country].filter(Boolean).join(", "),
        name: String(p.name),
        lat,
        lng,
        city: photonCity(p),
        neighborhood: p.district ? String(p.district) : undefined,
        category,
        isOutdoor,
      };
    });
}

const PHOTON_TAGS: Record<CandidatePurpose, string[]> = {
  INDOOR: ["tourism:museum", "amenity:cafe", "amenity:library"],
  CULTURE: ["tourism:museum", "tourism:attraction", "historic"],
  DINING: ["amenity:restaurant", "amenity:cafe"],
  NATURE: ["leisure:park", "leisure:garden"],
  LEISURE: ["leisure:park", "amenity:cinema"],
  ACCOMMODATION: ["tourism:hotel", "tourism:guest_house", "tourism:hostel"],
  TRANSIT: [],
};

async function photonCandidates(center: { lat: number; lng: number }, purpose: CandidatePurpose, r: number): Promise<VenueCandidate[]> {
  const dLat = r / 111_320;
  const dLng = r / (111_320 * Math.max(0.01, Math.cos((center.lat * Math.PI) / 180)));
  const bbox = `${center.lng - dLng},${center.lat - dLat},${center.lng + dLng},${center.lat + dLat}`;
  const out: VenueCandidate[] = [];
  const seen = new Set<string>();
  for (const tag of PHOTON_TAGS[purpose]) {
    const word = (tag.split(":")[1] ?? tag).replace("_", " ");
    const params = new URLSearchParams({ q: word, lat: String(center.lat), lon: String(center.lng), bbox, osm_tag: tag, limit: "15", lang: "en" });
    const body = (await fetchJson(`${PHOTON}/api/?${params}`, {}, 8000)) as { features?: PhotonFeature[] };
    for (const f of body.features ?? []) {
      const p = f.properties;
      const [lng, lat] = f.geometry.coordinates;
      const name = p.name ? String(p.name) : "";
      const distanceMeters = Math.round(haversineMeters(center, { lat, lng }));
      if (!name || seen.has(name) || distanceMeters > r) continue;
      seen.add(name);
      const cls = String(p.osm_key ?? "");
      const { category, isOutdoor } = categoryFromOsm(cls, String(p.osm_value ?? ""));
      out.push({
        osmId: `${p.osm_type ?? "n"}/${p.osm_id ?? name}`,
        name,
        lat,
        lng,
        distanceMeters,
        category: purpose === "INDOOR" ? category : purpose,
        isOutdoor: purpose === "INDOOR" ? false : isOutdoor,
        kind: `${cls}=${p.osm_value ?? "?"}`,
        source: "photon",
      });
    }
  }
  return out;
}

async function photonReverse(lat: number, lng: number): Promise<{ localAddress: string; localName?: string } | null> {
  const body = (await fetchJson(`${PHOTON}/reverse?lat=${lat}&lon=${lng}`, {}, 8000)) as { features?: PhotonFeature[] };
  const p = body.features?.[0]?.properties;
  if (!p) return null;
  const localAddress = [p.name, p.housenumber, p.street, p.district, photonCity(p), p.country].filter(Boolean).join(", ");
  return localAddress ? { localAddress, localName: p.name ? String(p.name) : undefined } : null;
}

// ── Open knowledge (last tier): Wikidata, Wikipedia, Open-Meteo geocoding. ──
// Real, community-maintained data (OSM's sister projects), keyless, reachable on
// networks that block OSM mirrors. Coverage of restaurants/hotels is thinner than
// OSM, so this tier only runs when every OSM source has failed.
const WIKI_UA = { "User-Agent": USER_AGENT, Accept: "application/sparql-results+json" };

/** Wikidata classes per purpose (instance-of, including subclasses). */
const WIKIDATA_CLASSES: Record<CandidatePurpose, { q: string; category: NodeCategory; outdoor: boolean; kind: string }[]> = {
  INDOOR: [
    { q: "Q33506", category: "CULTURE", outdoor: false, kind: "tourism=museum" },
    { q: "Q7075", category: "CULTURE", outdoor: false, kind: "amenity=library" },
    { q: "Q41253", category: "LEISURE", outdoor: false, kind: "amenity=cinema" },
    { q: "Q11315", category: "LEISURE", outdoor: false, kind: "shop=mall" },
    { q: "Q30022", category: "DINING", outdoor: false, kind: "amenity=cafe" },
  ],
  CULTURE: [
    { q: "Q33506", category: "CULTURE", outdoor: false, kind: "tourism=museum" },
    { q: "Q57831", category: "CULTURE", outdoor: true, kind: "historic=fort" },
    { q: "Q16560", category: "CULTURE", outdoor: false, kind: "historic=palace" },
    { q: "Q44539", category: "CULTURE", outdoor: false, kind: "historic=temple" },
    { q: "Q4989906", category: "CULTURE", outdoor: true, kind: "historic=monument" },
    { q: "Q570116", category: "CULTURE", outdoor: true, kind: "tourism=attraction" },
  ],
  DINING: [
    { q: "Q11707", category: "DINING", outdoor: false, kind: "amenity=restaurant" },
    { q: "Q30022", category: "DINING", outdoor: false, kind: "amenity=cafe" },
  ],
  NATURE: [
    { q: "Q22698", category: "NATURE", outdoor: true, kind: "leisure=park" },
    { q: "Q1107656", category: "NATURE", outdoor: true, kind: "leisure=garden" },
    { q: "Q23397", category: "NATURE", outdoor: true, kind: "natural=water" },
  ],
  LEISURE: [
    { q: "Q22698", category: "LEISURE", outdoor: true, kind: "leisure=park" },
    { q: "Q41253", category: "LEISURE", outdoor: false, kind: "amenity=cinema" },
    { q: "Q11315", category: "LEISURE", outdoor: false, kind: "shop=mall" },
  ],
  ACCOMMODATION: [{ q: "Q27686", category: "ACCOMMODATION", outdoor: false, kind: "tourism=hotel" }],
  TRANSIT: [],
};

interface SparqlRow {
  item: { value: string };
  itemLabel?: { value: string; "xml:lang"?: string };
  loc: { value: string };
  cls: { value: string };
  sl?: { value: string };
}

async function wikidataCandidates(center: { lat: number; lng: number }, purpose: CandidatePurpose, r: number): Promise<VenueCandidate[]> {
  const classes = WIKIDATA_CLASSES[purpose];
  if (classes.length === 0) return [];
  const km = Math.max(0.2, r / 1000).toFixed(2);
  const values = classes.map((c) => `wd:${c.q}`).join(" ");
  const query = `SELECT ?item ?itemLabel ?loc ?cls ?sl WHERE {
  SERVICE wikibase:around { ?item wdt:P625 ?loc . bd:serviceParam wikibase:center "Point(${center.lng} ${center.lat})"^^geo:wktLiteral ; wikibase:radius "${km}" . }
  VALUES ?cls { ${values} }
  ?item wdt:P31/wdt:P279* ?cls .
  OPTIONAL { ?item wikibase:sitelinks ?sl }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,[AUTO_LANGUAGE],mul". }
} ORDER BY DESC(?sl) LIMIT 80`;
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ format: "json", query })}`;
  const body = (await fetchJson(url, { headers: WIKI_UA }, 20000)) as { results?: { bindings?: SparqlRow[] } };
  const seen = new Set<string>();
  const out: VenueCandidate[] = [];
  for (const row of body.results?.bindings ?? []) {
    const m = /Point\(([-\d.]+) ([-\d.]+)\)/.exec(row.loc.value);
    const name = row.itemLabel?.value ?? "";
    const qid = row.item.value.split("/").pop() ?? "";
    // Unlabelled items come back as their Q-id — never show those as a place name.
    if (!m || !name || /^Q\d+$/.test(name) || seen.has(qid)) continue;
    seen.add(qid);
    const pos = { lat: Number(m[2]), lng: Number(m[1]) };
    const cls = classes.find((c) => row.cls.value.endsWith(`/${c.q}`)) ?? classes[0];
    const distanceMeters = Math.round(haversineMeters(center, pos));
    if (distanceMeters > r) continue;
    out.push({
      osmId: `wikidata/${qid}`,
      name,
      ...pos,
      distanceMeters,
      category: purpose === "INDOOR" ? cls.category : purpose === "ACCOMMODATION" || purpose === "DINING" ? purpose : cls.category,
      isOutdoor: purpose === "INDOOR" ? false : cls.outdoor,
      kind: cls.kind,
      source: "wikidata",
      notability: Number(row.sl?.value ?? 0),
    });
  }
  return out;
}

/** Keyword → category for Wikipedia results (their descriptions are short phrases like "palace in Jaipur, India"). */
function categoryFromDescription(text: string): { category: NodeCategory; isOutdoor: boolean } {
  const t = text.toLowerCase();
  if (/hotel|resort|hostel|guest ?house/.test(t)) return { category: "ACCOMMODATION", isOutdoor: false };
  if (/restaurant|cafe|café|eatery|food/.test(t)) return { category: "DINING", isOutdoor: false };
  if (/park|garden|lake|hill|forest|zoo/.test(t)) return { category: "NATURE", isOutdoor: true };
  if (/station|airport|terminal/.test(t)) return { category: "TRANSIT", isOutdoor: false };
  if (/fort|monument|observatory|stepwell|ruins?/.test(t)) return { category: "CULTURE", isOutdoor: true };
  if (/museum|palace|temple|mosque|church|gallery|mahal|haveli|historic/.test(t)) return { category: "CULTURE", isOutdoor: false };
  return { category: "LEISURE", isOutdoor: false };
}

/** Named-place search via Wikipedia (landmarks with coordinates), then cities via Open-Meteo's geocoder. */
export async function openKnowledgeSearch(q: string, near?: { lat: number; lng: number }): Promise<PlaceResult[]> {
  const wikiParams = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: q,
    gsrlimit: "8",
    prop: "coordinates|description",
    format: "json",
    formatversion: "2",
  });
  const wiki = (await fetchJson(`https://en.wikipedia.org/w/api.php?${wikiParams}`, { headers: WIKI_UA }, 10000).catch(() => null)) as {
    query?: { pages?: { title: string; index: number; description?: string; coordinates?: { lat: number; lon: number }[] }[] };
  } | null;
  const places: PlaceResult[] = (wiki?.query?.pages ?? [])
    .filter((p) => p.coordinates?.length)
    .sort((a, b) => a.index - b.index)
    .map((p) => {
      const { category, isOutdoor } = categoryFromDescription(`${p.title} ${p.description ?? ""}`);
      const c = p.coordinates![0];
      return { displayName: [p.title, p.description].filter(Boolean).join(" — "), name: p.title, lat: c.lat, lng: c.lon, city: "", category, isOutdoor };
    });
  if (near) places.sort((a, b) => haversineMeters(near, a) - haversineMeters(near, b));
  if (places.length) return places.slice(0, 6);

  const geo = (await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?${new URLSearchParams({ name: q, count: "6", language: "en" })}`, {}, 8000)) as {
    results?: { name: string; latitude: number; longitude: number; admin1?: string; country?: string }[];
  };
  return (geo.results ?? []).map((g) => ({
    displayName: [g.name, g.admin1, g.country].filter(Boolean).join(", "),
    name: g.name,
    lat: g.latitude,
    lng: g.longitude,
    city: g.name,
    category: "LEISURE" as NodeCategory,
    isOutdoor: false,
  }));
}
