"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { INTERESTS, type Interest, type Party } from "@/lib/musafir/interests.ts";
import { api } from "./api";

const VIBES = [
  { key: "pacing", label: "Pacing", left: "Café loiterer", right: "25k-step marathon" },
  { key: "budget", label: "Budget", left: "Street food & transit", right: "Tasting menus & cabs" },
  { key: "culturalDepth", label: "Atmosphere", left: "Iconic landmarks", right: "Underground & local" },
  { key: "circadian", label: "Rhythm", left: "Early dawn", right: "Night owl" },
] as const;

type Faders = { pacing: number; budget: number; culturalDepth: number; circadian: number };

interface TripSummary {
  id: string;
  destination: string;
  dateRange: { start: string; end: string };
  stops: number;
  owner: string;
  pending: number;
}

interface Resolved {
  scale: "place" | "region" | "country" | "continent";
  name: string;
  description?: string;
  cities: { name: string }[];
}

interface Card {
  name: string;
  scale: string;
  description?: string;
  towns: string[];
  why?: string;
  weather?: { avgHighC: number; rainyDays: number; days: number; basis: string };
}

interface BriefResult {
  vibe: Partial<Faders>;
  interests: Interest[];
  avoid: Interest[];
  keywords: string[];
  mustSee: string[];
  party?: Party;
  partySize?: number;
  via: string;
}

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** Words that mean "I haven't picked a place" — go straight to suggestions. */
const UNDECIDED = /^(any\s?where|where\s?ever|any|surprise me|not sure|idk|somewhere|no idea|dunno|anything)\b/i;

export function TripList() {
  const router = useRouter();
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(addDays(today, 14));
  const [end, setEnd] = useState(addDays(today, 17));
  const [destination, setDestination] = useState("");
  const [vibe, setVibe] = useState<Faders>({ pacing: 0.5, budget: 0.5, culturalDepth: 0.5, circadian: 0.5 });
  const [brief, setBrief] = useState("");
  const [interests, setInterests] = useState<Interest[]>([]);
  const [avoid, setAvoid] = useState<Interest[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [mustSee, setMustSee] = useState<string[]>([]);
  const [party, setParty] = useState<Party | undefined>();
  const [reading, setReading] = useState<string | null>(null);
  const [check, setCheck] = useState<{ q: string; result: Resolved | null; loading: boolean } | null>(null);
  const [cards, setCards] = useState<{ list: Card[]; via: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [diet, setDiet] = useState("");
  const checkSeq = useRef(0);

  useEffect(() => {
    api<{ trips: TripSummary[] }>("/api/trips")
      .then((r) => setTrips(r.trips))
      .catch((e) => setError(e.message));
  }, []);

  // Live check of what the destination means (debounced).
  useEffect(() => {
    const q = destination.trim();
    if (q.length < 2 || UNDECIDED.test(q)) return; // stale checks are hidden below, no state reset needed
    const seq = ++checkSeq.current;
    const t = setTimeout(() => {
      setCheck({ q, result: null, loading: true });
      api<{ destination: Resolved | null }>(`/api/destinations?q=${encodeURIComponent(q)}`)
        .then((r) => seq === checkSeq.current && setCheck({ q, result: r.destination, loading: false }))
        .catch(() => seq === checkSeq.current && setCheck({ q, result: null, loading: false }));
    }, 700);
    return () => clearTimeout(t);
  }, [destination]);

  const vibeConfig = () => ({
    ...vibe,
    ...(brief.trim() ? { brief: brief.trim() } : {}),
    ...(interests.length ? { interests } : {}),
    ...(avoid.length ? { avoid } : {}),
    ...(keywords.length ? { keywords } : {}),
    ...(mustSee.length ? { mustSee } : {}),
    ...(party ? { party } : {}),
  });

  async function readMyBrief() {
    if (!brief.trim()) return;
    setReading("Reading…");
    try {
      const r = await api<BriefResult>("/api/vibe/interpret", { body: { text: brief } });
      setVibe((v) => ({ ...v, ...r.vibe }));
      setInterests(r.interests);
      setAvoid(r.avoid);
      setKeywords(r.keywords);
      setMustSee(r.mustSee);
      if (r.party) setParty(r.party);
      setReading(`Set from your words (${r.via === "keywords" ? "keyword reading" : r.via}). Adjust anything below.`);
    } catch (e) {
      setReading((e as Error).message);
    }
  }

  async function suggest(exclude: string[] = []) {
    setSuggesting(true);
    setError(null);
    try {
      const text = [destination.trim(), brief.trim()].filter(Boolean).join(". ");
      const r = await api<{ cards: Card[]; via: string }>("/api/suggest", { body: { text: text || undefined, vibe: vibeConfig(), startDate: start, endDate: end, exclude } });
      if (r.cards.length === 0) setError("No suggestions came back — try describing the trip in a few words.");
      setCards({ list: r.cards, via: r.via });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSuggesting(false);
    }
  }

  async function createTrip(dest: string) {
    setBusy(true);
    setError(null);
    try {
      const { id } = await api<{ id: string }>("/api/trips", {
        body: {
          destination: dest,
          startDate: start,
          endDate: end,
          vibeConfig: vibeConfig(),
          dietaryRestrictions: diet
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

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const q = destination.trim();
    // No place, "anywhere", a continent, or something we can't find → offer places instead of guessing.
    if (!q || UNDECIDED.test(q) || (check?.q === q && !check.loading && (!check.result || check.result.scale === "continent"))) {
      await suggest();
      return;
    }
    await createTrip(q);
  }

  const toggle = (list: Interest[], set: (v: Interest[]) => void, i: Interest) => set(list.includes(i) ? list.filter((x) => x !== i) : [...list, i]);

  return (
    <div className="mz-stack">
      <form className="mz-panel mz-stack" onSubmit={submit}>
        <span className="mz-label">New trip</span>
        <label className="mz-field">
          <span className="mz-label">Where to?</span>
          <input
            className="mz-input"
            name="destination"
            maxLength={120}
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="A city, a state, a country — or leave blank for ideas"
          />
        </label>
        {check && check.q === destination.trim() && (
          <p className="mz-tiny mz-muted" style={{ margin: 0 }} role="status">
            {check.loading
              ? "Checking…"
              : !check.result
                ? `Couldn't find "${check.q}" — Plan will suggest places instead.`
                : check.result.scale === "continent"
                  ? `${check.result.name} is a continent — Plan will suggest countries in it.`
                  : `${check.result.name} — ${check.result.description ?? check.result.scale}${check.result.cities.length ? ` · we'll route through ${check.result.cities.slice(0, 4).map((c) => c.name).join(", ")}…` : ""}`}
          </p>
        )}
        <div className="mz-grid-2">
          <label className="mz-field">
            <span className="mz-label">From</span>
            <input className="mz-input" type="date" required value={start} min={today} onChange={(e) => setStart(e.target.value)} />
          </label>
          <label className="mz-field">
            <span className="mz-label">To</span>
            <input className="mz-input" type="date" required value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </label>
        </div>

        <label className="mz-field">
          <span className="mz-label">Describe the trip you want (optional)</span>
          <textarea
            className="mz-input"
            rows={3}
            maxLength={600}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            placeholder="e.g. Slow week with my partner, love forts, street food and jazz bars, no malls. Must see the Taj Mahal."
          />
        </label>
        <div className="mz-row">
          <button type="button" className="mz-btn mz-btn-ghost mz-btn-sm" disabled={!brief.trim() || reading === "Reading…"} onClick={readMyBrief}>
            Set my vibe from this
          </button>
          {reading && <span className="mz-tiny mz-muted">{reading}</span>}
        </div>

        {VIBES.map((v, i) => (
          // --v / --lean let CSS grow the side the fader leans toward; --i staggers the entrance
          <div key={v.key} className="mz-fader is-leaning" style={{ "--v": vibe[v.key], "--lean": Math.abs(vibe[v.key] - 0.5) * 2, "--i": i } as CSSProperties}>
            <span className="mz-label">{v.label}</span>
            <input type="range" min={0} max={1} step={0.05} value={vibe[v.key]} aria-label={v.label} onChange={(e) => setVibe({ ...vibe, [v.key]: Number(e.target.value) })} />
            <div className="mz-fader-ends">
              <span>{v.left}</span>
              <span>{v.right}</span>
            </div>
          </div>
        ))}

        <div className="mz-field">
          <span className="mz-label">Into (tap to add · tap twice to avoid)</span>
          <div className="mz-row" style={{ flexWrap: "wrap" }}>
            {INTERESTS.map((i) => {
              const state = interests.includes(i) ? "like" : avoid.includes(i) ? "avoid" : "none";
              return (
                <button
                  key={i}
                  type="button"
                  className="mz-chip"
                  aria-pressed={state === "like"}
                  data-avoid={state === "avoid" || undefined}
                  onClick={() => {
                    if (state === "none") toggle(interests, setInterests, i);
                    else if (state === "like") {
                      toggle(interests, setInterests, i);
                      setAvoid([...avoid, i]);
                    } else toggle(avoid, setAvoid, i);
                  }}
                >
                  {state === "avoid" ? `no ${i}` : i}
                </button>
              );
            })}
          </div>
        </div>
        <TagInput label="Anything else you're into (your words)" values={keywords} onChange={setKeywords} placeholder="anime, jazz bars, tea ceremony…" max={10} />
        <TagInput label="Must-see places" values={mustSee} onChange={setMustSee} placeholder="Taj Mahal, Fushimi Inari…" max={6} />
        <div className="mz-field">
          <span className="mz-label">Travelling as</span>
          <div className="mz-row" style={{ flexWrap: "wrap" }}>
            {(["solo", "couple", "family", "friends", "group"] as const).map((p) => (
              <button key={p} type="button" className="mz-chip" aria-pressed={party === p} onClick={() => setParty(party === p ? undefined : p)}>
                {p}
              </button>
            ))}
          </div>
        </div>
        <label className="mz-field">
          <span className="mz-label">Dietary needs (optional, comma-separated)</span>
          <input className="mz-input" maxLength={200} value={diet} onChange={(e) => setDiet(e.target.value)} placeholder="vegetarian, no pork" />
        </label>
        {error && <p className="mz-error">{error}</p>}
        <div className="mz-row" style={{ flexWrap: "wrap" }}>
          <button className="mz-btn mz-btn-solid" disabled={busy || suggesting}>
            {busy ? "Creating…" : suggesting ? "Finding places…" : destination.trim() ? "Plan my trip" : "Suggest places"}
          </button>
          {destination.trim() && (
            <button type="button" className="mz-btn mz-btn-ghost" disabled={busy || suggesting} onClick={() => suggest()}>
              Not sure? Suggest places
            </button>
          )}
        </div>
        <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
          Musafir drafts every day from real places in open map data. You can reshape anything afterwards.
        </p>
      </form>

      {cards && (
        <section className="mz-stack" aria-label="Suggested destinations">
          <div className="mz-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
            <span className="mz-label">Places that fit your vibe</span>
            <button type="button" className="mz-btn mz-btn-ghost mz-btn-sm" disabled={suggesting} onClick={() => suggest(cards.list.map((c) => c.name))}>
              {suggesting ? "Finding more…" : "Show me others"}
            </button>
          </div>
          <ul className="mz-suggest-grid">
            {cards.list.map((c) => (
              <li key={c.name} className="mz-panel mz-suggest-card">
                <div className="mz-display mz-h3">{c.name}</div>
                <div className="mz-tiny mz-muted">{c.description ?? c.scale}</div>
                {c.why && <p className="mz-small" style={{ margin: 0 }}>{c.why}</p>}
                {c.towns.length > 0 && <p className="mz-tiny" style={{ margin: 0 }}>Route ideas: {c.towns.join(" · ")}</p>}
                {c.weather && (
                  <p className="mz-tiny mz-muted" style={{ margin: 0 }} title={c.weather.basis}>
                    Last year on your dates: ~{c.weather.avgHighC}°C highs, {c.weather.rainyDays} of {c.weather.days} days with rain
                  </p>
                )}
                <button
                  type="button"
                  className="mz-btn mz-btn-solid mz-btn-sm"
                  disabled={busy}
                  onClick={() => {
                    setDestination(c.name);
                    void createTrip(c.name);
                  }}
                >
                  Plan {c.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
            {cards.via}. Weather is last year&apos;s record for the same dates, not a forecast.
          </p>
        </section>
      )}

      <span className="mz-label">Your trips</span>
      {trips === null && !error && <p className="mz-muted">Loading…</p>}
      {trips?.length === 0 && <p className="mz-muted">No trips yet.</p>}
      <ul className="mz-list">
        {trips?.map((t) => (
          <li key={t.id} className="mz-trip-row">
            <Link className="mz-list-item" href={`/trip/${t.id}`}>
              <div>
                <div className="mz-display mz-h3">{t.destination}</div>
                <div className="mz-tiny mz-muted mz-mono">
                  {t.dateRange.start} → {t.dateRange.end} · {t.stops} stops
                </div>
              </div>
              {t.pending > 0 && <span className="mz-tier t-TRAVELLER">{t.pending} open</span>}
            </Link>
            {/* Printable itinerary → the browser's Save as PDF (always the current plan) */}
            <a
              className="mz-btn mz-btn-ghost mz-btn-sm mz-trip-pdf"
              href={`/trip/${t.id}/print?auto=1`}
              target="_blank"
              rel="noopener"
              aria-label={`Download PDF of the ${t.destination} itinerary`}
            >
              <span className="mz-trip-pdf-long">Download </span>PDF
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TagInput({ label, values, onChange, placeholder, max }: { label: string; values: string[]; onChange: (v: string[]) => void; placeholder: string; max: number }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const parts = draft
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length >= 2 && !values.includes(x));
    if (parts.length) onChange([...values, ...parts].slice(0, max));
    setDraft("");
  };
  return (
    <div className="mz-field">
      <span className="mz-label">{label}</span>
      {values.length > 0 && (
        <div className="mz-row" style={{ flexWrap: "wrap" }}>
          {values.map((v) => (
            <button key={v} type="button" className="mz-chip" aria-pressed="true" title="Remove" onClick={() => onChange(values.filter((x) => x !== v))}>
              {v} ×
            </button>
          ))}
        </div>
      )}
      <input
        className="mz-input"
        value={draft}
        maxLength={80}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}
