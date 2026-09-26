/**
 * Open-Meteo hourly forecast (free, no key). The forecast horizon is ~16 days;
 * outside it we say so instead of guessing.
 */
import type { RainWindow } from "@/lib/musafir/sentinel.ts";

const FORECAST_HORIZON_DAYS = 16;
export const RAIN_PROBABILITY_THRESHOLD = 60; // %
export const RAIN_MM_THRESHOLD = 0.5; // mm in the hour

export type RainCheck =
  | { available: false; reason: string }
  | { available: true; windows: RainWindow[]; timezone: string; utcOffsetSeconds: number };

interface HourlyBody {
  timezone?: string;
  utc_offset_seconds?: number;
  hourly?: { time: string[]; precipitation_probability: (number | null)[]; precipitation: (number | null)[] };
}

async function fetchHourly(params: URLSearchParams): Promise<HourlyBody | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
    if (!res.ok) return { error: `Open-Meteo HTTP ${res.status}` };
    return (await res.json()) as HourlyBody;
  } catch (e) {
    return { error: (e as Error).name === "AbortError" ? "Open-Meteo timed out" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/** Rainy hours for one local date, merged into contiguous windows (minutes of day). */
function windowsFor(body: HourlyBody, date: string): RainWindow[] {
  const h = body.hourly!;
  const windows: RainWindow[] = [];
  h.time.forEach((t, i) => {
    if (t.slice(0, 10) !== date) return;
    const prob = h.precipitation_probability[i] ?? 0;
    const mm = h.precipitation[i] ?? 0;
    if (prob < RAIN_PROBABILITY_THRESHOLD && mm < RAIN_MM_THRESHOLD) return;
    const hour = Number(t.slice(11, 13));
    const last = windows[windows.length - 1];
    if (last && last.toMinute === hour * 60) {
      last.toMinute += 60;
      last.peakProbability = Math.max(last.peakProbability, prob);
    } else {
      windows.push({ fromMinute: hour * 60, toMinute: hour * 60 + 60, peakProbability: prob });
    }
  });
  return windows;
}

const base = (lat: number, lng: number) =>
  new URLSearchParams({ latitude: lat.toFixed(4), longitude: lng.toFixed(4), hourly: "precipitation_probability,precipitation", timezone: "auto" });

export async function rainWindows(lat: number, lng: number, date: string): Promise<RainCheck> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { available: false, reason: `invalid date ${date}` };
  const target = Date.parse(`${date}T00:00:00Z`);
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const daysAhead = Math.round((target - today) / 86_400_000);
  if (daysAhead < -1) return { available: false, reason: "that day is in the past" };
  if (daysAhead > FORECAST_HORIZON_DAYS - 1) {
    return { available: false, reason: `forecasts only reach ${FORECAST_HORIZON_DAYS} days ahead; this day is ${daysAhead} days away` };
  }
  const params = base(lat, lng);
  params.set("start_date", date);
  params.set("end_date", date);
  const body = await fetchHourly(params);
  if ("error" in body) return { available: false, reason: body.error };
  if (!body.hourly?.time?.length) return { available: false, reason: "Open-Meteo returned no hourly data" };
  return { available: true, windows: windowsFor(body, date), timezone: body.timezone ?? "local", utcOffsetSeconds: body.utc_offset_seconds ?? 0 };
}

/** Today and tomorrow at the location, with its UTC offset — for the sentinel's local clock. */
export async function nearTermForecast(
  lat: number,
  lng: number,
): Promise<{ available: false; reason: string } | { available: true; utcOffsetSeconds: number; timezone: string; windowsOn: (date: string) => RainWindow[] }> {
  const params = base(lat, lng);
  params.set("forecast_days", "2");
  const body = await fetchHourly(params);
  if ("error" in body) return { available: false, reason: body.error };
  if (!body.hourly?.time?.length || typeof body.utc_offset_seconds !== "number") return { available: false, reason: "Open-Meteo returned no hourly data" };
  return { available: true, utcOffsetSeconds: body.utc_offset_seconds, timezone: body.timezone ?? "local", windowsOn: (date) => windowsFor(body, date) };
}
