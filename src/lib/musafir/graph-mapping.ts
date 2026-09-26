/**
 * TripState ⇄ property-graph rows (for the Neo4j store). Pure; no driver.
 *
 *   (:Trip)-[:HAS_DAY]->(:Day)-[:HAS_STOP]->(:Stop)-[:NEXT {transit}]->(:Stop)
 *
 * Graph properties must be primitives or arrays of one primitive type, and a
 * null property is simply absent — so nested objects are flattened, blobs
 * (metadata, vibe) are JSON strings, and optional fields are omitted rather
 * than set to null. `graphToTrip(tripToGraph(t))` must deep-equal `t`.
 */
import type { DaySchedule, ItineraryNode, TransitSegment, TripState } from "./schemas.ts";

type Prim = string | number | boolean;
type Props = Record<string, Prim | string[]>;

export interface TripRow extends Props {
  id: string;
  userId: string;
  destination: string;
  dateStart: string;
  dateEnd: string;
  vibeJson: string;
  dietary: string[];
  version: number;
}
export interface DayRow extends Props {
  key: string;
  tripId: string;
  dayIndex: number;
  date: string;
  dailyFatigueScore: number;
}
export interface StopRow extends Props {
  id: string;
  dayKey: string;
  position: number;
}
export interface LegRow extends Props {
  from: string;
  to: string;
  mode: string;
  durationMinutes: number;
  distanceMeters: number;
  fatigueScore: number;
}
export interface TripGraph {
  trip: TripRow;
  days: DayRow[];
  stops: StopRow[];
  legs: LegRow[];
}

export const dayKey = (tripId: string, dayIndex: number) => `${tripId}:${dayIndex}`;

/** Drops undefined values (Neo4j would store null → absent anyway). */
function compact<T extends Record<string, unknown>>(o: T): Props {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Props;
}

function stopRow(n: ItineraryNode, key: string, position: number): StopRow {
  return compact({
    id: n.id,
    dayKey: key,
    position,
    type: n.type,
    title: n.title,
    nativeTitle: n.nativeTitle,
    nativeAddress: n.nativeAddress,
    category: n.category,
    lat: n.location.lat,
    lng: n.location.lng,
    city: n.location.city,
    neighborhood: n.location.neighborhood,
    start: n.timeSlot.start,
    durationMinutes: n.timeSlot.durationMinutes,
    bufferMinutes: n.timeSlot.bufferMinutes,
    isOutdoor: n.isOutdoor,
    costAmount: n.costEstimate.amount,
    costCurrency: n.costEstimate.currency,
    metadataJson: n.metadata === undefined ? undefined : JSON.stringify(n.metadata),
  }) as StopRow;
}

export function tripToGraph(t: TripState): TripGraph {
  const days: DayRow[] = [];
  const stops: StopRow[] = [];
  const legs: LegRow[] = [];
  for (const d of t.schedule) {
    const key = dayKey(t.id, d.dayIndex);
    days.push({ key, tripId: t.id, dayIndex: d.dayIndex, date: d.date, dailyFatigueScore: d.dailyFatigueScore });
    d.nodes.forEach((n, i) => stops.push(stopRow(n, key, i)));
    for (const s of d.transitSegments) {
      legs.push({ from: s.fromNodeId, to: s.toNodeId, mode: s.mode, durationMinutes: s.durationMinutes, distanceMeters: s.distanceMeters, fatigueScore: s.fatigueScore });
    }
  }
  return {
    trip: {
      id: t.id,
      userId: t.userId,
      destination: t.destination,
      dateStart: t.dateRange.start,
      dateEnd: t.dateRange.end,
      vibeJson: JSON.stringify(t.vibeConfig),
      dietary: [...t.dietaryRestrictions],
      version: t.version,
    },
    days,
    stops,
    legs,
  };
}

const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const num = (v: unknown) => Number(v);

function rowToStop(r: Props): ItineraryNode {
  const node: ItineraryNode = {
    id: String(r.id),
    type: r.type as ItineraryNode["type"],
    title: String(r.title),
    category: r.category as ItineraryNode["category"],
    location: { lat: num(r.lat), lng: num(r.lng), city: String(r.city) },
    timeSlot: { start: String(r.start), durationMinutes: num(r.durationMinutes), bufferMinutes: num(r.bufferMinutes) },
    isOutdoor: Boolean(r.isOutdoor),
    costEstimate: { amount: num(r.costAmount), currency: String(r.costCurrency) },
  };
  if (str(r.nativeTitle) !== undefined) node.nativeTitle = str(r.nativeTitle);
  if (str(r.nativeAddress) !== undefined) node.nativeAddress = str(r.nativeAddress);
  if (str(r.neighborhood) !== undefined) node.location.neighborhood = str(r.neighborhood);
  if (str(r.metadataJson) !== undefined) node.metadata = JSON.parse(String(r.metadataJson));
  return node;
}

export function graphToTrip(g: { trip: Props; days: Props[]; stops: Props[]; legs: Props[] }): TripState {
  const t = g.trip;
  const tripId = String(t.id);
  const schedule: DaySchedule[] = [...g.days]
    .sort((a, b) => num(a.dayIndex) - num(b.dayIndex))
    .map((d) => {
      const key = String(d.key);
      const nodes = g.stops
        .filter((s) => s.dayKey === key)
        .sort((a, b) => num(a.position) - num(b.position))
        .map(rowToStop);
      const ids = new Set(nodes.map((n) => n.id));
      const order = new Map(nodes.map((n, i) => [n.id, i]));
      const transitSegments: TransitSegment[] = g.legs
        .filter((l) => ids.has(String(l.from)))
        .sort((a, b) => order.get(String(a.from))! - order.get(String(b.from))! || order.get(String(a.to))! - order.get(String(b.to))!)
        .map((l) => ({
          fromNodeId: String(l.from),
          toNodeId: String(l.to),
          mode: l.mode as TransitSegment["mode"],
          durationMinutes: num(l.durationMinutes),
          distanceMeters: num(l.distanceMeters),
          fatigueScore: num(l.fatigueScore),
        }));
      return { dayIndex: num(d.dayIndex), date: String(d.date), nodes, transitSegments, dailyFatigueScore: num(d.dailyFatigueScore) };
    });
  return {
    id: tripId,
    userId: String(t.userId),
    destination: String(t.destination),
    dateRange: { start: String(t.dateStart), end: String(t.dateEnd) },
    vibeConfig: JSON.parse(String(t.vibeJson)),
    dietaryRestrictions: Array.isArray(t.dietary) ? t.dietary.map(String) : [],
    schedule,
    version: num(t.version),
  };
}

/** Ids whose JSON differs between two lists (changed or new), and ids that disappeared. */
export function diffById<T>(prev: readonly T[], next: readonly T[], id: (x: T) => string, fingerprint: (x: T) => string = (x) => JSON.stringify(x)) {
  const before = new Map(prev.map((x) => [id(x), fingerprint(x)]));
  const after = new Set(next.map(id));
  return {
    upserts: next.filter((x) => before.get(id(x)) !== fingerprint(x)),
    deletes: [...before.keys()].filter((k) => !after.has(k)),
  };
}
