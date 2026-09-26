/**
 * Sentinel / event watchdog (zero-LLM). For each active trip:
 *   1. Forecast at the day's centroid gives the destination's local clock.
 *   2. Rain in the next SENTINEL_HORIZON_MIN minutes that touches an outdoor stop
 *      → a WEATHER proposal (same path as the simulator), unless a card already
 *        covers that window.
 * Triggers: the open trip page (session, one trip), a scheduled job with
 * SENTINEL_SECRET (all active trips), and the manual forecast check.
 * Vercel Hobby cron can only run daily, hence these triggers.
 */
import { affectedOutdoor, coveredByExisting, localClock, windowsInHorizon } from "@/lib/musafir/sentinel.ts";
import { fromMinutes } from "@/lib/musafir/time.ts";
import { read, write } from "./store.ts";
import { SENTINEL_ACTOR, createDisruptionProposal } from "./trips.ts";
import { nearTermForecast } from "./weather.ts";

/** A trip is checked at most this often, however many tabs are open. */
export const SENTINEL_MIN_INTERVAL_MS = 5 * 60_000;

export interface SentinelOutcome {
  tripId: string;
  checked: boolean;
  note: string;
  proposalIds: string[];
}

export async function runSentinelForTrip(tripId: string, opts: { force?: boolean } = {}): Promise<SentinelOutcome> {
  const out = (checked: boolean, note: string, proposalIds: string[] = []): SentinelOutcome => ({ tripId, checked, note, proposalIds });

  // Claim the slot atomically so concurrent tabs don't double-check.
  const claimed = await write((db) => {
    const rec = db.trips.find((t) => t.trip.id === tripId);
    if (!rec) return null;
    const last = rec.lastSentinelAt ? Date.parse(rec.lastSentinelAt) : 0;
    if (!opts.force && Date.now() - last < SENTINEL_MIN_INTERVAL_MS) return "recent";
    rec.lastSentinelAt = new Date().toISOString();
    return structuredClone(rec);
  });
  if (claimed === null) return out(false, "trip not found");
  if (claimed === "recent") return out(false, "checked recently");

  const withStops = claimed.trip.schedule.filter((d) => d.nodes.length > 0);
  if (withStops.length === 0) return out(false, "no stops yet");
  const ref = withStops[0].nodes;
  const lat = ref.reduce((s, n) => s + n.location.lat, 0) / ref.length;
  const lng = ref.reduce((s, n) => s + n.location.lng, 0) / ref.length;

  const forecast = await nearTermForecast(lat, lng);
  if (!forecast.available) return out(false, `forecast unavailable: ${forecast.reason}`);
  const now = localClock(Date.now(), forecast.utcOffsetSeconds);
  const day = claimed.trip.schedule.find((d) => d.date === now.date);
  if (!day) return out(true, `not travelling today (${now.date} local)`);

  const existing = await read((db) =>
    db.proposals
      .filter(
        (p) =>
          p.tripId === tripId &&
          p.dayIndex === day.dayIndex &&
          p.disruption.kind === "WEATHER" &&
          (p.status === "PENDING" || p.status === "APPLIED" || p.status === "AUTO_APPLIED"),
      )
      .map((p) => p.disruption as { fromMinute: number; toMinute: number }),
  );

  const created: string[] = [];
  for (const w of windowsInHorizon(forecast.windowsOn(now.date), now.minute)) {
    if (affectedOutdoor(day, w).length === 0 || coveredByExisting(w, existing)) continue;
    const p = await createDisruptionProposal(SENTINEL_ACTOR, tripId, day.dayIndex, {
      kind: "WEATHER",
      fromMinute: w.fromMinute,
      toMinute: w.toMinute,
      reason: `Sentinel: ${w.peakProbability}% chance of rain ${fromMinutes(w.fromMinute)}–${w.toMinute >= 1440 ? "24:00" : fromMinutes(w.toMinute)} (${forecast.timezone})`,
    }, { review: { probability: w.peakProbability / 100 } });
    existing.push(w);
    created.push(p.id);
  }
  return out(true, created.length ? `raised ${created.length} weather card(s)` : "no rain affecting outdoor stops in the next 2 hours", created);
}

/** Scheduled sweep: every trip whose date range includes today (UTC ± 1 day slack; exact day decided per trip). */
export async function runSentinelSweep(): Promise<SentinelOutcome[]> {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
  const day = 86_400_000;
  const ids = await read((db) =>
    db.trips
      .filter((t) => Date.parse(t.trip.dateRange.start) - day <= today && today <= Date.parse(t.trip.dateRange.end) + day)
      .map((t) => t.trip.id),
  );
  const results: SentinelOutcome[] = [];
  for (const id of ids) results.push(await runSentinelForTrip(id));
  return results;
}
