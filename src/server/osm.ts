/**
 * OpenStreetMap clients (free, no key):
 *  - Nominatim place search for adding stops. Usage policy: ≤1 request/s,
 *    identifying User-Agent, cache results, no per-keystroke autocomplete.
 *  - Overpass for nearby candidate venues, cached by rounded bounding box.
 */
import { haversineMeters } from "@/lib/musafir/geo.ts";
import type { NodeCategory } from "@/lib/musafir/schemas.ts";

const USER_AGENT = `Musafir/0.1 (hackathon travel demo${process.env.OSM_CONTACT_EMAIL ? `; ${process.env.OSM_CONTACT_EMAIL}` : ""})`;
const CACHE_TTL_MS = 60 * 60 * 1000;
const NOMINATIM_MIN_INTERVAL_MS = 1100;

type CacheEntry<T> = { at: number; value: T };
const g = globalThis as typeof globalThis & {
  __musafirOsm?: { cache: Map<string, CacheEntry<unknown>>; nominatimChain: Promise<unknown>; lastNominatim: number };
};
const osm = (g.__musafirOsm ??= { cache: new Map(), nominatimChain: Promise.resolve(), lastNominatim: 0 });

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = osm.cache.get(key) as CacheEntry<T> | undefined;
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await fn();
  osm.cache.set(key, { at: Date.now(), value });
  return value;
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, headers: { "User-Agent": USER_AGENT, ...init.headers } });
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
}

function throttledNominatim<T>(fn: () => Promise<T>): Promise<T> {
  const run = osm.nominatimChain.catch(() => undefined).then(async () => {
    const wait = osm.lastNominatim + NOMINATIM_MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    osm.lastNominatim = Date.now();
    return fn();
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
  source: "overpass" | "nominatim";
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

/** Keyword searches used when every Overpass instance is unreachable. */
const NOMINATIM_KEYWORDS: Record<CandidatePurpose, string[]> = {
  INDOOR: ["museum", "cafe", "library"],
  CULTURE: ["museum", "temple", "monument"],
  DINING: ["restaurant", "cafe"],
  NATURE: ["park", "garden"],
  LEISURE: ["park", "cinema"],
  ACCOMMODATION: ["hotel"],
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
          nameEn: tags["name:en"] && tags["name:en"] !== tags.name ? tags["name:en"] : undefined,
          ...pos,
          distanceMeters: Math.round(haversineMeters(center, pos)),
          category: purpose === "INDOOR" ? category : purpose,
          isOutdoor: purpose === "INDOOR" ? false : isOutdoor,
          openingHours: tags.opening_hours,
          wheelchair: tags.wheelchair,
          cuisine: tags.cuisine,
          kind: `${cls}=${tags[cls] ?? "?"}`,
          source: "overpass",
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
    const params = new URLSearchParams({ q: keyword, format: "jsonv2", limit: "10", bounded: "1", viewbox, namedetails: "1", "accept-language": "en" });
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
  const key = `venues:${purpose}:${center.lat.toFixed(3)}:${center.lng.toFixed(3)}:${r}`;
  return cached(key, async () => {
    let list: VenueCandidate[];
    try {
      list = await overpassCandidates(center, purpose, r);
    } catch (overpassError) {
      try {
        list = await nominatimCandidates(center, purpose, r);
      } catch (nominatimError) {
        throw new Error(`${(overpassError as Error).message}; Nominatim fallback failed: ${(nominatimError as Error).message}`);
      }
    }
    return list.sort((a, b) => a.distanceMeters - b.distanceMeters);
  });
}
