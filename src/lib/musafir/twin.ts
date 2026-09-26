/**
 * Weather Digital Twin (pure). A virtual copy of a trip day that estimates
 * how it behaves under many possible weathers, using Musafir's own
 * self-healing engine as the simulator — so the twin behaves exactly like the
 * real system would, without touching it (everything runs on previews).
 *
 *  weather members (ensemble forecast, or past years on the same dates)
 *   × counterfactual scenario (rain ×, +mm/h, longer storm, +°C, gusts ×, flood)
 *   → per-stop impact probability  (Beta posteriors per weather bin — learned)
 *   → sampled disruptions → heal() cascade (later stops shift, drops, locked
 *     bookings at risk) → classifyRisk (AUTO / TRAVELLER / OPERATOR cards)
 *   → probabilities, expectations and p10/p90 bands with the sample size.
 *
 * Thresholds are cited, not invented: rain-rate classes follow the AMS/WMO
 * intensity classes; heat classes are the NWS heat-index bands already used by
 * the pacing auditor; gust classes are Beaufort 7 and 9. The probabilities
 * attached to each class start as weak priors and are updated from observed
 * outcomes (reported vs quiet visits) — `n` says how much data backs each one.
 */
import { HEAT_CAUTION_C, HEAT_DANGER_C, HEAT_EXTREME_CAUTION_C } from "./auditors/pacing.ts";
import { estimateLeg } from "./geo.ts";
import { heal, type Disruption, type HealingPolicy } from "./reducer.ts";
import { classifyRisk, DEFAULT_AUTONOMY, type AutonomyPolicy, type RiskTier } from "./risk.ts";
import type { DaySchedule, ItineraryNode } from "./schemas.ts";
import { MINUTES_PER_DAY, toMinutes } from "./time.ts";

export interface HourWeather {
  /** Local hour 0–23. */
  hour: number;
  precipMm: number;
  apparentC?: number | null;
  gustKmh?: number | null;
}

export interface WeatherMember {
  id: string;
  hours: HourWeather[];
}

export interface Scenario {
  /** Multiply rainfall (1 = as forecast). */
  precipScale: number;
  /** Add mm/h to every hour that already has rain (a heavier storm). */
  precipAddMm: number;
  /** Extend every rainy spell by this many hours (a longer storm). */
  durationExtendH: number;
  /** Shift temperatures (extreme heat / cold snap). */
  tempOffsetC: number;
  /** Multiply wind gusts. */
  gustScale: number;
  /** Flooding: roads slow sharply and outdoor visits behave as in violent rain. */
  flood: boolean;
  /** A what-if storm (precipAddMm > 0) also breaks at this local hour for 2 h + durationExtendH, on top of any forecast rain. */
  stormStartHour?: number;
}

export const BASELINE: Scenario = { precipScale: 1, precipAddMm: 0, durationExtendH: 0, tempOffsetC: 0, gustScale: 1, flood: false };

// ── Weather classes (cited) ──────────────────────────────────────────
/** AMS Glossary / WMO rain-rate classes (mm/h). */
export const RAIN_CLASSES = [
  { key: "rain:none", min: 0, label: "dry (< 0.2 mm/h)" },
  { key: "rain:light", min: 0.2, label: "light (< 2.5 mm/h)" },
  { key: "rain:moderate", min: 2.5, label: "moderate (2.5–7.6 mm/h)" },
  { key: "rain:heavy", min: 7.6, label: "heavy (7.6–50 mm/h)" },
  { key: "rain:violent", min: 50, label: "violent (≥ 50 mm/h)" },
] as const;
/** NWS heat-index bands (apparent temperature), shared with auditors/pacing.ts. */
export const HEAT_CLASSES = [
  { key: "heat:caution", min: HEAT_CAUTION_C, label: `caution (≥ ${Math.round(HEAT_CAUTION_C)}°C feels-like)` },
  { key: "heat:extreme", min: HEAT_EXTREME_CAUTION_C, label: `extreme caution (≥ ${Math.round(HEAT_EXTREME_CAUTION_C)}°C)` },
  { key: "heat:danger", min: HEAT_DANGER_C, label: `danger (≥ ${Math.round(HEAT_DANGER_C)}°C)` },
] as const;
/** Beaufort 7 (near gale) and 9 (strong gale) gusts, km/h. */
export const GUST_CLASSES = [
  { key: "gust:gale", min: 50, label: "near gale gusts (≥ 50 km/h)" },
  { key: "gust:strong", min: 75, label: "strong gale gusts (≥ 75 km/h)" },
] as const;

export type ImpactKey = (typeof RAIN_CLASSES)[number]["key"] | (typeof HEAT_CLASSES)[number]["key"] | (typeof GUST_CLASSES)[number]["key"];

export interface Belief {
  /** Beta(a, b): P(an outdoor visit in this class gets disrupted). */
  a: number;
  b: number;
  /** Real observations folded in (0 = prior only). */
  n: number;
}
export type ImpactModel = Record<ImpactKey, Belief>;

/** Weak priors (equivalent to a handful of cases) so a few real observations move them. */
export function priorModel(): ImpactModel {
  return {
    "rain:none": { a: 0.5, b: 20, n: 0 },
    "rain:light": { a: 1, b: 6, n: 0 },
    "rain:moderate": { a: 3, b: 4, n: 0 },
    "rain:heavy": { a: 6, b: 2, n: 0 },
    "rain:violent": { a: 9, b: 1, n: 0 },
    "heat:caution": { a: 1, b: 9, n: 0 },
    "heat:extreme": { a: 3, b: 5, n: 0 },
    "heat:danger": { a: 7, b: 2, n: 0 },
    "gust:gale": { a: 3, b: 5, n: 0 },
    "gust:strong": { a: 7, b: 2, n: 0 },
  };
}

export const mean = (b: Belief) => b.a / (b.a + b.b);

/** Folds one observed outcome into the model (conjugate Beta update). */
export function observe(model: ImpactModel, key: ImpactKey, disrupted: boolean): ImpactModel {
  const cur = model[key];
  return { ...model, [key]: { a: cur.a + (disrupted ? 1 : 0), b: cur.b + (disrupted ? 0 : 1), n: cur.n + 1 } };
}

export function rainClass(mmPerHour: number): ImpactKey {
  let key: ImpactKey = "rain:none";
  for (const c of RAIN_CLASSES) if (mmPerHour >= c.min) key = c.key;
  return key;
}
export function heatClass(apparentC: number | null | undefined): ImpactKey | null {
  if (typeof apparentC !== "number") return null;
  let key: ImpactKey | null = null;
  for (const c of HEAT_CLASSES) if (apparentC >= c.min) key = c.key;
  return key;
}
export function gustClass(kmh: number | null | undefined): ImpactKey | null {
  if (typeof kmh !== "number") return null;
  let key: ImpactKey | null = null;
  for (const c of GUST_CLASSES) if (kmh >= c.min) key = c.key;
  return key;
}

// ── Counterfactual weather ───────────────────────────────────────────
export const DEFAULT_STORM_HOUR = 14;
const STORM_BASE_HOURS = 2;

export function applyScenario(member: WeatherMember, s: Scenario): WeatherMember {
  const rainy = new Set(member.hours.filter((h) => h.precipMm >= 0.2).map((h) => h.hour));
  // A what-if storm always breaks at the chosen hour (a dry or drizzly forecast would otherwise absorb it).
  const imposed = new Set<number>();
  if (s.precipAddMm > 0) {
    const start = Math.min(23, Math.max(0, Math.round(s.stormStartHour ?? DEFAULT_STORM_HOUR)));
    for (let k = 0; k < STORM_BASE_HOURS; k++) if (start + k < 24) imposed.add(start + k);
  }
  const extended = new Set(rainy);
  for (const h of imposed) extended.add(h);
  for (const h of [...rainy, ...imposed]) for (let k = 1; k <= Math.max(0, Math.round(s.durationExtendH)); k++) extended.add(h + k);
  const avgRain = rainy.size ? member.hours.filter((h) => rainy.has(h.hour)).reduce((n, h) => n + h.precipMm, 0) / rainy.size : 0;
  return {
    id: member.id,
    hours: member.hours.map((h) => {
      const base = rainy.has(h.hour) ? h.precipMm : extended.has(h.hour) ? avgRain : h.precipMm;
      const wet = base >= 0.2 || extended.has(h.hour);
      return {
        hour: h.hour,
        precipMm: Math.max(0, base * s.precipScale + (wet ? s.precipAddMm : 0)),
        apparentC: typeof h.apparentC === "number" ? h.apparentC + s.tempOffsetC : h.apparentC,
        gustKmh: typeof h.gustKmh === "number" ? h.gustKmh * s.gustScale : h.gustKmh,
      };
    }),
  };
}

// ── Simulation ───────────────────────────────────────────────────────
/** Road slowdown in rain: +3% per mm/h, capped at +60%; ×2 in a flood. A prior, shown as such. */
export const RAIN_SLOWDOWN_PER_MM = 0.03;
export const RAIN_SLOWDOWN_CAP = 1.6;
export const FLOOD_SLOWDOWN = 2;

export interface StopImpact {
  nodeId: string;
  title: string;
  isOutdoor: boolean;
  locked: boolean;
  /** Worst weather during the visit, median across members. */
  weather: string;
  pDisrupted: number;
  pDropped: number;
  meanShiftMin: number;
  p90ShiftMin: number;
  /** Which beliefs drove it and how much data backs them. */
  drivers: { key: ImpactKey | "social"; p: number; n: number }[];
}

export interface CascadeEdge {
  from: string; // "weather" or a nodeId
  to: string; // nodeId
  kind: "disrupts" | "delays" | "drops";
  weight: number; // probability (disrupts/drops) or mean minutes (delays)
}

export interface DayTwin {
  dayIndex: number;
  runs: number;
  members: number;
  stops: StopImpact[];
  edges: CascadeEdge[];
  pAnyChange: number;
  expectedCards: Record<RiskTier, number>;
  pOperator: number;
  minutesLost: { mean: number; p10: number; p90: number };
  travelSlowdown: { mean: number; max: number };
  /** Per local hour: expected number of visits displaced (feeds venue-demand and ops-workload views). */
  displacedByHour: number[];
}

export interface TwinOptions {
  model: ImpactModel;
  scenario?: Scenario;
  samplesPerMember?: number;
  seed?: number;
  autonomy?: AutonomyPolicy;
  /** Live social evidence (0..1) that outdoor plans are being disrupted right now; combined as an independent hazard. */
  social?: { hazard: number; posts: number };
  policy?: Partial<HealingPolicy>;
}

/** Deterministic PRNG so the same inputs give the same twin (and tests are stable). */
export function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const quantile = (xs: number[], q: number) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))];
};

function visitHours(n: ItineraryNode): number[] {
  const start = toMinutes(n.timeSlot.start);
  const end = Math.min(MINUTES_PER_DAY, start + n.timeSlot.durationMinutes);
  const out: number[] = [];
  for (let h = Math.floor(start / 60); h * 60 < end && h < 24; h++) out.push(h);
  return out;
}

/** Probability an outdoor visit is disrupted under one weather member, and why. */
export function visitRisk(n: ItineraryNode, member: WeatherMember, model: ImpactModel, flood: boolean) {
  const hrs = visitHours(n).map((h) => member.hours.find((x) => x.hour === h)).filter((x): x is HourWeather => !!x);
  const rain = Math.max(0, ...hrs.map((h) => h.precipMm));
  const heat = Math.max(-99, ...hrs.map((h) => (typeof h.apparentC === "number" ? h.apparentC : -99)));
  const gust = Math.max(0, ...hrs.map((h) => (typeof h.gustKmh === "number" ? h.gustKmh : 0)));
  const keys: ImpactKey[] = [flood ? "rain:violent" : rainClass(rain)];
  const hk = heatClass(heat);
  if (hk) keys.push(hk);
  const gk = gustClass(gust);
  if (gk) keys.push(gk);
  const drivers = keys.map((key) => ({ key, p: mean(model[key]), n: model[key].n }));
  // Independent hazards: P(any) = 1 − Π(1 − p). Indoor visits only feel the travel slowdown.
  const p = n.isOutdoor ? 1 - drivers.reduce((q, d) => q * (1 - d.p), 1) : 0;
  const label = [flood ? "flooding" : RAIN_CLASSES.find((c) => c.key === keys[0])?.label, hk && HEAT_CLASSES.find((c) => c.key === hk)?.label, gk && GUST_CLASSES.find((c) => c.key === gk)?.label]
    .filter(Boolean)
    .join(", ");
  return { p, drivers, rain, label };
}

export function simulateDay(day: DaySchedule, members: readonly WeatherMember[], opts: TwinOptions): DayTwin {
  const scenario = opts.scenario ?? BASELINE;
  const rng = mulberry32(opts.seed ?? 42);
  const perMember = Math.max(1, opts.samplesPerMember ?? 4);
  const nodes = [...day.nodes].sort((a, b) => toMinutes(a.timeSlot.start) - toMinutes(b.timeSlot.start));
  const base = new Map(nodes.map((n) => [n.id, toMinutes(n.timeSlot.start)]));
  const disrupted = new Map(nodes.map((n) => [n.id, 0]));
  const dropped = new Map(nodes.map((n) => [n.id, 0]));
  const shifts = new Map(nodes.map((n) => [n.id, [] as number[]]));
  const delayEdges = new Map<string, number>();
  const dropEdges = new Map<string, number>();
  const cards: Record<RiskTier, number> = { AUTO: 0, TRAVELLER: 0, OPERATOR: 0 };
  let anyChange = 0;
  let operatorRuns = 0;
  const lost: number[] = [];
  const slow: number[] = [];
  const displaced = new Array(24).fill(0);
  const labels = new Map(nodes.map((n) => [n.id, [] as string[]]));
  const driverSum = new Map<string, Map<ImpactKey | "social", { p: number; n: number; c: number }>>();
  let runs = 0;

  const scenarioMembers = members.map((m) => applyScenario(m, scenario));
  for (const member of scenarioMembers) {
    const social = Math.min(0.9, Math.max(0, opts.social?.hazard ?? 0));
    const risks = new Map(
      nodes.map((n) => {
        const r = visitRisk(n, member, opts.model, scenario.flood);
        if (!n.isOutdoor || social === 0) return [n.id, r];
        return [n.id, { ...r, p: 1 - (1 - r.p) * (1 - social), drivers: [...r.drivers, { key: "social" as const, p: social, n: opts.social?.posts ?? 0 }] }];
      }),
    );
    for (const n of nodes) {
      const r = risks.get(n.id)!;
      labels.get(n.id)!.push(r.label);
      const m = driverSum.get(n.id) ?? new Map<ImpactKey | "social", { p: number; n: number; c: number }>();
      for (const d of r.drivers) {
        const cur = m.get(d.key) ?? { p: 0, n: d.n, c: 0 };
        m.set(d.key, { p: cur.p + d.p, n: d.n, c: cur.c + 1 });
      }
      driverSum.set(n.id, m);
    }
    for (let s = 0; s < perMember; s++) {
      runs++;
      let cur: DaySchedule = structuredClone(day);
      const hitIds = nodes.filter((n) => rng() < risks.get(n.id)!.p).map((n) => n.id);
      for (const id of hitIds) disrupted.set(id, disrupted.get(id)! + 1);

      // Travel legs in rain/flood: slower roads, pushed downstream as a delay on the stop they lead to.
      let extra = 0;
      let firstLate: string | null = null;
      for (let i = 1; i < nodes.length; i++) {
        const prev = nodes[i - 1];
        const next = nodes[i];
        const seg = day.transitSegments?.find((t) => t.fromNodeId === prev.id && t.toNodeId === next.id);
        const legMin = seg?.durationMinutes ?? estimateLeg(prev.location, next.location).durationMinutes;
        const hour = Math.floor((toMinutes(prev.timeSlot.start) + prev.timeSlot.durationMinutes) / 60);
        const mm = member.hours.find((h) => h.hour === hour)?.precipMm ?? 0;
        const mult = scenario.flood ? FLOOD_SLOWDOWN : Math.min(RAIN_SLOWDOWN_CAP, 1 + RAIN_SLOWDOWN_PER_MM * mm);
        slow.push(mult);
        const add = legMin * (mult - 1);
        if (add >= 1 && !firstLate) firstLate = next.id;
        extra += add;
      }

      const allPatches: Parameters<typeof classifyRisk>[1][number][] = [];
      const allConflicts: Parameters<typeof classifyRisk>[2][number][] = [];
      const run = (d: Disruption, source: string) => {
        try {
          const r = heal(cur, d, { policy: opts.policy });
          allPatches.push(...r.patches);
          allConflicts.push(...r.conflicts);
          const before = new Map(cur.nodes.map((n) => [n.id, toMinutes(n.timeSlot.start)]));
          for (const n of r.preview.nodes) {
            const was = before.get(n.id);
            if (was !== undefined && n.id !== source && toMinutes(n.timeSlot.start) !== was) delayEdges.set(`${source}>${n.id}`, (delayEdges.get(`${source}>${n.id}`) ?? 0) + Math.abs(toMinutes(n.timeSlot.start) - was));
          }
          for (const id of before.keys()) if (!r.preview.nodes.some((n) => n.id === id)) dropEdges.set(`${source}>${id}`, (dropEdges.get(`${source}>${id}`) ?? 0) + 1);
          cur = r.preview;
        } catch {
          /* an infeasible cascade is itself a signal: counted via drops below */
        }
      };
      const lateMinutes = Math.round(extra);
      if (firstLate && lateMinutes >= 5) run({ kind: "DELAY", nodeId: firstLate, delayMinutes: lateMinutes, reason: "Twin: slower roads in rain" }, "weather");
      for (const id of hitIds) {
        const n = cur.nodes.find((x) => x.id === id);
        if (!n) continue;
        const from = toMinutes(n.timeSlot.start);
        run({ kind: "WEATHER", fromMinute: from, toMinute: Math.min(MINUTES_PER_DAY, from + n.timeSlot.durationMinutes), reason: "Twin: weather at this stop" }, id);
      }

      const after = new Map(cur.nodes.map((n) => [n.id, toMinutes(n.timeSlot.start)]));
      let runLost = 0;
      for (const n of nodes) {
        const a = after.get(n.id);
        if (a === undefined) {
          dropped.set(n.id, dropped.get(n.id)! + 1);
          runLost += n.timeSlot.durationMinutes;
          const h = Math.min(23, Math.floor(base.get(n.id)! / 60));
          displaced[h] += 1;
        } else {
          const shift = Math.abs(a - base.get(n.id)!);
          shifts.get(n.id)!.push(shift);
          runLost += Math.max(0, n.timeSlot.durationMinutes - (cur.nodes.find((x) => x.id === n.id)?.timeSlot.durationMinutes ?? n.timeSlot.durationMinutes));
        }
      }
      lost.push(runLost);
      if (allPatches.length) {
        anyChange++;
        const tier = classifyRisk(day, allPatches, allConflicts, opts.autonomy ?? DEFAULT_AUTONOMY).tier;
        cards[tier]++;
        if (tier === "OPERATOR") operatorRuns++;
      }
    }
  }

  const stops: StopImpact[] = nodes.map((n) => {
    const sh = shifts.get(n.id)!;
    const ls = labels.get(n.id)!;
    const ds = [...(driverSum.get(n.id)?.entries() ?? [])].map(([key, v]) => ({ key, p: Math.round((v.p / v.c) * 100) / 100, n: v.n }));
    return {
      nodeId: n.id,
      title: n.title,
      isOutdoor: n.isOutdoor,
      locked: n.type === "HARD",
      weather: ls.sort()[Math.floor(ls.length / 2)] ?? "",
      pDisrupted: runs ? disrupted.get(n.id)! / runs : 0,
      pDropped: runs ? dropped.get(n.id)! / runs : 0,
      meanShiftMin: sh.length ? Math.round(sh.reduce((a, b) => a + b, 0) / sh.length) : 0,
      p90ShiftMin: quantile(sh, 0.9),
      drivers: ds,
    };
  });
  const edges: CascadeEdge[] = [
    ...stops.filter((s) => s.pDisrupted > 0).map((s) => ({ from: "weather", to: s.nodeId, kind: "disrupts" as const, weight: Math.round(s.pDisrupted * 100) / 100 })),
    ...[...delayEdges.entries()].map(([k, v]) => {
      const [from, to] = k.split(">");
      return { from, to, kind: "delays" as const, weight: Math.round(v / runs) };
    }),
    ...[...dropEdges.entries()].map(([k, v]) => {
      const [from, to] = k.split(">");
      return { from, to, kind: "drops" as const, weight: Math.round((v / runs) * 100) / 100 };
    }),
  ].filter((e) => e.weight > 0);
  return {
    dayIndex: day.dayIndex,
    runs,
    members: members.length,
    stops,
    edges,
    pAnyChange: runs ? anyChange / runs : 0,
    expectedCards: { AUTO: runs ? cards.AUTO / runs : 0, TRAVELLER: runs ? cards.TRAVELLER / runs : 0, OPERATOR: runs ? cards.OPERATOR / runs : 0 },
    pOperator: runs ? operatorRuns / runs : 0,
    minutesLost: { mean: lost.length ? Math.round(lost.reduce((a, b) => a + b, 0) / lost.length) : 0, p10: quantile(lost, 0.1), p90: quantile(lost, 0.9) },
    travelSlowdown: { mean: slow.length ? Math.round((slow.reduce((a, b) => a + b, 0) / slow.length) * 100) / 100 : 1, max: slow.length ? Math.round(Math.max(...slow) * 100) / 100 : 1 },
    displacedByHour: displaced.map((v) => Math.round((v / Math.max(1, runs)) * 100) / 100),
  };
}
