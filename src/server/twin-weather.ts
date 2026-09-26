/**
 * Weather inputs for the Digital Twin (Open-Meteo, free, no key).
 *
 *  - Within ~15 days: the GFS ensemble (31 members; ICON-EPS's 40 within 7
 *    days) — each member is one physically plausible future, so the spread is
 *    real forecast uncertainty, not a made-up error bar.
 *  - Beyond the ensemble horizon: the same calendar day in each of the last
 *    five years (archive) — a climatological ensemble, labelled as such.
 *  - Live: current conditions for the "now" layer on the map.
 * Forecasts are cached in memory for an hour (they update hourly); archive
 * days are cached on disk (they never change).
 */
import type { WeatherMember } from "@/lib/musafir/twin.ts";
import { cached, fetchJson } from "./osm.ts";

export interface MemberSet {
  members: WeatherMember[];
  basis: string;
  source: "ensemble" | "climatology" | "unavailable";
  fetchedAt: string;
}

const HOURLY = "precipitation,apparent_temperature,wind_gusts_10m";
const FORECAST_TTL_MS = 60 * 60_000;
const g = globalThis as typeof globalThis & { __musafirTwinWx?: Map<string, { at: number; value: MemberSet }> };
const memo = (g.__musafirTwinWx ??= new Map());

const daysAhead = (date: string) => Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(new Date().toISOString().slice(0, 10))) / 86_400_000);

type Hourly = Record<string, (number | null)[] | string[]>;

function membersFrom(hourly: Hourly, date: string, prefix: string): WeatherMember[] {
  const times = (hourly.time as string[]) ?? [];
  const idx = times.map((t, i) => (t.slice(0, 10) === date ? i : -1)).filter((i) => i >= 0);
  const ids = new Set<string>(["control"]);
  for (const k of Object.keys(hourly)) {
    const m = /_member(\d+)$/.exec(k);
    if (m) ids.add(m[1]);
  }
  const series = (v: string, id: string) => (hourly[id === "control" ? v : `${v}_member${id}`] as (number | null)[] | undefined) ?? [];
  return [...ids]
    .map((id): WeatherMember | null => {
      const p = series("precipitation", id);
      if (p.length === 0) return null;
      const a = series("apparent_temperature", id);
      const w = series("wind_gusts_10m", id);
      return {
        id: `${prefix}${id}`,
        hours: idx.map((i) => ({ hour: Number(times[i].slice(11, 13)), precipMm: p[i] ?? 0, apparentC: a[i] ?? null, gustKmh: w[i] ?? null })),
      };
    })
    .filter((m): m is WeatherMember => m !== null && m.hours.length > 0);
}

async function ensemble(lat: number, lng: number, date: string): Promise<MemberSet | null> {
  const ahead = daysAhead(date);
  if (ahead < 0 || ahead > 15) return null;
  const model = ahead <= 6 ? "icon_seamless" : "gfs_seamless";
  const params = new URLSearchParams({ latitude: lat.toFixed(3), longitude: lng.toFixed(3), hourly: HOURLY, models: model, timezone: "auto", start_date: date, end_date: date });
  const body = (await fetchJson(`https://ensemble-api.open-meteo.com/v1/ensemble?${params}`, {}, 15_000)) as { hourly?: Hourly };
  const members = body.hourly ? membersFrom(body.hourly, date, `${model}#`) : [];
  if (members.length === 0) return null;
  return { members, basis: `${members.length}-member ${model === "icon_seamless" ? "ICON" : "GFS"} ensemble forecast`, source: "ensemble", fetchedAt: new Date().toISOString() };
}

async function climatology(lat: number, lng: number, date: string, years = 5): Promise<MemberSet | null> {
  const members: WeatherMember[] = [];
  const thisYear = new Date().getUTCFullYear();
  for (let k = 1; k <= years; k++) {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCFullYear(Math.min(thisYear, d.getUTCFullYear()) - k);
    const day = d.toISOString().slice(0, 10);
    const params = new URLSearchParams({ latitude: lat.toFixed(2), longitude: lng.toFixed(2), hourly: HOURLY, timezone: "auto", start_date: day, end_date: day });
    const body = await cached(`archive:${params}`, () => fetchJson(`https://archive-api.open-meteo.com/v1/archive?${params}`, {}, 12_000) as Promise<{ hourly?: Hourly }>).catch(() => null);
    const m = body?.hourly ? membersFrom(body.hourly, day, `${day.slice(0, 4)}#`) : [];
    members.push(...m.map((x) => ({ ...x, id: day.slice(0, 4) })));
  }
  if (members.length === 0) return null;
  return { members, basis: `same date in the last ${members.length} years (Open-Meteo archive) — beyond the forecast horizon`, source: "climatology", fetchedAt: new Date().toISOString() };
}

export async function weatherMembers(lat: number, lng: number, date: string): Promise<MemberSet> {
  const key = `${lat.toFixed(2)},${lng.toFixed(2)},${date}`;
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < FORECAST_TTL_MS) return hit.value;
  const value =
    (await ensemble(lat, lng, date).catch(() => null)) ??
    (await climatology(lat, lng, date).catch(() => null)) ?? { members: [], basis: "weather data unreachable", source: "unavailable" as const, fetchedAt: new Date().toISOString() };
  if (value.source !== "unavailable") memo.set(key, { at: Date.now(), value });
  return value;
}

/** One past day's observed hourly weather (archive; recent days via the forecast API's past_days). */
export async function observedDay(lat: number, lng: number, date: string): Promise<WeatherMember | null> {
  const ago = -daysAhead(date);
  if (ago < 1) return null;
  const params = new URLSearchParams({ latitude: lat.toFixed(2), longitude: lng.toFixed(2), hourly: HOURLY, timezone: "auto", start_date: date, end_date: date });
  const url = ago <= 6 ? `https://api.open-meteo.com/v1/forecast?${params}` : `https://archive-api.open-meteo.com/v1/archive?${params}`;
  const body = await cached(`observed:${url}`, () => fetchJson(url, {}, 12_000) as Promise<{ hourly?: Hourly }>).catch(() => null);
  const [m] = body?.hourly ? membersFrom(body.hourly, date, "obs#") : [];
  return m ?? null;
}

export interface CurrentWeather {
  temperatureC: number;
  apparentC: number;
  precipMm: number;
  gustKmh: number;
  code: number;
  time: string;
}

export async function currentWeather(lat: number, lng: number): Promise<CurrentWeather | null> {
  const params = new URLSearchParams({
    latitude: lat.toFixed(3),
    longitude: lng.toFixed(3),
    current: "temperature_2m,apparent_temperature,precipitation,wind_gusts_10m,weather_code",
    timezone: "auto",
  });
  const body = (await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, {}, 8000).catch(() => null)) as {
    current?: { time: string; temperature_2m: number; apparent_temperature: number; precipitation: number; wind_gusts_10m: number; weather_code: number };
  } | null;
  const c = body?.current;
  return c ? { temperatureC: c.temperature_2m, apparentC: c.apparent_temperature, precipMm: c.precipitation, gustKmh: c.wind_gusts_10m, code: c.weather_code, time: c.time } : null;
}
