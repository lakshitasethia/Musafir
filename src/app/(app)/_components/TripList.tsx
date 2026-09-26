"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "./api";

const VIBES = [
  { key: "pacing", label: "Pacing", left: "Café loiterer", right: "25k-step marathon" },
  { key: "budget", label: "Budget", left: "Street food & transit", right: "Tasting menus & cabs" },
  { key: "culturalDepth", label: "Atmosphere", left: "Iconic landmarks", right: "Underground & local" },
  { key: "circadian", label: "Rhythm", left: "Early dawn", right: "Night owl" },
] as const;

interface TripSummary {
  id: string;
  destination: string;
  dateRange: { start: string; end: string };
  stops: number;
  owner: string;
  pending: number;
}

export function TripList() {
  const router = useRouter();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [vibe, setVibe] = useState({ pacing: 0.5, budget: 0.5, culturalDepth: 0.5, circadian: 0.5 });

  useEffect(() => {
    api<{ trips: TripSummary[] }>("/api/trips")
      .then((r) => setTrips(r.trips))
      .catch((e) => setError(e.message));
  }, []);

  async function create(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/trips", {
        body: {
          destination: f.get("destination"),
          startDate: f.get("start"),
          endDate: f.get("end"),
          vibeConfig: vibe,
          dietaryRestrictions: String(f.get("diet") ?? "")
            .split(",")
            .map((x) => x.trim())
            .filter(Boolean),
          autoPlan: true,
        },
      });
      router.push(`/trip/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="mz-stack">
      <form className="mz-panel mz-stack" onSubmit={create}>
        <span className="mz-label">New trip</span>
        <label className="mz-field">
          <span className="mz-label">Where to?</span>
          <input className="mz-input" name="destination" required maxLength={120} placeholder="Jaipur, Kyoto, Lisbon…" />
        </label>
        <div className="mz-grid-2">
          <label className="mz-field">
            <span className="mz-label">From</span>
            <input className="mz-input" type="date" name="start" required defaultValue={today} />
          </label>
          <label className="mz-field">
            <span className="mz-label">To</span>
            <input className="mz-input" type="date" name="end" required defaultValue={today} />
          </label>
        </div>
        {VIBES.map((v) => (
          <div key={v.key} className="mz-fader">
            <span className="mz-label">{v.label}</span>
            <input type="range" min={0} max={1} step={0.05} value={vibe[v.key]} aria-label={v.label} onChange={(e) => setVibe({ ...vibe, [v.key]: Number(e.target.value) })} />
            <div className="mz-fader-ends">
              <span>{v.left}</span>
              <span>{v.right}</span>
            </div>
          </div>
        ))}
        <label className="mz-field">
          <span className="mz-label">Dietary needs (optional, comma-separated)</span>
          <input className="mz-input" name="diet" maxLength={200} placeholder="vegetarian, no pork" />
        </label>
        {error && <p className="mz-error">{error}</p>}
        <button className="mz-btn mz-btn-solid" disabled={busy}>
          {busy ? "Creating…" : "Plan my trip"}
        </button>
        <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
          Musafir drafts every day from real OpenStreetMap places. You can reshape anything afterwards.
        </p>
      </form>

      <span className="mz-label">Your trips</span>
      {trips === null && !error && <p className="mz-muted">Loading…</p>}
      {trips?.length === 0 && <p className="mz-muted">No trips yet.</p>}
      <ul className="mz-list">
        {trips?.map((t) => (
          <li key={t.id}>
            <Link className="mz-list-item" href={`/trip/${t.id}`}>
              <div>
                <div className="mz-display mz-h3">{t.destination}</div>
                <div className="mz-tiny mz-muted mz-mono">
                  {t.dateRange.start} → {t.dateRange.end} · {t.stops} stops
                </div>
              </div>
              {t.pending > 0 && <span className="mz-tier t-TRAVELLER">{t.pending} open</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
