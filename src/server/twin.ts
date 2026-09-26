/**
 * Digital Twin service. Builds a virtual copy of trips from the live store,
 * feeds it ensemble weather + social signals, and simulates baseline and
 * what-if futures with the real self-healing engine (lib/musafir/twin.ts).
 * Read-only by construction: it clones data and never calls write/publish,
 * so the actual system is never affected.
 *
 * Learning: the impact model starts from cited-class priors and folds in every
 * past outdoor visit in the database — reported weather disruptions (positive)
 * and visits that saw that weather with no report (negative), using the
 * weather actually observed there (Open-Meteo archive).
 */
import { haversineMeters } from "@/lib/musafir/geo.ts";
import { policyFromVibe } from "@/lib/musafir/reducer.ts";
import type { DaySchedule, ItineraryNode } from "@/lib/musafir/schemas.ts";
import { MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";
import {
  BASELINE,
  gustClass,
  heatClass,
  mean,
  observe,
  priorModel,
  rainClass,
  simulateDay,
  type DayTwin,
  type ImpactKey,
  type ImpactModel,
  type Scenario,
  type WeatherMember,
} from "@/lib/musafir/twin.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { socialSignals, type SocialReport } from "./social.ts";
import { read } from "./store.ts";
import { getTripBundle } from "./trips.ts";
import { currentWeather, observedDay, weatherMembers, type CurrentWeather, type MemberSet } from "./twin-weather.ts";

const MODEL_TTL_MS = 10 * 60_000;
const MAX_LEARNING_DAYS = 25;
const MAX_TRIP_DAYS = 5;
/** Social posts describe *now*: they only weigh on days within this many days. */
const SOCIAL_HORIZON_DAYS = 2;
/** Aim for about this many simulated futures per day, whatever the ensemble size. */
const TARGET_RUNS = 60;

const g = globalThis as typeof globalThis & { __musafirTwinModel?: { at: number; value: LearnedModel } };

export interface LearnedModel {
  model: ImpactModel;
  observations: number;
  positives: number;
  daysUsed: number;
  basis: string;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);
const centerOf = (nodes: readonly ItineraryNode[]) => ({
  lat: nodes.reduce((n, x) => n + x.location.lat, 0) / nodes.length,
  lng: nodes.reduce((n, x) => n + x.location.lng, 0) / nodes.length,
});

function worstDuring(n: ItineraryNode, m: WeatherMember) {
  const start = toMinutes(n.timeSlot.start);
  const end = Math.min(MINUTES_PER_DAY, start + n.timeSlot.durationMinutes);
  const hrs = m.hours.filter((h) => h.hour * 60 < end && (h.hour + 1) * 60 > start);
  return {
    rain: Math.max(0, ...hrs.map((h) => h.precipMm)),
    heat: Math.max(-99, ...hrs.map((h) => h.apparentC ?? -99)),
    gust: Math.max(0, ...hrs.map((h) => h.gustKmh ?? 0)),
  };
}

export async function learnedModel(): Promise<LearnedModel> {
  const hit = g.__musafirTwinModel;
  if (hit && Date.now() - hit.at < MODEL_TTL_MS) return hit.value;
  const { days, reports } = await read((db) => {
    const past = db.trips.flatMap((t) =>
      t.trip.schedule.filter((d) => daysFromToday(d.date) < 0 && d.nodes.some((n) => n.isOutdoor)).map((d) => ({ tripId: t.trip.id, day: structuredClone(d) })),
    );
    const weatherReports = db.proposals
      .filter((p) => p.disruption.kind === "WEATHER")
      .map((p) => ({ tripId: p.tripId, dayIndex: p.dayIndex, affected: new Set(p.affectedNodeIds) }));
    return { days: past.sort((a, b) => b.day.date.localeCompare(a.day.date)).slice(0, MAX_LEARNING_DAYS), reports: weatherReports };
  });
  let model = priorModel();
  let observations = 0;
  let positives = 0;
  let daysUsed = 0;
  for (const { tripId, day } of days) {
    const c = centerOf(day.nodes);
    const obs = await observedDay(c.lat, c.lng, day.date).catch(() => null);
    if (!obs) continue;
    daysUsed++;
    for (const n of day.nodes.filter((x) => x.isOutdoor)) {
      const w = worstDuring(n, obs);
      const disrupted = reports.some((r) => r.tripId === tripId && r.dayIndex === day.dayIndex && r.affected.has(n.id));
      const keys: ImpactKey[] = [rainClass(w.rain)];
      const hk = heatClass(w.heat);
      if (hk) keys.push(hk);
      const gk = gustClass(w.gust);
      if (gk) keys.push(gk);
      for (const k of keys) model = observe(model, k, disrupted);
      observations++;
      if (disrupted) positives++;
    }
  }
  const value: LearnedModel = {
    model,
    observations,
    positives,
    daysUsed,
    basis: observations
      ? `priors updated with ${observations} past outdoor visits on ${daysUsed} days (${positives} reported disruptions), weather as observed`
      : "priors only — no past trip days yet to learn from",
  };
  g.__musafirTwinModel = { at: Date.now(), value };
  return value;
}

export function modelSummary(m: ImpactModel) {
  return (Object.keys(m) as ImpactKey[]).map((k) => ({ key: k, p: Math.round(mean(m[k]) * 100) / 100, n: m[k].n }));
}

export interface DayTwinView {
  dayIndex: number;
  date: string;
  city: string;
  center: { lat: number; lng: number };
  weather: { basis: string; source: MemberSet["source"]; members: number; peakRainMm: { median: number; p90: number }; maxFeelsLikeC: number | null; hourlyRainMedian: number[] };
  socialWeight: number;
  baseline: DayTwin;
  scenario: DayTwin | null;
  stops: { id: string; title: string; lat: number; lng: number; start: string; isOutdoor: boolean; locked: boolean }[];
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const q90 = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.9 * (s.length - 1) + 0.5))];
};

function weatherSummary(set: MemberSet): DayTwinView["weather"] {
  const peaks = set.members.map((m) => Math.max(0, ...m.hours.map((h) => h.precipMm)));
  const feels = set.members.flatMap((m) => m.hours.map((h) => h.apparentC).filter((v): v is number => typeof v === "number"));
  const hourly = Array.from({ length: 24 }, (_, hour) => Math.round(median(set.members.map((m) => m.hours.find((h) => h.hour === hour)?.precipMm ?? 0)) * 10) / 10);
  return {
    basis: set.basis,
    source: set.source,
    members: set.members.length,
    peakRainMm: { median: Math.round(median(peaks) * 10) / 10, p90: Math.round(q90(peaks) * 10) / 10 },
    maxFeelsLikeC: feels.length ? Math.round(Math.max(...feels)) : null,
    hourlyRainMedian: hourly,
  };
}

/** Social hazard that bears on outdoor plans (rain/flood/storm/wind), and how much it counts for this date. */
function socialWeight(report: SocialReport | null, date: string) {
  if (!report) return { hazard: 0, posts: 0 };
  const d = daysFromToday(date);
  if (d < 0 || d > SOCIAL_HORIZON_DAYS) return { hazard: 0, posts: report.signals.length };
  const idx = report.index;
  const hazard = Math.max(idx.rain ?? 0, idx.flood ?? 0, idx.storm ?? 0, idx.wind ?? 0) * (d === 0 ? 0.5 : 0.3);
  return { hazard: Math.round(hazard * 100) / 100, posts: report.signals.length };
}

async function twinDay(day: DaySchedule, opts: { model: ImpactModel; scenario: Scenario | null; social: SocialReport | null; vibePacing: number; autonomy?: Parameters<typeof simulateDay>[2]["autonomy"]; seed: number }): Promise<DayTwinView | null> {
  if (day.nodes.length === 0) return null;
  const center = centerOf(day.nodes);
  const set = await weatherMembers(center.lat, center.lng, day.date);
  if (set.members.length === 0) return null;
  const social = socialWeight(opts.social, day.date);
  const common = { model: opts.model, samplesPerMember: Math.max(1, Math.ceil(TARGET_RUNS / set.members.length)), seed: opts.seed, autonomy: opts.autonomy, policy: policyFromVibe({ pacing: opts.vibePacing }), social };
  const baseline = simulateDay(day, set.members, common);
  const scenario = opts.scenario ? simulateDay(day, set.members, { ...common, scenario: opts.scenario }) : null;
  return {
    dayIndex: day.dayIndex,
    date: day.date,
    city: day.nodes[0].location.city,
    center,
    weather: weatherSummary(set),
    socialWeight: social.hazard,
    baseline,
    scenario,
    stops: day.nodes.map((n) => ({ id: n.id, title: n.title, lat: n.location.lat, lng: n.location.lng, start: n.timeSlot.start, isOutdoor: n.isOutdoor, locked: n.type === "HARD" })),
  };
}

const isBaseline = (s: Scenario) => JSON.stringify(s) === JSON.stringify(BASELINE);

export async function twinForTrip(user: SessionUser, tripId: string, scenario: Scenario, dayIndex?: number) {
  const bundle = await getTripBundle(user, tripId); // authorizes (owner or operator)
  const trip = bundle.trip;
  const learned = await learnedModel();
  const days = trip.schedule.filter((d) => d.nodes.length > 0 && (dayIndex === undefined || d.dayIndex === dayIndex)).slice(0, MAX_TRIP_DAYS);
  if (days.length === 0) throw new HttpError(422, "Plan some stops first — the twin simulates the days you have.");
  const cities = [...new Set(days.map((d) => d.nodes[0].location.city).filter(Boolean))];
  const socials = new Map<string, SocialReport | null>();
  for (const c of cities) socials.set(c, await socialSignals(c).catch(() => null));
  const views: DayTwinView[] = [];
  for (const d of days) {
    const v = await twinDay(d, {
      model: learned.model,
      scenario: isBaseline(scenario) ? null : scenario,
      social: socials.get(d.nodes[0].location.city) ?? null,
      vibePacing: trip.vibeConfig.pacing,
      autonomy: bundle.autonomy ?? undefined,
      seed: d.dayIndex * 7919,
    });
    if (v) views.push(v);
  }
  const first = views[0];
  const now = first ? await currentWeather(first.center.lat, first.center.lng) : null;
  return {
    tripId,
    destination: trip.destination,
    generatedAt: new Date().toISOString(),
    scenario,
    model: { basis: learned.basis, observations: learned.observations, beliefs: modelSummary(learned.model) },
    now,
    days: views,
    social: [...socials.entries()].map(([city, r]) => ({ city, report: r })),
  };
}

export interface FleetTwin {
  generatedAt: string;
  scenario: Scenario;
  trips: { tripId: string; destination: string; owner: string; days: { dayIndex: number; date: string; city: string; pOperator: number; pAnyChange: number; minutesLost: number; center: { lat: number; lng: number } }[] }[];
  /** Expected operator cards per local hour across the fleet (next 3 days). */
  operatorLoadByHour: number[];
  /** Places where outdoor visits are likely to be displaced → extra demand for indoor venues nearby. */
  hotspots: { city: string; lat: number; lng: number; displacedVisits: number; stops: string[] }[];
  cities: { city: string; tripsAffected: number; roadSlowdown: number; now: CurrentWeather | null; social: SocialReport | null }[];
  model: { basis: string; observations: number };
}

export async function fleetTwin(user: SessionUser, scenario: Scenario): Promise<FleetTwin> {
  if (user.role !== "operator") throw new HttpError(403, "Operators only");
  const learned = await learnedModel();
  const active = await read((db) =>
    db.trips
      .filter((t) => t.trip.schedule.some((d) => d.nodes.length > 0 && daysFromToday(d.date) >= 0 && daysFromToday(d.date) <= 2))
      .slice(0, 20)
      .map((t) => ({ rec: structuredClone(t), owner: db.users.find((u) => u.id === t.ownerId)?.name ?? "unknown" })),
  );
  const load = new Array(24).fill(0);
  const spots = new Map<string, FleetTwin["hotspots"][number]>();
  const cityAgg = new Map<string, { trips: Set<string>; slow: number[] }>();
  const socials = new Map<string, SocialReport | null>();
  const trips: FleetTwin["trips"] = [];
  for (const { rec, owner } of active) {
    const days = rec.trip.schedule.filter((d) => d.nodes.length > 0 && daysFromToday(d.date) >= 0 && daysFromToday(d.date) <= 2);
    const out: FleetTwin["trips"][number]["days"] = [];
    for (const d of days) {
      const city = d.nodes[0].location.city;
      if (!socials.has(city)) socials.set(city, await socialSignals(city).catch(() => null));
      const v = await twinDay(d, { model: learned.model, scenario: isBaseline(scenario) ? null : scenario, social: socials.get(city) ?? null, vibePacing: rec.trip.vibeConfig.pacing, autonomy: rec.autonomy, seed: d.dayIndex * 104729 });
      if (!v) continue;
      const t = v.scenario ?? v.baseline;
      out.push({ dayIndex: d.dayIndex, date: d.date, city, pOperator: t.pOperator, pAnyChange: t.pAnyChange, minutesLost: t.minutesLost.mean, center: v.center });
      // Operator workload lands in the hours where the disrupted stops are.
      const risky = t.stops.filter((s) => s.pDisrupted > 0);
      const weight = risky.reduce((n, s) => n + s.pDisrupted, 0) || 1;
      for (const s of risky) {
        const node = d.nodes.find((n) => n.id === s.nodeId)!;
        load[Math.min(23, Math.floor(toMinutes(node.timeSlot.start) / 60))] += (t.expectedCards.OPERATOR * s.pDisrupted) / weight;
      }
      for (const s of t.stops.filter((x) => x.pDropped > 0.05 && x.isOutdoor)) {
        const node = d.nodes.find((n) => n.id === s.nodeId)!;
        // Group displaced visits within ~1.5 km.
        const key = [...spots.keys()].find((k) => haversineMeters(spots.get(k)!, node.location) < 1500) ?? `${node.location.lat.toFixed(3)},${node.location.lng.toFixed(3)}`;
        const cur = spots.get(key) ?? { city, lat: node.location.lat, lng: node.location.lng, displacedVisits: 0, stops: [] };
        cur.displacedVisits = Math.round((cur.displacedVisits + s.pDropped) * 100) / 100;
        if (!cur.stops.includes(s.title)) cur.stops.push(s.title);
        spots.set(key, cur);
      }
      const agg = cityAgg.get(city) ?? { trips: new Set<string>(), slow: [] };
      if (t.pAnyChange > 0.2) agg.trips.add(rec.trip.id);
      agg.slow.push(t.travelSlowdown.mean);
      cityAgg.set(city, agg);
    }
    if (out.length) trips.push({ tripId: rec.trip.id, destination: rec.trip.destination, owner, days: out });
  }
  const cities: FleetTwin["cities"] = [];
  for (const [city, a] of cityAgg) {
    const anyDay = trips.flatMap((t) => t.days).find((d) => d.city === city);
    cities.push({
      city,
      tripsAffected: a.trips.size,
      roadSlowdown: Math.round((a.slow.reduce((x, y) => x + y, 0) / Math.max(1, a.slow.length)) * 100) / 100,
      now: anyDay ? await currentWeather(anyDay.center.lat, anyDay.center.lng) : null,
      social: socials.get(city) ?? null,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    scenario,
    trips,
    operatorLoadByHour: load.map((v) => Math.round(v * 100) / 100),
    hotspots: [...spots.values()].sort((a, b) => b.displacedVisits - a.displacedVisits).slice(0, 15),
    cities,
    model: { basis: learned.basis, observations: learned.observations },
  };
}
