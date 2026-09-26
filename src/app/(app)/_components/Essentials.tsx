"use client";

/**
 * Flights, Hotels and Packages. Musafir doesn't sell tickets or rooms, and open
 * data has no fares or room prices — so nothing here shows a price. Flights and
 * hotel booking hand off to a search engine with your trip's details filled in;
 * what Musafir adds is real data (OSM hotels near your stops, live OpenSky
 * positions) and the itinerary itself.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { newId } from "@/lib/musafir/ids.ts";
import type { ItineraryNode, VibeConfig } from "@/lib/musafir/schemas.ts";
import { fromMinutes, MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";
import type { TripBundle } from "@/server/trips.ts";
import { SectionHeader } from "../_ui/SectionHeader";
import { PackageCard } from "../_ui/PackageCard";
import { api } from "./api";

interface TripSummary {
  id: string;
  destination: string;
  dateRange: { start: string; end: string };
}

function useTrips() {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  useEffect(() => {
    api<{ trips: TripSummary[] }>("/api/trips")
      .then((r) => setTrips(r.trips))
      .catch(() => setTrips([]));
  }, []);
  return trips;
}

function TripPicker({ trips, value, onChange }: { trips: TripSummary[]; value: string; onChange: (id: string) => void }) {
  return (
    <label className="mz-field">
      <span className="mz-label">Trip</span>
      <select className="mz-select" value={value} onChange={(e) => onChange(e.target.value)}>
        {trips.map((t) => (
          <option key={t.id} value={t.id}>
            {t.destination} · {t.dateRange.start} → {t.dateRange.end}
          </option>
        ))}
      </select>
    </label>
  );
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// ── Flights ──────────────────────────────────────────────────────────
interface FlightStatus {
  callsign: string;
  originCountry: string;
  lat: number | null;
  lng: number | null;
  altitudeM: number | null;
  speedKmh: number | null;
  headingDeg: number | null;
  onGround: boolean;
  lastContact: string;
  observedAt: string;
}

export function FlightsView() {
  const trips = useTrips();
  const [tripId, setTripId] = useState("");
  const trip = trips?.find((t) => t.id === tripId) ?? trips?.[0];
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [depart, setDepart] = useState("");
  const [ret, setRet] = useState("");
  const [callsign, setCallsign] = useState("");
  const [status, setStatus] = useState<{ s: FlightStatus | null; note: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Prefill from the chosen trip, but never overwrite what the traveller typed.
  const dest = to || trip?.destination || "";
  const departDate = depart || trip?.dateRange.start || "";
  const returnDate = ret || trip?.dateRange.end || "";
  const q = `Flights from ${from} to ${dest} on ${departDate}${returnDate && returnDate !== departDate ? ` returning ${returnDate}` : ""}`;
  const searchUrl = `https://www.google.com/travel/flights?q=${encodeURIComponent(q)}`;

  return (
    <div className="mz-stack">
      <SectionHeader index={1} eyebrow="Flights" title="Find a flight" as="h1" />
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        Musafir doesn&apos;t sell tickets or show fares. We fill in your route and dates and open Google Flights, where you compare and book.
      </p>
      <div className="mz-panel mz-stack">
        {trips && trips.length > 0 && <TripPicker trips={trips} value={trip?.id ?? ""} onChange={setTripId} />}
        <div className="mz-grid-2">
          <label className="mz-field">
            <span className="mz-label">From</span>
            <input className="mz-input" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="Delhi, DEL…" />
          </label>
          <label className="mz-field">
            <span className="mz-label">To</span>
            <input className="mz-input" value={to} onChange={(e) => setTo(e.target.value)} placeholder={trip?.destination ?? "Jaipur, JAI…"} />
          </label>
          <label className="mz-field">
            <span className="mz-label">Depart</span>
            <input className="mz-input" type="date" value={departDate} onChange={(e) => setDepart(e.target.value)} />
          </label>
          <label className="mz-field">
            <span className="mz-label">Return (optional)</span>
            <input className="mz-input" type="date" value={returnDate} min={departDate} onChange={(e) => setRet(e.target.value)} />
          </label>
        </div>
        <a
          className={`mz-btn mz-btn-solid${from.trim() && dest.trim() && departDate ? "" : " is-disabled"}`}
          aria-disabled={!(from.trim() && dest.trim() && departDate)}
          href={from.trim() && dest.trim() && departDate ? searchUrl : undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          Search flights on Google Flights ↗
        </a>
      </div>

      <SectionHeader index={2} eyebrow="Live" title="Track a flight" />
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        Live position from The OpenSky Network&apos;s volunteer receivers. Use the callsign the plane broadcasts — usually the airline&apos;s ICAO code plus the number (Air India 101 → AIC101, IndiGo 6E 2131 → IGO2131).
      </p>
      <form
        className="mz-panel mz-row"
        style={{ flexWrap: "nowrap" }}
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr(null);
          try {
            const r = await api<{ status: FlightStatus | null; note: string | null }>(`/api/flights/track?callsign=${encodeURIComponent(callsign)}`);
            setStatus({ s: r.status, note: r.note });
          } catch (e2) {
            setErr((e2 as Error).message);
            setStatus(null);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input className="mz-input" value={callsign} onChange={(e) => setCallsign(e.target.value.toUpperCase())} placeholder="AIC101" maxLength={10} aria-label="Callsign" />
        <button className="mz-btn mz-btn-sm" disabled={busy || callsign.trim().length < 3}>
          {busy ? "…" : "Track"}
        </button>
      </form>
      {err && <p className="mz-error">{err}</p>}
      {status && !status.s && <p className="mz-note">{status.note}</p>}
      {status?.s && (
        <article className="mz-card mz-offer">
          <div className="mz-spread">
            <h3 className="mz-display mz-h3">{status.s.callsign}</h3>
            <span className="mz-tier t-AUTO">{status.s.onGround ? "On the ground" : "In the air"}</span>
          </div>
          <p className="mz-small mz-mono" style={{ margin: 0 }}>
            {status.s.altitudeM !== null ? `${status.s.altitudeM.toLocaleString()} m · ` : ""}
            {status.s.speedKmh !== null ? `${status.s.speedKmh} km/h · ` : ""}
            {status.s.headingDeg !== null ? `heading ${status.s.headingDeg}° · ` : ""}
            registered in {status.s.originCountry}
          </p>
          {status.s.lat !== null && status.s.lng !== null && (
            <a className="mz-btn mz-btn-ghost mz-btn-sm" href={`https://www.openstreetmap.org/?mlat=${status.s.lat}&mlon=${status.s.lng}#map=7/${status.s.lat}/${status.s.lng}`} target="_blank" rel="noopener noreferrer">
              See position on the map ↗
            </a>
          )}
          <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
            Last signal {new Date(status.s.lastContact).toLocaleTimeString()} · data from OpenSky Network
          </p>
        </article>
      )}
    </div>
  );
}

// ── Hotels ───────────────────────────────────────────────────────────
interface Hotel {
  id: string;
  name: string;
  nameNative?: string;
  lat: number;
  lng: number;
  kind: string;
  distanceMeters: number;
  stars?: string;
  website?: string;
  source: string;
}

export function HotelsView() {
  const trips = useTrips();
  const [tripId, setTripId] = useState("");
  const trip = trips?.find((t) => t.id === tripId) ?? trips?.[0];
  const [data, setData] = useState<{ basis: string; hotels: Hotel[]; dateRange: { start: string; end: string }; destination: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tripId?: string; stopId?: string } | null>(null);

  useEffect(() => {
    if (!trip) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setErr(null);
      setData(null);
    });
    api<{ basis: string; hotels: Hotel[]; dateRange: { start: string; end: string }; destination: string }>(`/api/hotels?tripId=${trip.id}`)
      .then((r) => !cancelled && setData(r))
      .catch((e) => !cancelled && setErr(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [trip]);

  async function addStay(h: Hotel) {
    if (!trip) return;
    setMsg(null);
    try {
      const bundle = await api<TripBundle>(`/api/trips/${trip.id}`);
      const day = bundle.trip.schedule[0];
      const lastEnd = day.nodes.reduce((m, n) => Math.max(m, toMinutes(n.timeSlot.start) + n.timeSlot.durationMinutes), 20 * 60 - 15);
      const start = Math.min(MINUTES_PER_DAY - 45, Math.ceil((lastEnd + 15) / 15) * 15);
      const node: ItineraryNode = {
        id: newId(),
        type: "SOFT",
        title: `Check in: ${h.name}`,
        nativeTitle: h.nameNative,
        category: "ACCOMMODATION",
        location: { lat: h.lat, lng: h.lng, city: bundle.trip.destination },
        timeSlot: { start: fromMinutes(start), durationMinutes: 30, bufferMinutes: 0 },
        isOutdoor: false,
        costEstimate: { amount: 0, currency: day.nodes[0]?.costEstimate.currency ?? "USD" },
        metadata: { kind: `tourism=${h.kind}`, source: h.source, osmId: h.id, costSource: "unknown (book with the provider)", priority: 1 },
      };
      await api(`/api/trips/${trip.id}/days/${day.dayIndex}/patches`, {
        body: { baseVersion: bundle.trip.version, patches: [{ patchId: newId(), targetDayIndex: day.dayIndex, operation: "INSERT", payload: node, reason: `Added stay "${h.name}"` }] },
      });
      setMsg({ text: `Added check-in at ${h.name} on day ${day.dayIndex}, ${fromMinutes(start)}.`, tripId: trip.id, stopId: node.id });
    } catch (e) {
      setMsg({ text: (e as Error).message });
    }
  }

  const bookingUrl = (h: Hotel) =>
    `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(`${h.name}, ${data?.destination ?? ""}`)}&checkin=${data?.dateRange.start}&checkout=${data ? addDays(data.dateRange.end, 1) : ""}`;

  return (
    <div className="mz-stack">
      <SectionHeader index={1} eyebrow="Hotels" title="Where to stay" as="h1" />
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        Real places to stay from OpenStreetMap, near your plan. Open data has no prices or availability — &ldquo;Prices &amp; booking&rdquo; opens Booking.com with your dates filled in.
      </p>
      {trips === null && <p className="mz-muted">Loading your trips…</p>}
      {trips?.length === 0 && (
        <div className="mz-empty">
          Plan a trip first so we know where to look. <Link href="/trip">Plan a trip</Link> or pick a <Link href="/packages">package</Link>.
        </div>
      )}
      {trips && trips.length > 0 && <TripPicker trips={trips} value={trip?.id ?? ""} onChange={setTripId} />}
      {loading && <p className="mz-muted">Searching nearby places to stay…</p>}
      {err && <p className="mz-error">{err}</p>}
      {msg && (
        <p className="mz-note" role="status">
          {msg.text}{" "}
          {msg.stopId && (
            <>
              <Link href={`/trip/${msg.tripId}`}>Open trip</Link> · <a href={`/taxi?trip=${msg.tripId}&stop=${msg.stopId}`}>Taxi card</a>
            </>
          )}
        </p>
      )}
      {data && (
        <>
          <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
            {data.hotels.length} found within 2.5 km of {data.basis}.
          </p>
          <ul className="mz-list">
            {data.hotels.map((h) => (
              <li key={h.id} className="mz-offer mz-list-item" style={{ flexWrap: "wrap" }}>
                <div style={{ minWidth: 0 }}>
                  <div className="mz-display mz-h3">{h.name}</div>
                  {h.nameNative && <div className="mz-small">{h.nameNative}</div>}
                  <div className="mz-tiny mz-muted">
                    {h.kind.replace("_", " ")} · {(h.distanceMeters / 1000).toFixed(1)} km away
                    {h.stars ? ` · ${h.stars}★ (OSM)` : ""}
                  </div>
                </div>
                <div className="mz-row">
                  <a className="mz-btn mz-btn-sm" href={bookingUrl(h)} target="_blank" rel="noopener noreferrer">
                    Prices &amp; booking ↗
                  </a>
                  {h.website && (
                    <a className="mz-btn mz-btn-ghost mz-btn-sm" href={h.website} target="_blank" rel="noopener noreferrer">
                      Website ↗
                    </a>
                  )}
                  <button className="mz-btn mz-btn-ghost mz-btn-sm" onClick={() => addStay(h)}>
                    Add to my trip
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ── Packages ─────────────────────────────────────────────────────────
const PACKAGES: { id: string; title: string; blurb: string; vibe: VibeConfig }[] = [
  { id: "heritage", title: "Heritage & Street Food", blurb: "Forts, museums and landmarks, fuelled by street stalls and cafés.", vibe: { pacing: 0.6, budget: 0.2, culturalDepth: 0.15, circadian: 0.3 } },
  { id: "slow", title: "Slow & Scenic", blurb: "Two or three unhurried stops a day, parks and gardens, long lunches.", vibe: { pacing: 0.1, budget: 0.5, culturalDepth: 0.5, circadian: 0.3 } },
  { id: "local", title: "Local & After Dark", blurb: "Galleries, arts centres and cinemas; starts late, ends later.", vibe: { pacing: 0.5, budget: 0.5, culturalDepth: 0.9, circadian: 0.9 } },
  { id: "marathon", title: "See It All", blurb: "Six stops a day, early starts, the essentials back to back.", vibe: { pacing: 0.95, budget: 0.4, culturalDepth: 0.3, circadian: 0.1 } },
  { id: "treat", title: "Treat Yourself", blurb: "Sit-down restaurants and a relaxed pace between the highlights.", vibe: { pacing: 0.4, budget: 0.95, culturalDepth: 0.4, circadian: 0.6 } },
];

export function PackagesView() {
  const router = useRouter();
  const today = new Date().toISOString().slice(0, 10);
  const [destination, setDestination] = useState("");
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(addDays(today, 2));
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const destRef = useRef<HTMLInputElement>(null);

  async function choose(p: (typeof PACKAGES)[number]) {
    if (!destination.trim()) {
      // The buttons sit below the form: bring the missing field into view instead of failing silently off-screen.
      destRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      destRef.current?.focus({ preventScroll: true });
      return setErr(`Where to? Enter a destination for "${p.title}" first.`);
    }
    setBusy(p.id);
    setErr(null);
    try {
      const { id } = await api<{ id: string }>("/api/trips", { body: { destination: destination.trim(), startDate: start, endDate: end, vibeConfig: p.vibe, autoPlan: true } });
      router.push(`/trip/${id}`);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(null);
    }
  }

  return (
    <div className="mz-stack">
      <SectionHeader index={1} eyebrow="Packages" title="Pick a way to travel" as="h1" />
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        Each package is a travel style. Choose one and Musafir drafts every day from real places at your destination — then heals the plan when things change. Flights and hotels book separately; no bundled prices.
      </p>
      <div className="mz-panel mz-stack">
        <label className="mz-field">
          <span className="mz-label">Where to?</span>
          <input ref={destRef} className="mz-input" value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="Jaipur, Kyoto, Lisbon…" maxLength={120} aria-invalid={!!err && !destination.trim()} />
        </label>
        <div className="mz-grid-2">
          <label className="mz-field">
            <span className="mz-label">From</span>
            <input className="mz-input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="mz-field">
            <span className="mz-label">To</span>
            <input className="mz-input" type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>
        {err && <p className="mz-error" style={{ margin: 0 }}>{err}</p>}
      </div>
      <div className="mz-packages">
        <ul className="mz-pkg-grid">
          {PACKAGES.map((p) => (
            <PackageCard
              key={p.id}
              id={p.id}
              title={p.title}
              blurb={p.blurb}
              vibe={p.vibe}
              busy={busy === p.id}
              disabled={busy !== null}
              onPlan={() => choose(p)}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
