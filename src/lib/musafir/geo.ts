/**
 * Deterministic spatial math. No LLM ever computes distances or durations.
 *
 * Travel times come from the public OSRM server when reachable, else from a
 * Haversine estimate. Note: router.project-osrm.org only serves the car profile
 * (a `foot` request returns identical car results), so OSRM is used for road
 * *distance* and CAB duration; walking time is always distance / WALK_SPEED.
 */
import type { GeoLocation, ItineraryNode, TransitMode, TransitSegment } from "./schemas.ts";

const EARTH_RADIUS_M = 6_371_008.8;

/** Straight-line distance → street-network distance. */
export const ROUTE_DETOUR_FACTOR = 1.3;
export const WALK_METERS_PER_MIN = 80; // ≈4.8 km/h
export const CAB_METERS_PER_MIN = 370; // ≈22 km/h urban average
export const CAB_PICKUP_OVERHEAD_MIN = 5;
/** Legs at or below this network distance are walked; longer ones take a cab. */
export const MAX_WALK_METERS = 1200;

/** Commute bands (CLAUDE.md USP 3). */
export const COMMUTE_HEALTHY_MAX_MIN = 15;
export const COMMUTE_MODERATE_MAX_MIN = 35;
export type CommuteBand = "HEALTHY" | "MODERATE" | "SPIKE";

/** Effort per minute of travel, relative to a seated metro ride. */
export const MODE_FATIGUE_WEIGHT: Record<TransitMode, number> = {
  WALK: 1.25,
  SUBWAY: 1,
  BUS: 1.1,
  CAB: 0.7,
};
/** Weighted minutes that saturate a single leg's fatigue score at 100. */
export const LEG_FATIGUE_SATURATION_MIN = 60;
/** Weighted transit minutes in one day that saturate the daily score at 100. */
export const DAILY_FATIGUE_SATURATION_MIN = 180;

export const OSRM_BASE_URL = "https://router.project-osrm.org";
export const OSRM_TIMEOUT_MS = 2500;
/** Public server rejects larger table requests. */
export const OSRM_MAX_TABLE_COORDS = 100;

type LatLng = Pick<GeoLocation, "lat" | "lng">;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function commuteBand(durationMinutes: number): CommuteBand {
  if (durationMinutes < COMMUTE_HEALTHY_MAX_MIN) return "HEALTHY";
  if (durationMinutes <= COMMUTE_MODERATE_MAX_MIN) return "MODERATE";
  return "SPIKE";
}

export function legFatigueScore(mode: TransitMode, durationMinutes: number): number {
  const weighted = Math.max(0, durationMinutes) * MODE_FATIGUE_WEIGHT[mode];
  return Math.round(clamp((weighted / LEG_FATIGUE_SATURATION_MIN) * 100, 0, 100));
}

export function dailyFatigueScore(segments: readonly TransitSegment[]): number {
  const weighted = segments.reduce(
    (sum, s) => sum + Math.max(0, s.durationMinutes) * MODE_FATIGUE_WEIGHT[s.mode],
    0,
  );
  return Math.round(clamp((weighted / DAILY_FATIGUE_SATURATION_MIN) * 100, 0, 100));
}

export interface LegEstimate {
  mode: TransitMode;
  durationMinutes: number;
  distanceMeters: number;
}

/**
 * Picks a mode and duration from a street-network distance. `cabMinutes`, when
 * known (OSRM), replaces the speed-based cab estimate.
 */
export function legFromNetworkDistance(distanceMeters: number, cabMinutes?: number): LegEstimate {
  const distance = Math.max(0, distanceMeters);
  if (distance <= MAX_WALK_METERS) {
    return { mode: "WALK", durationMinutes: Math.ceil(distance / WALK_METERS_PER_MIN), distanceMeters: Math.round(distance) };
  }
  const drive = cabMinutes ?? distance / CAB_METERS_PER_MIN;
  return {
    mode: "CAB",
    durationMinutes: Math.ceil(drive + CAB_PICKUP_OVERHEAD_MIN),
    distanceMeters: Math.round(distance),
  };
}

export function estimateLeg(from: LatLng, to: LatLng): LegEstimate {
  return legFromNetworkDistance(haversineMeters(from, to) * ROUTE_DETOUR_FACTOR);
}

export function buildSegment(from: ItineraryNode, to: ItineraryNode, leg: LegEstimate): TransitSegment {
  return {
    fromNodeId: from.id,
    toNodeId: to.id,
    mode: leg.mode,
    durationMinutes: leg.durationMinutes,
    distanceMeters: leg.distanceMeters,
    fatigueScore: legFatigueScore(leg.mode, leg.durationMinutes),
  };
}

/**
 * Transit segments for consecutive nodes (in the given order). Existing segments
 * for the same pair are kept (they may carry real SUBWAY/BUS data); new
 * adjacencies are estimated.
 */
export function rebuildTransitSegments(
  orderedNodes: readonly ItineraryNode[],
  existing: readonly TransitSegment[] = [],
): TransitSegment[] {
  const known = new Map(existing.map((s) => [`${s.fromNodeId}>${s.toNodeId}`, s]));
  const out: TransitSegment[] = [];
  for (let i = 1; i < orderedNodes.length; i++) {
    const from = orderedNodes[i - 1];
    const to = orderedNodes[i];
    out.push(known.get(`${from.id}>${to.id}`) ?? buildSegment(from, to, estimateLeg(from.location, to.location)));
  }
  return out;
}

export interface DistanceMatrix {
  source: "osrm" | "haversine";
  /** meters[i][j]: street-network distance from point i to j. */
  meters: number[][];
  /** legs[i][j]: chosen mode + door-to-door minutes. */
  legs: LegEstimate[][];
}

export function haversineMatrix(points: readonly LatLng[]): DistanceMatrix {
  const meters = points.map((a) => points.map((b) => haversineMeters(a, b) * ROUTE_DETOUR_FACTOR));
  return {
    source: "haversine",
    meters,
    legs: meters.map((row) => row.map((d) => legFromNetworkDistance(d))),
  };
}

export interface OsrmOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * OSRM table request with a hard timeout. Any failure (network, timeout, HTTP
 * error, malformed body, unroutable pair, too many points) falls back to the
 * Haversine matrix for the whole request so callers always get a full matrix.
 */
export async function distanceMatrix(points: readonly LatLng[], opts: OsrmOptions = {}): Promise<DistanceMatrix> {
  if (points.length < 2 || points.length > OSRM_MAX_TABLE_COORDS) return haversineMatrix(points);

  const { baseUrl = OSRM_BASE_URL, timeoutMs = OSRM_TIMEOUT_MS, fetchImpl = fetch } = opts;
  const coords = points.map((p) => `${p.lng},${p.lat}`).join(";");
  const url = `${baseUrl}/table/v1/driving/${coords}?annotations=duration,distance`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return haversineMatrix(points);
    const body = (await res.json()) as { code?: string; durations?: (number | null)[][]; distances?: (number | null)[][] };
    const { durations, distances } = body;
    const n = points.length;
    const valid = (m: unknown): m is number[][] =>
      Array.isArray(m) &&
      m.length === n &&
      m.every((row) => Array.isArray(row) && row.length === n && row.every((v) => typeof v === "number" && Number.isFinite(v)));
    if (body.code !== "Ok" || !valid(durations) || !valid(distances)) return haversineMatrix(points);

    return {
      source: "osrm",
      meters: distances,
      legs: distances.map((row, i) => row.map((d, j) => legFromNetworkDistance(d, durations[i][j] / 60))),
    };
  } catch {
    return haversineMatrix(points);
  } finally {
    clearTimeout(timer);
  }
}
