"use client";

/**
 * Weather Digital Twin panel for one trip day. Runs the twin (server) for the
 * forecast and for a what-if scenario, side by side. Nothing here changes the
 * trip — the twin simulates on copies with the same engine the trip uses.
 */
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { TwinLine, TwinPoint, TwinRain } from "./TwinMap";

const TwinMap = dynamic(() => import("./TwinMap").then((m) => m.TwinMap), { ssr: false, loading: () => <p className="mz-tiny mz-muted">Loading map…</p> });

interface Scenario {
  precipScale: number;
  precipAddMm: number;
  durationExtendH: number;
  tempOffsetC: number;
  gustScale: number;
  flood: boolean;
  stormStartHour: number;
}
const BASE: Scenario = { precipScale: 1, precipAddMm: 0, durationExtendH: 0, tempOffsetC: 0, gustScale: 1, flood: false, stormStartHour: 14 };

interface StopImpact {
  nodeId: string;
  title: string;
  isOutdoor: boolean;
  locked: boolean;
  weather: string;
  pDisrupted: number;
  pDropped: number;
  meanShiftMin: number;
  p90ShiftMin: number;
  drivers: { key: string; p: number; n: number }[];
}
interface DayTwin {
  runs: number;
  members: number;
  stops: StopImpact[];
  edges: { from: string; to: string; kind: "disrupts" | "delays" | "drops"; weight: number }[];
  pAnyChange: number;
  expectedCards: { AUTO: number; TRAVELLER: number; OPERATOR: number };
  pOperator: number;
  minutesLost: { mean: number; p10: number; p90: number };
  travelSlowdown: { mean: number; max: number };
}
interface DayView {
  dayIndex: number;
  date: string;
  city: string;
  center: { lat: number; lng: number };
  weather: { basis: string; source: string; members: number; peakRainMm: { median: number; p90: number }; maxFeelsLikeC: number | null; hourlyRainMedian: number[] };
  socialWeight: number;
  baseline: DayTwin;
  scenario: DayTwin | null;
  stops: { id: string; title: string; lat: number; lng: number; start: string; isOutdoor: boolean; locked: boolean }[];
}
interface Signal {
  source: string;
  url: string;
  at: string;
  excerpt: string;
  hazard: string;
  severity: number;
}
interface TwinResponse {
  generatedAt: string;
  model: { basis: string; observations: number; beliefs: { key: string; p: number; n: number }[] };
  now: { temperatureC: number; apparentC: number; precipMm: number; gustKmh: number; time: string } | null;
  days: DayView[];
  social: { city: string; report: { index: Record<string, number>; signals: Signal[]; sources: { name: string; status: string; count: number }[]; classifiedBy: string } | null }[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const SLIDERS: { key: keyof Omit<Scenario, "flood">; label: string; min: number; max: number; step: number; fmt: (v: number) => string }[] = [
  { key: "precipScale", label: "Rain intensity", min: 0, max: 4, step: 0.25, fmt: (v) => `×${v}` },
  { key: "precipAddMm", label: "Heavier storm", min: 0, max: 40, step: 2, fmt: (v) => `+${v} mm/h` },
  { key: "durationExtendH", label: "Storm lasts longer", min: 0, max: 8, step: 1, fmt: (v) => `+${v} h` },
  { key: "stormStartHour", label: "Storm breaks at", min: 6, max: 21, step: 1, fmt: (v) => `${String(v).padStart(2, "0")}:00` },
  { key: "tempOffsetC", label: "Temperature", min: -10, max: 12, step: 1, fmt: (v) => `${v > 0 ? "+" : ""}${v} °C` },
  { key: "gustScale", label: "Wind gusts", min: 0.5, max: 3, step: 0.25, fmt: (v) => `×${v}` },
];
const PRESETS: { label: string; s: Partial<Scenario> }[] = [
  { label: "Forecast only", s: {} },
  { label: "Monsoon burst", s: { precipAddMm: 25, durationExtendH: 3 } },
  { label: "Heatwave", s: { tempOffsetC: 8 } },
  { label: "Storm + gales", s: { precipAddMm: 12, gustScale: 2.5 } },
  { label: "Flooding", s: { flood: true, precipAddMm: 10 } },
];

/** One figure: forecast value, and the what-if value when it differs. */
function Metric({ label, a, b }: { label: string; a: string; b?: string }) {
  return (
    <div className="mz-twin-metric">
      <span className="mz-label">{label}</span>
      <span className="mz-mono">
        {a}
        {b !== undefined && b !== a && <strong> → {b}</strong>}
      </span>
    </div>
  );
}

export function WeatherTwin({ tripId, dayIndex, version }: { tripId: string; dayIndex: number; version: number }) {
  const [scenario, setScenario] = useState<Scenario>(BASE);
  const [data, setData] = useState<TwinResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(
    async (s: Scenario) => {
      const my = ++seq.current;
      setBusy(true);
      setError(null);
      try {
        const r = await api<TwinResponse>(`/api/trips/${tripId}/twin`, { body: { scenario: s, dayIndex } });
        if (my === seq.current) setData(r);
      } catch (e) {
        if (my === seq.current) setError((e as Error).message);
      } finally {
        if (my === seq.current) setBusy(false);
      }
    },
    [tripId, dayIndex],
  );

  // Re-run when the day, the trip (new version = new plan) or the scenario changes — debounced for sliders.
  useEffect(() => {
    const t = setTimeout(() => void run(scenario), 450);
    return () => clearTimeout(t);
  }, [run, scenario, version]);

  // New real data (forecast hour, social posts) → refresh every 10 minutes.
  useEffect(() => {
    const t = setInterval(() => void run(scenario), 10 * 60_000);
    return () => clearInterval(t);
  }, [run, scenario]);

  const day = data?.days.find((d) => d.dayIndex === dayIndex) ?? data?.days[0];
  const view = day?.scenario ?? day?.baseline;
  const social = data?.social.find((s) => s.city === day?.city)?.report ?? data?.social[0]?.report ?? null;
  const titleOf = useMemo(() => new Map(day?.stops.map((s) => [s.id, s.title]) ?? []), [day]);

  const points: TwinPoint[] = useMemo(() => {
    if (!day || !view) return [];
    const risk = new Map(view.stops.map((s) => [s.nodeId, s]));
    const pts: TwinPoint[] = day.stops.map((s) => {
      const r = risk.get(s.id);
      return {
        id: s.id,
        lat: s.lat,
        lng: s.lng,
        label: `${s.start} ${s.title}`,
        value: r ? Math.max(r.pDisrupted, r.pDropped) : 0,
        kind: "stop" as const,
        locked: s.locked,
        detail: r ? `${pct(r.pDisrupted)} disrupted, ${pct(r.pDropped)} dropped, shift ~${r.meanShiftMin} min (p90 ${r.p90ShiftMin}) · ${r.weather}` : undefined,
      };
    });
    if (social?.signals.length) {
      pts.push({ id: "social", lat: day.center.lat + 0.004, lng: day.center.lng - 0.004, label: `${social.signals.length} social reports`, value: 0, kind: "social", detail: social.signals.slice(0, 3).map((s) => `${s.hazard}: ${s.excerpt.slice(0, 60)}`).join(" | ") });
    }
    return pts;
  }, [day, view, social]);
  const lines: TwinLine[] = useMemo(() => {
    if (!day || !view) return [];
    const at = new Map(day.stops.map((s) => [s.id, [s.lng, s.lat] as [number, number]]));
    return view.edges
      .filter((e) => e.kind !== "disrupts" && at.has(e.from) && at.has(e.to))
      .map((e) => ({ from: at.get(e.from)!, to: at.get(e.to)!, kind: e.kind as "delays" | "drops", weight: e.kind === "delays" ? Math.min(5, e.weight / 5) : e.weight * 4 }));
  }, [day, view]);
  const rain: TwinRain[] = useMemo(() => {
    if (!day) return [];
    const bump = scenario.flood ? 30 : scenario.precipAddMm;
    return [{ lat: day.center.lat, lng: day.center.lng, mm: day.weather.peakRainMm.p90 * scenario.precipScale + bump, label: "rain field" }];
  }, [day, scenario]);

  const set = (k: keyof Scenario, v: number | boolean) => setScenario((s) => ({ ...s, [k]: v }));

  return (
    <section className="mz-panel mz-stack mz-twin" aria-label="Weather digital twin">
      <div className="mz-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
        <div>
          <span className="mz-label">Weather digital twin</span>
          <h2 className="mz-display mz-h2" style={{ margin: 0 }}>
            What the weather could do to day {dayIndex}
          </h2>
        </div>
        {busy && <span className="mz-tiny mz-muted">Simulating…</span>}
      </div>
      <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
        A virtual copy of this day runs through many possible weathers with Musafir&apos;s own healing engine. It never changes your real plan.
      </p>

      {data?.now && (
        <p className="mz-small" style={{ margin: 0 }}>
          Now at {day?.city || "the destination"}: {Math.round(data.now.temperatureC)} °C (feels {Math.round(data.now.apparentC)} °C), {data.now.precipMm} mm rain, gusts {Math.round(data.now.gustKmh)} km/h · live Open-Meteo
        </p>
      )}

      <div className="mz-row" style={{ flexWrap: "wrap" }} role="group" aria-label="Scenario presets">
        {PRESETS.map((p) => {
          const next = { ...BASE, ...p.s };
          return (
            <button key={p.label} type="button" className="mz-chip" aria-pressed={JSON.stringify(next) === JSON.stringify(scenario)} onClick={() => setScenario(next)}>
              {p.label}
            </button>
          );
        })}
      </div>
      <div className="mz-twin-sliders">
        {SLIDERS.map((s) => (
          <label key={s.key} className="mz-fader">
            <span className="mz-label">
              {s.label} <span className="mz-mono">{s.fmt(scenario[s.key])}</span>
            </span>
            <input type="range" min={s.min} max={s.max} step={s.step} value={scenario[s.key]} onChange={(e) => set(s.key, Number(e.target.value))} aria-label={s.label} />
          </label>
        ))}
        <label className="mz-row">
          <input type="checkbox" checked={scenario.flood} onChange={(e) => set("flood", e.target.checked)} /> <span className="mz-small">Flooding (roads ×2 slower, outdoor visits as in violent rain)</span>
        </label>
      </div>

      {error && <p className="mz-error">{error}</p>}
      {day && view && (
        <>
          <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
            Weather: {day.weather.basis}. Peak rain median {day.weather.peakRainMm.median} mm/h, 1-in-10 futures {day.weather.peakRainMm.p90} mm/h
            {day.weather.maxFeelsLikeC !== null ? `, feels-like up to ${day.weather.maxFeelsLikeC} °C` : ""}. {view.runs} simulated futures.
          </p>
          <div className="mz-twin-metrics">
            <Metric label="Chance the plan changes" a={pct(day.baseline.pAnyChange)} b={day.scenario ? pct(day.scenario.pAnyChange) : undefined} />
            <Metric label="Needs your operator" a={pct(day.baseline.pOperator)} b={day.scenario ? pct(day.scenario.pOperator) : undefined} />
            <Metric
              label="Visit time lost (mean · p10–p90)"
              a={`${day.baseline.minutesLost.mean} · ${day.baseline.minutesLost.p10}–${day.baseline.minutesLost.p90} min`}
              b={day.scenario ? `${day.scenario.minutesLost.mean} · ${day.scenario.minutesLost.p10}–${day.scenario.minutesLost.p90} min` : undefined}
            />
            <Metric label="Road travel time" a={`×${day.baseline.travelSlowdown.mean}`} b={day.scenario ? `×${day.scenario.travelSlowdown.mean}` : undefined} />
            <Metric
              label="Expected cards (auto / you / operator)"
              a={`${day.baseline.expectedCards.AUTO.toFixed(1)} / ${day.baseline.expectedCards.TRAVELLER.toFixed(1)} / ${day.baseline.expectedCards.OPERATOR.toFixed(1)}`}
              b={day.scenario ? `${day.scenario.expectedCards.AUTO.toFixed(1)} / ${day.scenario.expectedCards.TRAVELLER.toFixed(1)} / ${day.scenario.expectedCards.OPERATOR.toFixed(1)}` : undefined}
            />
          </div>

          <TwinMap points={points} lines={lines} rain={rain} />
          <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
            Pins show each stop&apos;s risk (%) in {day.scenario ? "the what-if" : "the forecast"}; dashed lines show knock-on effects (amber = pushed later, red = dropped); the blue field is rain intensity.
          </p>

          <ul className="mz-list">
            {view.stops.map((s) => {
              const base = day.baseline.stops.find((b) => b.nodeId === s.nodeId);
              return (
                <li key={s.nodeId} className="mz-list-item mz-twin-stop">
                  <div style={{ minWidth: 0 }}>
                    <div className="mz-small">
                      <strong>{s.title}</strong> {s.isOutdoor ? "· outdoor" : "· indoor"}
                      {s.locked ? " · locked booking" : ""}
                    </div>
                    <div className="mz-tiny mz-muted">
                      {s.weather}
                      {s.drivers.length > 0 && ` · ${s.drivers.map((d) => `${d.key} ${pct(d.p)} (${d.n ? `${d.n} observed` : "prior"})`).join(", ")}`}
                    </div>
                  </div>
                  <div className="mz-twin-bar" aria-label={`${pct(s.pDisrupted)} risk`}>
                    <span style={{ width: pct(Math.max(s.pDisrupted, s.pDropped)), background: s.pDisrupted >= 0.5 ? "var(--mz-red)" : s.pDisrupted >= 0.2 ? "var(--mz-amber)" : "var(--mz-sage)" }} />
                  </div>
                  <span className="mz-tiny mz-mono">
                    {base && day.scenario ? `${pct(base.pDisrupted)} → ` : ""}
                    {pct(s.pDisrupted)} · drop {pct(s.pDropped)} · +{s.meanShiftMin}m
                  </span>
                </li>
              );
            })}
          </ul>

          {view.edges.some((e) => e.kind !== "disrupts") && (
            <details>
              <summary className="mz-label">How effects cascade</summary>
              <ul className="mz-tiny" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                {view.edges
                  .filter((e) => e.kind !== "disrupts")
                  .sort((a, b) => b.weight - a.weight)
                  .slice(0, 10)
                  .map((e, i) => (
                    <li key={i}>
                      {e.from === "weather" ? "Slower roads in rain" : titleOf.get(e.from) ?? "a stop"} {e.kind === "drops" ? `drops ${titleOf.get(e.to)} (${pct(e.weight)} of futures)` : `pushes ${titleOf.get(e.to)} ~${e.weight} min`}
                    </li>
                  ))}
              </ul>
            </details>
          )}

          <details>
            <summary className="mz-label">What people are reporting {social ? `(${social.signals.length})` : ""}</summary>
            {social ? (
              <div className="mz-stack" style={{ marginTop: 8 }}>
                <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
                  Sources: {social.sources.map((s) => `${s.name} — ${s.status}`).join(" · ")}. Read by {social.classifiedBy}.{" "}
                  {day.socialWeight > 0 ? `Counted as ${pct(day.socialWeight)} extra outdoor risk for this date.` : "Not counted for this date (reports describe conditions now)."}
                </p>
                <ul className="mz-tiny" style={{ margin: 0, paddingLeft: 18 }}>
                  {social.signals.slice(0, 8).map((s) => (
                    <li key={s.url}>
                      <strong>{s.hazard}</strong> ({pct(s.severity)}) — {s.excerpt.slice(0, 140)}{" "}
                      <a href={s.url} target="_blank" rel="noreferrer noopener">
                        {s.source}
                      </a>
                    </li>
                  ))}
                  {social.signals.length === 0 && <li>No weather reports in the last 7 days.</li>}
                </ul>
              </div>
            ) : (
              <p className="mz-tiny mz-muted">Social sources unreachable right now.</p>
            )}
          </details>

          <details>
            <summary className="mz-label">What the twin has learned</summary>
            <p className="mz-tiny mz-muted" style={{ margin: "8px 0" }}>
              {data!.model.basis}. Classes: AMS/WMO rain rates, NWS heat index, Beaufort gusts.
            </p>
            <ul className="mz-tiny mz-mono" style={{ margin: 0, paddingLeft: 18 }}>
              {data!.model.beliefs.map((b) => (
                <li key={b.key}>
                  {b.key}: {pct(b.p)} chance an outdoor visit is disrupted ({b.n ? `${b.n} observations` : "prior"})
                </li>
              ))}
            </ul>
          </details>
        </>
      )}
      {!day && !busy && !error && <p className="mz-muted">Plan this day to simulate it.</p>}
    </section>
  );
}
