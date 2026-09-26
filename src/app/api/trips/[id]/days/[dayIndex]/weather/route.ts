import { after } from "next/server";
import { runAlternativeAgent } from "@/server/agents.ts";
import { HttpError, requireUser } from "@/server/auth.ts";
import { dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { createDisruptionProposal, getTripBundle } from "@/server/trips.ts";
import { rainWindows } from "@/server/weather.ts";
import { toMinutes } from "@/lib/musafir/time.ts";

/** Checks the real Open-Meteo forecast for a day and raises WEATHER proposals for rain over outdoor stops. */
export const POST = handle<DayCtx>(async (_req, { params }) => {
  const user = await requireUser();
  const { id, dayIndex: raw } = await params;
  const dayIndex = dayIndexOf(raw);
  const { trip } = await getTripBundle(user, id);
  const day = trip.schedule.find((d) => d.dayIndex === dayIndex);
  if (!day) throw new HttpError(404, "Day not found");
  if (day.nodes.length === 0) return { checked: false, message: "Add stops first — the forecast is fetched for their location." };

  const lat = day.nodes.reduce((s, n) => s + n.location.lat, 0) / day.nodes.length;
  const lng = day.nodes.reduce((s, n) => s + n.location.lng, 0) / day.nodes.length;
  const check = await rainWindows(lat, lng, day.date);
  if (!check.available) return { checked: false, message: `Forecast unavailable: ${check.reason}` };

  const outdoor = day.nodes.filter((n) => n.isOutdoor);
  const hits = check.windows.filter((w) =>
    outdoor.some((n) => {
      const s = toMinutes(n.timeSlot.start);
      return s < w.toMinute && s + n.timeSlot.durationMinutes > w.fromMinute;
    }),
  );
  const proposals: string[] = [];
  for (const w of hits) {
    const p = await createDisruptionProposal(user, id, dayIndex, {
      kind: "WEATHER",
      fromMinute: w.fromMinute,
      toMinute: w.toMinute,
      reason: `Open-Meteo forecast: ${w.peakProbability}% chance of rain (${check.timezone})`,
    });
    proposals.push(p.id);
    after(() => runAlternativeAgent(p.id));
  }
  return {
    checked: true,
    windows: check.windows,
    message:
      check.windows.length === 0
        ? "No rain in the forecast for this day."
        : hits.length === 0
          ? `Rain expected, but no outdoor stops are affected.`
          : `Rain affects ${hits.length} window${hits.length > 1 ? "s" : ""} with outdoor stops — see the cards.`,
    proposals,
  };
});
