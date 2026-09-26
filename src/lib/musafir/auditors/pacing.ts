/**
 * Pacing & Fatigue Auditor. Pure code: the caller passes in any sensor data
 * (hourly Open-Meteo conditions, node elevations); nothing is fetched here.
 *
 * Checks, in order:
 *  1. DAILY_FATIGUE — the day's transit fatigue score (geo.ts) against limits
 *     that loosen as the Pacing fader rises.
 *  2. NO_REST — time on your feet (visits + walking legs) without a break.
 *     A meal, a hotel stop or an idle gap of REST_GAP_MINUTES resets it. Suggests
 *     where a rest buffer would go.
 *  3. TOO_MANY_STOPS — more sights than the Pacing fader asked for (planner.ts planShape).
 *  4. HEAT — outdoor stops during high apparent temperature. Bands are the US
 *     National Weather Service heat-index categories
 *     (https://www.weather.gov/ama/heatindex, checked 2026-09-26): caution 80 °F,
 *     extreme caution 90 °F, danger 103 °F. Open-Meteo's apparent temperature is
 *     not the NWS heat index, so messages say "feels like", not "heat index".
 *  5. UV — outdoor stops during a high UV index. WHO categories
 *     (https://www.who.int/news-room/questions-and-answers/item/radiation-the-ultraviolet-(uv)-index,
 *     checked 2026-09-26): high 6–7, very high 8–10, extreme 11+.
 *  6. ALTITUDE / STEEP_WALK — CDC Yellow Book (https://www.cdc.gov/yellow-book/hcp/environmental-hazards-risks/high-altitude-travel-and-altitude-illness.html,
 *     checked 2026-09-26): altitude illness risk above 2,500 m (8,000 ft); avoid
 *     going from low elevation to above 2,750 m (9,000 ft) in one day.
 *
 * Thresholds marked "product policy" are tunable choices, not facts.
 */
import type { AuditFinding } from "./finding.ts";
import { dailyFatigueScore, rebuildTransitSegments } from "../geo.ts";
import { planShape } from "../planner.ts";
import type { DaySchedule, ItineraryNode, TransitSegment, VibeConfig } from "../schemas.ts";
import { MINUTES_PER_DAY, toMinutes } from "../time.ts";

// ── product policy ─────────────────────────────────────────────────
/** Daily fatigue score that earns a warning at Pacing 0; rises to +25 at Pacing 1. */
export const FATIGUE_WARN_BASE = 55;
export const FATIGUE_WARN_PACING_SPAN = 25;
/** An alert sits this far above the warning level. */
export const FATIGUE_ALERT_MARGIN = 15;
/** Longest stretch on your feet before suggesting a break: 150 min at Pacing 0, 300 at Pacing 1. */
export const MAX_ACTIVE_BASE_MIN = 150;
export const MAX_ACTIVE_PACING_SPAN_MIN = 150;
/** An idle gap at least this long counts as a rest. */
export const REST_GAP_MINUTES = 20;
/** Length of the rest buffer suggested when a stretch runs too long. */
export const REST_BREAK_MINUTES = 20;
/** Sights allowed above the fader's stops-per-day before warning. */
export const TOO_MANY_STOPS_SLACK = 1;
/** A walking leg that climbs at least this much gets a heads-up. */
export const STEEP_WALK_CLIMB_M = 100;
const DEFAULT_PACING = 0.5;

// ── sourced thresholds ─────────────────────────────────────────────
const fToC = (f: number) => ((f - 32) * 5) / 9;
/** NWS heat-index bands, converted to °C. */
export const HEAT_CAUTION_C = fToC(80);
export const HEAT_EXTREME_CAUTION_C = fToC(90);
export const HEAT_DANGER_C = fToC(103);
/** WHO UV index categories. */
export const UV_HIGH = 6;
export const UV_VERY_HIGH = 8;
export const UV_EXTREME = 11;
/** CDC altitude guidance. */
export const ALTITUDE_RISK_M = 2500;
export const ALTITUDE_SAME_DAY_MAX_M = 2750;

export interface HourlyConditions {
  /** Local hour of the day's date, 0–23 (Open-Meteo with timezone=auto). */
  hour: number;
  apparentTemperatureC?: number | null;
  uvIndex?: number | null;
}

export interface PacingInput {
  day: DaySchedule;
  vibe?: Pick<VibeConfig, "pacing">;
  weather?: readonly HourlyConditions[];
  /** Metres above sea level per node id (e.g. Open-Meteo elevation API). */
  elevationsM?: Readonly<Record<string, number>>;
}

export type PacingCode = "DAILY_FATIGUE" | "NO_REST" | "TOO_MANY_STOPS" | "HEAT" | "UV" | "ALTITUDE" | "STEEP_WALK";

export interface RestSuggestion {
  afterNodeId: string;
  minutes: number;
}

export interface PacingReport {
  findings: AuditFinding<PacingCode>[];
  restBreaks: RestSuggestion[];
  dailyFatigueScore: number;
  longestActiveStretchMinutes: number;
}

const RESTFUL: ReadonlySet<ItineraryNode["category"]> = new Set(["DINING", "ACCOMMODATION"]);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

function orderedNodes(day: DaySchedule): ItineraryNode[] {
  return day.nodes.map((n, i) => ({ n, i, s: toMinutes(n.timeSlot.start) })).sort((a, b) => a.s - b.s || a.i - b.i).map((x) => x.n);
}

function conditionsByHour(weather: readonly HourlyConditions[]): Map<number, HourlyConditions> {
  const map = new Map<number, HourlyConditions>();
  for (const w of weather) {
    if (!Number.isInteger(w.hour) || w.hour < 0 || w.hour > 23) throw new RangeError(`Invalid weather hour ${w.hour}`);
    map.set(w.hour, w);
  }
  return map;
}

function hoursOf(node: ItineraryNode): number[] {
  const start = toMinutes(node.timeSlot.start);
  const end = Math.min(MINUTES_PER_DAY, start + node.timeSlot.durationMinutes);
  const out: number[] = [];
  for (let h = Math.floor(start / 60); h * 60 < end; h++) out.push(h);
  return out;
}

function maxOf(values: (number | null | undefined)[]): number | null {
  const finite = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return finite.length ? Math.max(...finite) : null;
}

export function auditPacing(input: PacingInput): PacingReport {
  const pacing = clamp01(input.vibe?.pacing ?? DEFAULT_PACING);
  const nodes = orderedNodes(input.day);
  const segments: TransitSegment[] = rebuildTransitSegments(nodes, input.day.transitSegments);
  const findings: AuditFinding<PacingCode>[] = [];
  const restBreaks: RestSuggestion[] = [];

  // 1. Daily fatigue
  const fatigue = dailyFatigueScore(segments);
  const warnAt = FATIGUE_WARN_BASE + FATIGUE_WARN_PACING_SPAN * pacing;
  const alertAt = Math.min(100, warnAt + FATIGUE_ALERT_MARGIN);
  if (fatigue >= alertAt) {
    findings.push({ code: "DAILY_FATIGUE", severity: "ALERT", message: `Travel load today is ${fatigue}/100, heavy for your pace. Clustering stops closer together would help.` });
  } else if (fatigue >= warnAt) {
    findings.push({ code: "DAILY_FATIGUE", severity: "WARN", message: `Travel load today is ${fatigue}/100, on the heavy side for your pace.` });
  }

  // 2. Time on your feet without a break
  const maxActive = MAX_ACTIVE_BASE_MIN + MAX_ACTIVE_PACING_SPAN_MIN * pacing;
  let active = 0;
  let longest = 0;
  let flagged = false;
  let prevEnd: number | null = null;
  nodes.forEach((node, i) => {
    const start = toMinutes(node.timeSlot.start);
    const leg = i > 0 ? segments[i - 1] : undefined;
    if (prevEnd !== null) {
      const idle = start - (prevEnd + (leg?.durationMinutes ?? 0));
      if (idle >= REST_GAP_MINUTES) {
        active = 0;
        flagged = false;
      }
    }
    if (leg?.mode === "WALK") active += leg.durationMinutes;
    if (RESTFUL.has(node.category)) {
      active = 0;
      flagged = false;
    } else if (node.category !== "TRANSIT") {
      active += node.timeSlot.durationMinutes;
    }
    longest = Math.max(longest, active);
    if (active > maxActive && !flagged) {
      flagged = true;
      const before = i > 0 ? nodes[i - 1] : node;
      restBreaks.push({ afterNodeId: before.id, minutes: REST_BREAK_MINUTES });
      findings.push({
        code: "NO_REST",
        severity: "WARN",
        nodeId: node.id,
        message: `About ${Math.round(active / 6) / 10} h on your feet by the end of ${node.title}. A ${REST_BREAK_MINUTES}-min break after ${before.title} would help.`,
      });
    }
    prevEnd = start + node.timeSlot.durationMinutes;
  });

  // 3. More sights than the fader asked for
  if (input.vibe) {
    const sights = nodes.filter((n) => !RESTFUL.has(n.category) && n.category !== "TRANSIT").length;
    const wanted = planShape({ pacing, budget: 0.5, culturalDepth: 0.5, circadian: 0.5 }).stopsPerDay;
    if (sights > wanted + TOO_MANY_STOPS_SLACK) {
      findings.push({ code: "TOO_MANY_STOPS", severity: "WARN", message: `${sights} sights today; your pace suits about ${wanted}. Moving one to another day keeps it relaxed.` });
    }
  }

  // 4–5. Heat and UV for outdoor stops
  if (input.weather?.length) {
    const byHour = conditionsByHour(input.weather);
    for (const node of nodes.filter((n) => n.isOutdoor)) {
      const hours = hoursOf(node).map((h) => byHour.get(h));
      const feels = maxOf(hours.map((c) => c?.apparentTemperatureC));
      if (feels !== null && feels >= HEAT_CAUTION_C) {
        const [severity, band]: [AuditFinding["severity"], string] =
          feels >= HEAT_DANGER_C ? ["ALERT", "danger"] : feels >= HEAT_EXTREME_CAUTION_C ? ["WARN", "extreme caution"] : ["INFO", "caution"];
        findings.push({
          code: "HEAT",
          severity,
          nodeId: node.id,
          message: `Feels like ${round1(feels)}°C during ${node.title} (NWS "${band}" band). Shade and water, or an earlier or later slot, would help.`,
        });
      }
      const uv = maxOf(hours.map((c) => c?.uvIndex));
      if (uv !== null && uv >= UV_HIGH) {
        const [severity, band]: [AuditFinding["severity"], string] =
          uv >= UV_EXTREME ? ["ALERT", "extreme"] : uv >= UV_VERY_HIGH ? ["WARN", "very high"] : ["INFO", "high"];
        findings.push({ code: "UV", severity, nodeId: node.id, message: `UV index ${round1(uv)} (${band}) during ${node.title}. Hat, sunglasses and sunscreen.` });
      }
    }
  }

  // 6. Altitude and steep walks
  if (input.elevationsM) {
    const elev = (id: string) => {
      const v = input.elevationsM?.[id];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    const known = nodes.map((n) => ({ n, e: elev(n.id) })).filter((x): x is { n: ItineraryNode; e: number } => x.e !== null);
    if (known.length) {
      const high = known.find((x) => x.e >= ALTITUDE_RISK_M);
      const lowest = Math.min(...known.map((x) => x.e));
      const highest = known.reduce((a, b) => (b.e > a.e ? b : a));
      if (lowest < ALTITUDE_RISK_M && highest.e > ALTITUDE_SAME_DAY_MAX_M) {
        findings.push({
          code: "ALTITUDE",
          severity: "ALERT",
          nodeId: highest.n.id,
          message: `Today climbs from ${Math.round(lowest)} m to ${Math.round(highest.e)} m. CDC advises against going from low elevation to above ${ALTITUDE_SAME_DAY_MAX_M} m in one day.`,
        });
      } else if (high) {
        findings.push({
          code: "ALTITUDE",
          severity: "WARN",
          nodeId: high.n.id,
          message: `${high.n.title} is at ${Math.round(high.e)} m, where altitude illness is possible (CDC: above ${ALTITUDE_RISK_M} m). Go slowly and skip heavy exertion at first.`,
        });
      }
    }
    segments.forEach((s, i) => {
      if (s.mode !== "WALK") return;
      const from = elev(nodes[i].id);
      const to = elev(nodes[i + 1].id);
      if (from === null || to === null || to - from < STEEP_WALK_CLIMB_M) return;
      findings.push({ code: "STEEP_WALK", severity: "INFO", nodeId: nodes[i + 1].id, message: `The walk to ${nodes[i + 1].title} climbs about ${Math.round(to - from)} m.` });
    });
  }

  return { findings, restBreaks, dailyFatigueScore: fatigue, longestActiveStretchMinutes: longest };
}
