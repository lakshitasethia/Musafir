"use client";

/**
 * Operator's fleet-wide Digital Twin: every trip active in the next 3 days,
 * simulated against the forecast (or a what-if). Shows where operators will be
 * needed, which places will spill visitors into nearby indoor venues, and what
 * travellers on the ground are reporting. Read-only.
 */
import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import type { TwinPoint } from "./TwinMap";

const TwinMap = dynamic(() => import("./TwinMap").then((m) => m.TwinMap), { ssr: false, loading: () => <p className="mz-tiny mz-muted">Loading map…</p> });

interface Scenario {
  precipScale: number;
  precipAddMm: number;
  durationExtendH: number;
  tempOffsetC: number;
  gustScale: number;
  flood: boolean;
}
const BASE: Scenario = { precipScale: 1, precipAddMm: 0, durationExtendH: 0, tempOffsetC: 0, gustScale: 1, flood: false };
const PRESETS: { label: string; s: Partial<Scenario> }[] = [
  { label: "Forecast", s: {} },
  { label: "Monsoon burst", s: { precipAddMm: 25, durationExtendH: 3 } },
  { label: "Heatwave +8 °C", s: { tempOffsetC: 8 } },
  { label: "Storm + gales", s: { precipAddMm: 12, gustScale: 2.5 } },
  { label: "City flooding", s: { flood: true, precipAddMm: 10 } },
];

interface Fleet {
  generatedAt: string;
  trips: { tripId: string; destination: string; owner: string; days: { dayIndex: number; date: string; city: string; pOperator: number; pAnyChange: number; minutesLost: number; center: { lat: number; lng: number } }[] }[];
  operatorLoadByHour: number[];
  hotspots: { city: string; lat: number; lng: number; displacedVisits: number; stops: string[] }[];
  cities: {
    city: string;
    tripsAffected: number;
    roadSlowdown: number;
    now: { temperatureC: number; apparentC: number; precipMm: number; gustKmh: number } | null;
    social: { index: Record<string, number>; signals: { source: string; url: string; hazard: string; severity: number; excerpt: string }[]; sources: { name: string; status: string }[]; classifiedBy: string } | null;
  }[];
  model: { basis: string; observations: number };
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

export function FleetTwin() {
  const [scenario, setScenario] = useState<Scenario>(BASE);
  const [data, setData] = useState<Fleet | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (s: Scenario) => {
    const my = ++seq.current;
    setBusy(true);
    setError(null);
    try {
      const r = await api<Fleet>("/api/ops/twin", { body: { scenario: s } });
      if (my === seq.current) setData(r);
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    } finally {
      if (my === seq.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => void run(scenario), 300);
    const every = setInterval(() => void run(scenario), 10 * 60_000); // new forecast hours / posts
    return () => {
      clearTimeout(t);
      clearInterval(every);
    };
  }, [run, scenario]);

  const points: TwinPoint[] = useMemo(() => {
    if (!data) return [];
    return [
      ...data.trips.flatMap((t) =>
        t.days.map((d) => ({
          id: `${t.tripId}:${d.dayIndex}`,
          lat: d.center.lat,
          lng: d.center.lng,
          label: `${t.destination} · ${t.owner} · day ${d.dayIndex}`,
          value: Math.max(d.pAnyChange, d.pOperator),
          kind: "trip" as const,
          detail: `${pct(d.pAnyChange)} plan changes, ${pct(d.pOperator)} needs operator, ~${d.minutesLost} min lost`,
        })),
      ),
      ...data.hotspots.map((h, i) => ({
        id: `hot${i}`,
        lat: h.lat,
        lng: h.lng,
        label: `${h.displacedVisits} displaced visits near ${h.stops.slice(0, 2).join(", ")}`,
        value: h.displacedVisits,
        kind: "hotspot" as const,
        detail: "expect extra demand at indoor venues nearby",
      })),
    ];
  }, [data]);

  const peak = data ? Math.max(0.01, ...data.operatorLoadByHour) : 1;

  return (
    <div className="mz-stack">
      <div className="mz-page-head">
        <h1 className="mz-display mz-h1">Weather twin</h1>
        <p className="mz-small mz-muted" style={{ margin: 0 }}>
          Every trip active in the next 3 days, simulated against ensemble forecasts with the same healing engine the trips use. Nothing here changes a real trip.
        </p>
      </div>
      <div className="mz-row" style={{ flexWrap: "wrap" }} role="group" aria-label="Scenario">
        {PRESETS.map((p) => {
          const next = { ...BASE, ...p.s };
          return (
            <button key={p.label} type="button" className="mz-chip" aria-pressed={JSON.stringify(next) === JSON.stringify(scenario)} onClick={() => setScenario(next)}>
              {p.label}
            </button>
          );
        })}
        {busy && <span className="mz-tiny mz-muted">Simulating the fleet…</span>}
      </div>
      {error && <p className="mz-error">{error}</p>}
      {data && (
        <>
          {data.trips.length === 0 ? (
            <p className="mz-muted">No trips with stops in the next 3 days.</p>
          ) : (
            <>
              <TwinMap points={points} rain={data.cities.filter((c) => c.now).map((c) => {
                const t = data.trips.flatMap((x) => x.days).find((d) => d.city === c.city)!;
                return { lat: t.center.lat, lng: t.center.lng, mm: c.now!.precipMm + (scenario.flood ? 30 : scenario.precipAddMm), label: c.city };
              })} height={420} />
              <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
                Trip pins: chance the day changes (%). Red numbers: visits likely pushed indoors nearby. Blue field: rain now{scenario.precipAddMm || scenario.flood ? " plus the what-if" : ""}.
              </p>
            </>
          )}

          <section className="mz-panel mz-stack" aria-label="Operator workload">
            <span className="mz-label">Expected operator cards by hour</span>
            <div className="mz-load-chart" role="img" aria-label="Operator workload by hour">
              {data.operatorLoadByHour.map((v, h) => (
                <div key={h} className="mz-load-col" title={`${String(h).padStart(2, "0")}:00 — ${v.toFixed(2)} expected`}>
                  <span style={{ height: `${(v / peak) * 100}%` }} />
                  {h % 3 === 0 && <em>{String(h).padStart(2, "0")}</em>}
                </div>
              ))}
            </div>
            <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
              Sum over trips of P(an operator-tier change) placed at the hours of the stops at risk. Staff up where the bars rise.
            </p>
          </section>

          <section className="mz-stack" aria-label="Cities">
            <span className="mz-label">Cities</span>
            <ul className="mz-list">
              {data.cities.map((c) => (
                <li key={c.city} className="mz-panel mz-stack">
                  <div className="mz-row" style={{ justifyContent: "space-between", flexWrap: "wrap" }}>
                    <strong>{c.city}</strong>
                    <span className="mz-tiny mz-mono">
                      {c.now ? `${Math.round(c.now.temperatureC)} °C · ${c.now.precipMm} mm · gusts ${Math.round(c.now.gustKmh)} km/h` : "no live reading"} · roads ×{c.roadSlowdown} · {c.tripsAffected} trips likely to change
                    </span>
                  </div>
                  {c.social ? (
                    <>
                      <span className="mz-tiny mz-muted">
                        Social: {Object.entries(c.social.index).map(([k, v]) => `${k} ${pct(v)}`).join(", ") || "no weather reports"} · {c.social.sources.map((s) => `${s.name}: ${s.status}`).join(" · ")} · read by {c.social.classifiedBy}
                      </span>
                      <ul className="mz-tiny" style={{ margin: 0, paddingLeft: 18 }}>
                        {c.social.signals.slice(0, 4).map((s) => (
                          <li key={s.url}>
                            <strong>{s.hazard}</strong> {pct(s.severity)} — {s.excerpt.slice(0, 120)}{" "}
                            <a href={s.url} target="_blank" rel="noreferrer noopener">
                              {s.source}
                            </a>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <span className="mz-tiny mz-muted">Social sources unreachable.</span>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <section className="mz-stack" aria-label="Trips">
            <span className="mz-label">Trips at risk</span>
            <ul className="mz-list">
              {data.trips
                .flatMap((t) => t.days.map((d) => ({ t, d })))
                .sort((a, b) => b.d.pAnyChange - a.d.pAnyChange)
                .slice(0, 12)
                .map(({ t, d }) => (
                  <li key={`${t.tripId}-${d.dayIndex}`}>
                    <Link className="mz-list-item" href={`/ops/trips/${t.tripId}`}>
                      <span>
                        {t.destination} · {t.owner} · day {d.dayIndex} ({d.date})
                      </span>
                      <span className="mz-tiny mz-mono">
                        change {pct(d.pAnyChange)} · operator {pct(d.pOperator)} · ~{d.minutesLost} min
                      </span>
                    </Link>
                  </li>
                ))}
            </ul>
          </section>
          <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
            Model: {data.model.basis}. Updated {new Date(data.generatedAt).toLocaleTimeString()}.
          </p>
        </>
      )}
    </div>
  );
}
