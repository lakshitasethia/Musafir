"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { applyPatches } from "@/lib/musafir/reducer.ts";
import { newId } from "@/lib/musafir/ids.ts";
import type { AutonomyPolicy } from "@/lib/musafir/risk.ts";
import type { DaySchedule, ItineraryNode, TripPatch, VibeConfig } from "@/lib/musafir/schemas.ts";
import { fromMinutes, MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";
import type { TripBundle } from "@/server/trips.ts";
import { ApiError, api, hhmm } from "./api";
import { JourneyGraph } from "./JourneyGraph";
import { NodeSheet } from "./NodeSheet";
import { ProposalCard } from "./ProposalCard";
import { Toast } from "./TopBar";
import { useLive } from "./useLive";

type Role = "traveller" | "operator";

const VIBE_FADERS: { key: keyof VibeConfig; left: string; right: string; label: string }[] = [
  { key: "pacing", label: "Pacing", left: "Café loiterer", right: "25k-step marathon" },
  { key: "budget", label: "Budget", left: "Street food & transit", right: "Tasting menus & cabs" },
  { key: "culturalDepth", label: "Atmosphere", left: "Iconic landmarks", right: "Underground & local" },
  { key: "circadian", label: "Rhythm", left: "Early dawn", right: "Night owl" },
];

function initialDay(trip: TripBundle["trip"]): number {
  const today = new Date().toISOString().slice(0, 10);
  return trip.schedule.find((d) => d.date === today)?.dayIndex ?? trip.schedule[0]?.dayIndex ?? 1;
}

export function Workspace({ tripId, role, backHref }: { tripId: string; role: Role; backHref: string }) {
  const { data, error, live, refresh } = useLive<TripBundle>(`/api/trips/${tripId}`, `/api/trips/${tripId}/events`);
  const [dayIndex, setDayIndex] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<{ node: ItineraryNode | null } | null>(null);
  const [preview, setPreview] = useState<{ proposalId: string; optionId: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const flash = (text: string, isError = false) => {
    setToast({ text, error: isError });
    setTimeout(() => setToast(null), 3500);
  };

  const activeDayIndex = dayIndex ?? (data ? initialDay(data.trip) : 1);
  const day = data?.trip.schedule.find((d) => d.dayIndex === activeDayIndex) ?? null;

  const previewDay = useMemo(() => {
    if (!preview || !data || !day) return null;
    const option = data.proposals.find((p) => p.id === preview.proposalId)?.options.find((o) => o.id === preview.optionId);
    if (!option) return null;
    try {
      return applyPatches(day, option.patches);
    } catch {
      return null;
    }
  }, [preview, data, day]);

  const titles = useMemo(() => {
    const m = new Map<string, string>();
    data?.trip.schedule.forEach((d) => d.nodes.forEach((n) => m.set(n.id, n.title)));
    return m;
  }, [data]);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    try {
      await fn();
      if (ok) flash(ok);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) await refresh();
      flash((e as Error).message, true);
      throw e;
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  const sendPatches = (patches: TripPatch[], ok: string) =>
    run(() => api(`/api/trips/${tripId}/days/${activeDayIndex}/patches`, { body: { baseVersion: data!.trip.version, patches } }), ok);

  const patch = (p: Omit<TripPatch, "patchId" | "targetDayIndex">): TripPatch => ({ patchId: newId(), targetDayIndex: activeDayIndex, ...p });

  if (error && !data) return <p className="mz-error" style={{ padding: 24 }}>{error}</p>;
  if (!data || !day) return <p className="mz-muted" style={{ padding: 24 }}>Loading trip…</p>;

  const pending = data.proposals.filter((p) => p.status === "PENDING");
  const history = data.proposals.filter((p) => p.status !== "PENDING");
  const dayCost = day.nodes.reduce((s, n) => s + n.costEstimate.amount, 0);
  const currencies = [...new Set(day.nodes.map((n) => n.costEstimate.currency))];
  const lastEnd = day.nodes.reduce((m, n) => Math.max(m, toMinutes(n.timeSlot.start) + n.timeSlot.durationMinutes), 9 * 60 - 15);
  const defaultStart = fromMinutes(Math.min(MINUTES_PER_DAY - 60, Math.ceil((lastEnd + 15) / 15) * 15));
  const near = day.nodes.length
    ? { lat: day.nodes.reduce((s, n) => s + n.location.lat, 0) / day.nodes.length, lng: day.nodes.reduce((s, n) => s + n.location.lng, 0) / day.nodes.length }
    : undefined;

  return (
    <>
      <div className="mz-page-head">
        <Link href={backHref} className="mz-label" style={{ textDecoration: "none" }}>
          ← All trips
        </Link>
        <div className="mz-spread">
          <h1 className="mz-display mz-h1">{data.trip.destination}</h1>
          <span className={`mz-live${live ? " is-on" : ""}`}>
            <i /> {live ? "Live" : "Reconnecting"}
          </span>
        </div>
        <p className="mz-small mz-muted" style={{ margin: 0 }}>
          {data.trip.dateRange.start} → {data.trip.dateRange.end}
          {role === "operator" ? ` · traveller: ${data.owner}` : ""}
        </p>
        <div className="mz-tabs" role="tablist" aria-label="Days">
          {data.trip.schedule.map((d) => (
            <button
              key={d.dayIndex}
              role="tab"
              className="mz-tab"
              aria-selected={d.dayIndex === activeDayIndex}
              onClick={() => {
                setDayIndex(d.dayIndex);
                setSelectedId(null);
                setPreview(null);
              }}
            >
              <div className="mz-label" style={{ color: "inherit" }}>
                Day {d.dayIndex}
              </div>
              <div className="mz-tiny mz-mono">{d.date}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="mz-workspace">
        <section className="mz-stack" aria-label="Itinerary graph">
          <div className="mz-panel">
            <div className="mz-panel-title">
              <div>
                <div className="mz-label">
                  {day.nodes.length} stop{day.nodes.length === 1 ? "" : "s"} · fatigue {day.dailyFatigueScore}/100
                  {currencies.length === 1 && dayCost > 0 ? ` · ≈ ${dayCost.toFixed(0)} ${currencies[0]} (known costs)` : ""}
                </div>
                <div className="mz-tiny mz-muted">Drag flexible stops to move them · tap to edit</div>
              </div>
              <div className="mz-row">
                {data.trip.schedule.some((d) => d.nodes.length === 0) && (
                  <button
                    className="mz-btn mz-btn-solid mz-btn-sm"
                    disabled={busy || data.planner?.status === "RUNNING"}
                    onClick={() => run(() => api(`/api/trips/${tripId}/plan`, { body: {} }), "Planner started").catch(() => undefined)}
                  >
                    Plan empty days
                  </button>
                )}
                <button className="mz-btn mz-btn-ghost mz-btn-sm" onClick={() => setSheet({ node: null })}>
                  + Add stop
                </button>
              </div>
            </div>
            {data.planner && (
              <div className="mz-agent" style={{ marginBottom: 16, color: data.planner.status === "FAILED" ? "var(--mz-red)" : undefined }}>
                {data.planner.status === "RUNNING" && <span className="mz-pulse" />}
                <span>
                  Planner agent: {data.planner.note}
                </span>
              </div>
            )}
            {day.nodes.length === 0 && data.planner?.status !== "RUNNING" && (
              <div className="mz-empty">This day is empty. Let the planner draft it from real places, or add a stop yourself.</div>
            )}
            <JourneyGraph
              day={day}
              preview={previewDay}
              selectedId={selectedId}
              canDrag={(n) => n.type === "SOFT" && !busy}
              onSelect={(n) => {
                setSelectedId(n.id);
                setSheet({ node: n });
              }}
              onShift={(n, offset) =>
                sendPatches(
                  [patch({ operation: "SHIFT_TIME", nodeId: n.id, shiftOffsetMinutes: offset, reason: `Moved "${n.title}" ${offset > 0 ? "+" : ""}${offset} min` })],
                  `Moved ${n.title}`,
                ).catch(() => undefined)
              }
            />
          </div>

          <Simulator
            day={day}
            selectedId={selectedId}
            busy={busy}
            onDisruption={(d) =>
              run(async () => {
                const r = await api<{ status: string }>(`/api/trips/${tripId}/days/${activeDayIndex}/disruptions`, { body: d });
                flash(r.status === "AUTO_APPLIED" ? "Handled automatically — undo from the card" : "Proposal ready");
              }).catch(() => undefined)
            }
            onWeather={() =>
              run(async () => {
                const r = await api<{ message: string }>(`/api/trips/${tripId}/days/${activeDayIndex}/weather`, { body: {} });
                flash(r.message);
              }).catch(() => undefined)
            }
          />

          {role === "traveller" ? (
            <VibePanel key={JSON.stringify(data.trip.vibeConfig)} vibe={data.trip.vibeConfig} busy={busy} onSave={(v) => run(() => api(`/api/trips/${tripId}/settings`, { method: "PATCH", body: { vibeConfig: v } }), "Preferences saved").catch(() => undefined)} />
          ) : (
            <AutonomyPanel key={JSON.stringify(data.autonomy)} policy={data.autonomy} busy={busy} onSave={(a) => run(() => api(`/api/trips/${tripId}/settings`, { method: "PATCH", body: { autonomy: a } }), "Autonomy rules saved").catch(() => undefined)} />
          )}
        </section>

        <aside className="mz-side mz-stack" aria-label="Proposals and activity">
          <div className="mz-panel-title">
            <h2 className="mz-display mz-h2">Action cards</h2>
            <span className="mz-label">{pending.length} open</span>
          </div>
          {pending.length === 0 && <p className="mz-small mz-muted">Nothing needs you. Simulate a disruption to see the engine heal the day.</p>}
          {[...pending, ...history.slice(0, 8)].map((p) => (
            <ProposalCard
              key={p.id}
              proposal={p}
              titles={titles}
              busy={busy}
              previewing={preview?.proposalId === p.id ? preview.optionId : null}
              onPreview={(optionId) => {
                if (optionId && p.dayIndex !== activeDayIndex) setDayIndex(p.dayIndex);
                setPreview(optionId ? { proposalId: p.id, optionId } : null);
              }}
              onApply={(optionId) => {
                setPreview(null);
                run(() => api(`/api/proposals/${p.id}/decision`, { body: { decision: "APPLY", optionId } }), "Applied").catch(() => undefined);
              }}
              onDismiss={() => run(() => api(`/api/proposals/${p.id}/decision`, { body: { decision: "DISMISS" } }), "Dismissed").catch(() => undefined)}
              onUndo={() => run(() => api(`/api/proposals/${p.id}/undo`, { body: {} }), "Undone").catch(() => undefined)}
            />
          ))}

          <div className="mz-panel">
            <div className="mz-panel-title">
              <span className="mz-label">Activity</span>
            </div>
            <ul className="mz-feed">
              {data.activity.slice(0, 25).map((a) => (
                <li key={a.id}>
                  <time>{hhmm(a.at)}</time>
                  <span>
                    <strong>{a.actor}</strong> — {a.message}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      </div>

      {sheet && (
        <NodeSheet
          node={sheet.node}
          role={role}
          defaultStart={defaultStart}
          near={near}
          destination={data.trip.destination}
          onClose={() => {
            setSheet(null);
            setSelectedId(null);
          }}
          onSave={async (n, isNew) => {
            const prev = sheet.node;
            const patches = isNew
              ? [patch({ operation: "INSERT", payload: n, reason: `Added "${n.title}"` })]
              : prev?.type === "HARD"
                ? // Operators rebook a locked booking explicitly: remove + re-add under the same id.
                  [patch({ operation: "REMOVE", nodeId: n.id, reason: `Rebooked "${prev.title}"` }), patch({ operation: "INSERT", payload: n, reason: `Rebooked "${n.title}"` })]
                : [patch({ operation: "REPLACE", nodeId: n.id, payload: n, reason: `Edited "${n.title}"` })];
            await sendPatches(patches, isNew ? `Added ${n.title}` : `Saved ${n.title}`);
          }}
          onDelete={(n) => sendPatches([patch({ operation: "REMOVE", nodeId: n.id, reason: `Removed "${n.title}"` })], `Removed ${n.title}`)}
        />
      )}
      <Toast toast={toast} />
    </>
  );
}

type DisruptionBody =
  | { kind: "DELAY"; nodeId: string; delayMinutes: number; reason: string }
  | { kind: "CLOSURE"; nodeId: string; reason: string }
  | { kind: "WEATHER"; fromMinute: number; toMinute: number; reason: string };

function Simulator({
  day,
  selectedId,
  busy,
  onDisruption,
  onWeather,
}: {
  day: DaySchedule;
  selectedId: string | null;
  busy: boolean;
  onDisruption: (d: DisruptionBody) => void;
  onWeather: () => void;
}) {
  const [nodeId, setNodeId] = useState<string>("");
  const [delay, setDelay] = useState(30);
  const [rainFrom, setRainFrom] = useState("14:00");
  const [rainTo, setRainTo] = useState("16:00");
  const target = day.nodes.find((n) => n.id === (nodeId || selectedId)) ?? day.nodes[0];
  const rainValid = /^\d\d:\d\d$/.test(rainFrom) && /^\d\d:\d\d$/.test(rainTo) && toMinutes(rainTo) > toMinutes(rainFrom);

  return (
    <div className="mz-panel mz-stack">
      <div className="mz-panel-title">
        <span className="mz-label">Disruption simulator</span>
        <button className="mz-btn mz-btn-ghost mz-btn-sm" disabled={busy || day.nodes.length === 0} onClick={onWeather} title="Checks the real Open-Meteo forecast for this day">
          Check live forecast
        </button>
      </div>
      {day.nodes.length === 0 ? (
        <p className="mz-small mz-muted" style={{ margin: 0 }}>Add stops to simulate delays, closures and rain.</p>
      ) : (
        <>
          <label className="mz-field">
            <span className="mz-label">Stop</span>
            <select className="mz-select" value={target?.id ?? ""} onChange={(e) => setNodeId(e.target.value)}>
              {day.nodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.timeSlot.start} · {n.title}
                  {n.type === "HARD" ? " (locked)" : ""}
                </option>
              ))}
            </select>
          </label>
          <div className="mz-row" role="group" aria-label="Delay minutes">
            {[15, 30, 45, 60, 90].map((m) => (
              <button key={m} className="mz-chip" aria-pressed={delay === m} onClick={() => setDelay(m)}>
                +{m}
              </button>
            ))}
          </div>
          <div className="mz-row">
            <button className="mz-btn mz-btn-sm" disabled={busy || !target} onClick={() => target && onDisruption({ kind: "DELAY", nodeId: target.id, delayMinutes: delay, reason: `Transit delay of ${delay} min` })}>
              Delay {delay} min
            </button>
            <button className="mz-btn mz-btn-sm" disabled={busy || !target} onClick={() => target && onDisruption({ kind: "CLOSURE", nodeId: target.id, reason: "Venue unexpectedly closed today" })}>
              Venue closed
            </button>
          </div>
          <div className="mz-grid-3" style={{ alignItems: "end" }}>
            <label className="mz-field">
              <span className="mz-label">Rain from</span>
              <input className="mz-input" type="time" step={900} value={rainFrom} onChange={(e) => setRainFrom(e.target.value)} />
            </label>
            <label className="mz-field">
              <span className="mz-label">until</span>
              <input className="mz-input" type="time" step={900} value={rainTo} onChange={(e) => setRainTo(e.target.value)} />
            </label>
            <button
              className="mz-btn mz-btn-sm"
              disabled={busy || !rainValid}
              onClick={() => onDisruption({ kind: "WEATHER", fromMinute: toMinutes(rainFrom), toMinute: toMinutes(rainTo), reason: "Simulated downpour" })}
            >
              Rain
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function VibePanel({ vibe, busy, onSave }: { vibe: VibeConfig; busy: boolean; onSave: (v: VibeConfig) => void }) {
  const [v, setV] = useState(vibe);
  const dirty = JSON.stringify(v) !== JSON.stringify(vibe);
  return (
    <div className="mz-panel mz-stack">
      <div className="mz-panel-title">
        <span className="mz-label">Vibe equalizer</span>
        <button className="mz-btn mz-btn-sm" disabled={!dirty || busy} onClick={() => onSave(v)}>
          Save
        </button>
      </div>
      <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
        Pacing tunes self-healing: fast pacing protects the number of stops; slow pacing would rather skip one than rush it.
      </p>
      {VIBE_FADERS.map((f) => (
        <div key={f.key} className="mz-fader">
          <span className="mz-label">{f.label}</span>
          <input type="range" min={0} max={1} step={0.05} value={v[f.key]} aria-label={f.label} onChange={(e) => setV({ ...v, [f.key]: Number(e.target.value) })} />
          <div className="mz-fader-ends">
            <span>{f.left}</span>
            <span>{f.right}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function AutonomyPanel({ policy, busy, onSave }: { policy: AutonomyPolicy; busy: boolean; onSave: (p: AutonomyPolicy) => void }) {
  const [p, setP] = useState(policy);
  const dirty = JSON.stringify(p) !== JSON.stringify(policy);
  const num = (k: "maxAutoShiftMinutes" | "maxAutoCostIncrease" | "operatorTimeoutMinutes", min: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (Number.isFinite(n) && n >= min) setP({ ...p, [k]: k === "maxAutoCostIncrease" ? n : Math.round(n) });
  };
  return (
    <div className="mz-panel mz-stack">
      <div className="mz-panel-title">
        <span className="mz-label">Autonomy rules for this trip</span>
        <button className="mz-btn mz-btn-sm" disabled={!dirty || busy} onClick={() => onSave(p)}>
          Save
        </button>
      </div>
      <label className="mz-check">
        <input type="checkbox" checked={p.autoApply} onChange={(e) => setP({ ...p, autoApply: e.target.checked })} />
        <span>Auto-apply small fixes (undoable)</span>
      </label>
      <div className="mz-grid-3">
        <label className="mz-field">
          <span className="mz-label">Max auto shift (min)</span>
          <input className="mz-input" type="number" min={0} value={p.maxAutoShiftMinutes} onChange={num("maxAutoShiftMinutes", 0)} />
        </label>
        <label className="mz-field">
          <span className="mz-label">Max auto cost +</span>
          <input className="mz-input" type="number" min={0} step="any" value={p.maxAutoCostIncrease} onChange={num("maxAutoCostIncrease", 0)} />
        </label>
        <label className="mz-field">
          <span className="mz-label">Reply within (min)</span>
          <input className="mz-input" type="number" min={1} value={p.operatorTimeoutMinutes} onChange={num("operatorTimeoutMinutes", 1)} />
        </label>
      </div>
      <label className="mz-check">
        <input type="checkbox" checked={p.fallbackToTraveller} onChange={(e) => setP({ ...p, fallbackToTraveller: e.target.checked })} />
        <span>If I don&apos;t reply in time, let the traveller decide safe items</span>
      </label>
    </div>
  );
}
