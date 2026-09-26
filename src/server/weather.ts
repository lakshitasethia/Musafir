/**
 * Open-Meteo hourly forecast (free, no key). The forecast horizon is ~16 days;
 * outside it we say so instead of guessing.
 */
const FORECAST_HORIZON_DAYS = 16;
export const RAIN_PROBABILITY_THRESHOLD = 60; // %
export const RAIN_MM_THRESHOLD = 0.5; // mm in the hour

export type RainCheck =
  | { available: false; reason: string }
  | { available: true; windows: { fromMinute: number; toMinute: number; peakProbability: number }[]; timezone: string };

export async function rainWindows(lat: number, lng: number, date: string): Promise<RainCheck> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { available: false, reason: `invalid date ${date}` };
  const target = Date.parse(`${date}T00:00:00Z`);
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const daysAhead = Math.round((target - today) / 86_400_000);
  if (daysAhead < 0) return { available: false, reason: "that day is in the past" };
  if (daysAhead > FORECAST_HORIZON_DAYS - 1) {
    return { available: false, reason: `forecasts only reach ${FORECAST_HORIZON_DAYS} days ahead; this day is ${daysAhead} days away` };
  }

  const params = new URLSearchParams({
    latitude: lat.toFixed(4),
    longitude: lng.toFixed(4),
    hourly: "precipitation_probability,precipitation",
    timezone: "auto",
    start_date: date,
    end_date: date,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: controller.signal });
    if (!res.ok) return { available: false, reason: `Open-Meteo HTTP ${res.status}` };
    const body = (await res.json()) as {
      timezone?: string;
      hourly?: { time: string[]; precipitation_probability: (number | null)[]; precipitation: (number | null)[] };
    };
    const h = body.hourly;
    if (!h?.time?.length) return { available: false, reason: "Open-Meteo returned no hourly data" };

    const windows: { fromMinute: number; toMinute: number; peakProbability: number }[] = [];
    h.time.forEach((t, i) => {
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
    return { available: true, windows, timezone: body.timezone ?? "local" };
  } catch (e) {
    return { available: false, reason: (e as Error).name === "AbortError" ? "Open-Meteo timed out" : (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
}
