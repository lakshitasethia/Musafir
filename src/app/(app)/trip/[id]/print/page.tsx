import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { fromMinutes, toMinutes } from "@/lib/musafir/time.ts";
import type { NodeCategory, TransitSegment } from "@/lib/musafir/schemas.ts";
import { getSessionUser } from "@/server/auth.ts";
import { getTripBundle } from "@/server/trips.ts";
import { LiveRefresh } from "../../../_components/LiveRefresh";
import { PrintButton } from "../../../_components/PrintButton";
import { ItineraryMap, dayColor, type MapStop } from "../../../_ui/ItineraryMap";

export const metadata: Metadata = { title: "Itinerary | Musafir" };

const CATEGORY: Record<NodeCategory, string> = {
  CULTURE: "Culture",
  DINING: "Food",
  NATURE: "Nature",
  TRANSIT: "Transit",
  LEISURE: "Leisure",
  ACCOMMODATION: "Stay",
};
const MODE: Record<TransitSegment["mode"], string> = { WALK: "walk", CAB: "by cab", BUS: "by bus", SUBWAY: "by metro" };

const fmtDate = (iso: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { timeZone: "UTC", ...opts });
const fmtDuration = (min: number) => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`);
const fmtDistance = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

/**
 * Printable itinerary (A4). "Download PDF" on the trip page opens this with
 * ?auto=1, which brings up the browser's Save-as-PDF dialog. Same access rules
 * as the trip itself: owner or operator, enforced by getTripBundle.
 */
export default async function PrintItinerary({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { id } = await params;
  const auto = (await searchParams).auto === "1";
  const user = await getSessionUser();
  if (!user) redirect(`/api/auth/guest?next=${encodeURIComponent(`/trip/${id}/print`)}`);
  const bundle = await getTripBundle(user, id).catch(() => null);
  if (!bundle) notFound();

  const { trip } = bundle;
  const days = trip.schedule
    .map((d) => ({ ...d, nodes: [...d.nodes].sort((a, b) => toMinutes(a.timeSlot.start) - toMinutes(b.timeSlot.start)) }))
    .filter((d) => d.nodes.length > 0);
  const stops: MapStop[] = days.flatMap((d) =>
    d.nodes.map((n, i) => ({ id: n.id, lat: n.location.lat, lng: n.location.lng, title: n.title, day: d.dayIndex, order: i + 1 })),
  );
  const totalStops = stops.length;
  const visitMin = days.flatMap((d) => d.nodes).reduce((s, n) => s + n.timeSlot.durationMinutes, 0);
  const travelMin = days.flatMap((d) => d.transitSegments).reduce((s, t) => s + t.durationMinutes, 0);
  const activity = [...bundle.activity].reverse().slice(-20); // oldest → newest
  const backHref = user.role === "operator" ? `/ops/trips/${id}` : `/trip/${id}`;

  return (
    <main className="mz-print">
      <div className="mz-print-toolbar">
        <Link href={backHref} className="mz-btn mz-btn-ghost">
          ← Back to trip
        </Link>
        <PrintButton auto={auto} />
      </div>

      <article className="mz-print-sheet">
        <header className="mz-print-head">
          <div className="mz-print-brand">Musafir · Your itinerary</div>
          {/* Re-renders when the trip changes, so the saved PDF is always the current plan */}
          <LiveRefresh tripId={trip.id} version={trip.version} />
          <h1 className="mz-print-title">{trip.destination}</h1>
          <p className="mz-print-dates">
            {trip.dateRange.start === trip.dateRange.end
              ? fmtDate(trip.dateRange.start, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
              : `${fmtDate(trip.dateRange.start, { day: "numeric", month: "long" })} – ${fmtDate(trip.dateRange.end, { day: "numeric", month: "long", year: "numeric" })}`}
          </p>
          <dl className="mz-print-stats">
            <div>
              <dt>Days</dt>
              <dd>{trip.schedule.length}</dd>
            </div>
            <div>
              <dt>Stops</dt>
              <dd>{totalStops}</dd>
            </div>
            <div>
              <dt>Exploring</dt>
              <dd>{fmtDuration(visitMin)}</dd>
            </div>
            <div>
              <dt>Travelling</dt>
              <dd>{fmtDuration(travelMin)}</dd>
            </div>
          </dl>
          {trip.dietaryRestrictions.length > 0 && <p className="mz-print-note">Dietary needs: {trip.dietaryRestrictions.join(", ")}</p>}
        </header>

        {stops.length > 0 && (
          <section className="mz-print-section mz-print-mapwrap" aria-label="Route map">
            <h2 className="mz-print-h2">Route map</h2>
            <ItineraryMap stops={stops} />
            <ul className="mz-print-legend">
              {days.map((d) => (
                <li key={d.dayIndex}>
                  <i style={{ background: dayColor(d.dayIndex) }} />
                  Day {d.dayIndex} · {fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" })}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="mz-print-section" aria-label="Day by day">
          <h2 className="mz-print-h2">Day by day</h2>
          {days.length === 0 && <p className="mz-print-empty">No stops planned yet.</p>}
          {days.map((d) => {
            const leg = new Map(d.transitSegments.map((t) => [t.fromNodeId, t]));
            const first = d.nodes[0];
            const last = d.nodes[d.nodes.length - 1];
            const end = toMinutes(last.timeSlot.start) + last.timeSlot.durationMinutes;
            return (
              <div key={d.dayIndex} className="mz-print-day">
                <div className="mz-print-day-head" style={{ borderColor: dayColor(d.dayIndex) }}>
                  <span className="mz-print-day-num" style={{ background: dayColor(d.dayIndex) }}>
                    {d.dayIndex}
                  </span>
                  <div>
                    <h3>{fmtDate(d.date, { weekday: "long", day: "numeric", month: "long" })}</h3>
                    <p>
                      {d.nodes.length} stops · {first.timeSlot.start}–{fromMinutes(Math.min(end, 24 * 60 - 1))}
                    </p>
                  </div>
                </div>
                <ol className="mz-print-stops">
                  {d.nodes.map((n, i) => {
                    const t = leg.get(n.id);
                    const stopEnd = fromMinutes(Math.min(toMinutes(n.timeSlot.start) + n.timeSlot.durationMinutes, 24 * 60 - 1));
                    return (
                      <li key={n.id}>
                        <div className="mz-print-stop">
                          <span className="mz-print-stop-num" style={{ color: dayColor(d.dayIndex), borderColor: dayColor(d.dayIndex) }}>
                            {i + 1}
                          </span>
                          <span className="mz-print-time">
                            {n.timeSlot.start}–{stopEnd}
                          </span>
                          <span className="mz-print-stop-main">
                            <strong>{n.title}</strong>
                            {n.nativeTitle && n.nativeTitle !== n.title && <span className="mz-print-native">{n.nativeTitle}</span>}
                            <span className="mz-print-meta">
                              {CATEGORY[n.category]} · {n.isOutdoor ? "outdoor" : "indoor"} · {fmtDuration(n.timeSlot.durationMinutes)}
                              {n.type === "HARD" && <em className="mz-print-locked">Locked booking</em>}
                            </span>
                          </span>
                        </div>
                        {t && i < d.nodes.length - 1 && (
                          <p className="mz-print-leg">
                            ↓ {t.durationMinutes} min {MODE[t.mode]} · {fmtDistance(t.distanceMeters)}
                          </p>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            );
          })}
        </section>

        {activity.length > 0 && (
          <section className="mz-print-section mz-print-activity" aria-label="Activity">
            <h2 className="mz-print-h2">Activity</h2>
            <ol>
              {activity.map((a) => (
                <li key={a.id}>
                  <time>
                    {new Date(a.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                  </time>
                  <span>
                    <strong>{a.actor}</strong> — {a.message}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <footer className="mz-print-foot">
          Plans change on the road. Musafir keeps your live itinerary up to date and heals the day when something breaks.
        </footer>
      </article>
    </main>
  );
}
