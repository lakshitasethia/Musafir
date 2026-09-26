"use client";

import Link from "next/link";
import { useState } from "react";
import { api, hhmm } from "./api";
import { Toast } from "./TopBar";
import { useLive } from "./useLive";

interface QueueItem {
  id: string;
  tripId: string;
  destination: string;
  headline: string;
  context: string;
  createdAt: string;
  operatorDeadline?: string;
  escalated: boolean;
  urgency: string;
  options: { id: string; label: string; patches: unknown[]; risk: { tier: string; reasons: string[] } }[];
}
interface TripSummary {
  id: string;
  destination: string;
  dateRange: { start: string; end: string };
  stops: number;
  owner: string;
  pending: number;
}

export function OpsConsole() {
  const { data, error, live, refresh } = useLive<{ queue: QueueItem[]; trips: TripSummary[] }>("/api/ops/queue", "/api/ops/events");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);

  async function decide(p: QueueItem, decision: "APPLY" | "DISMISS", optionId?: string) {
    setBusy(true);
    try {
      const r = await api<{ stale?: boolean }>(`/api/proposals/${p.id}/decision`, { body: { decision, optionId } });
      setToast({ text: r.stale ? "That plan changed meanwhile — marked out of date" : decision === "APPLY" ? "Approved" : "Dismissed" });
    } catch (e) {
      setToast({ text: (e as Error).message, error: true });
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3000);
      refresh();
    }
  }

  return (
    <>
      <div className="mz-page-head">
        <div className="mz-spread">
          <h1 className="mz-display mz-h1">Operations</h1>
          <span className={`mz-live${live ? " is-on" : ""}`}>
            <i /> {live ? "Live" : "Reconnecting"}
          </span>
        </div>
        <p className="mz-small mz-muted" style={{ margin: 0 }}>
          Items here touch locked bookings, money or vendor issues. Everything else heals automatically or goes to the traveller.
        </p>
      </div>
      {error && <p className="mz-error">{error}</p>}
      <div className="mz-workspace">
        <section className="mz-stack" aria-label="Approval queue">
          <span className="mz-label">Approval queue · {data?.queue.length ?? 0}</span>
          {data?.queue.length === 0 && <div className="mz-empty">Queue is clear.</div>}
          {data?.queue.map((p) => (
            <article key={p.id} className={`mz-card u-${p.urgency}`}>
              <div className="mz-spread">
                <Link href={`/ops/trips/${p.tripId}`} className="mz-label">
                  {p.destination} →
                </Link>
                <span className={`mz-tier ${p.escalated ? "t-TRAVELLER" : "t-OPERATOR"}`}>
                  {p.escalated ? "Overdue" : p.operatorDeadline ? `Reply by ${hhmm(p.operatorDeadline)}` : "Needs review"}
                </span>
              </div>
              <h3 className="mz-display mz-h3">{p.headline}</h3>
              <p className="mz-small mz-muted" style={{ margin: 0 }}>
                {p.context}
              </p>
              {p.options.map((o) => (
                <div key={o.id} className="mz-option">
                  <div className="mz-spread">
                    <strong className="mz-small">{o.label}</strong>
                    <span className={`mz-tier t-${o.risk.tier}`}>{o.risk.tier.toLowerCase()}</span>
                  </div>
                  <div className="mz-row">
                    <button className="mz-btn mz-btn-solid mz-btn-sm" disabled={busy} onClick={() => decide(p, "APPLY", o.id)}>
                      {o.patches.length === 0 ? "Acknowledge" : "Approve"}
                    </button>
                  </div>
                </div>
              ))}
              <div className="mz-row">
                <button className="mz-btn mz-btn-ghost mz-btn-sm" disabled={busy} onClick={() => decide(p, "DISMISS")}>
                  Dismiss
                </button>
                <Link className="mz-btn mz-btn-ghost mz-btn-sm" href={`/ops/trips/${p.tripId}`}>
                  Open trip
                </Link>
              </div>
            </article>
          ))}
        </section>
        <aside className="mz-side mz-stack" aria-label="Trips">
          <span className="mz-label">All trips · {data?.trips.length ?? 0}</span>
          <ul className="mz-list">
            {data?.trips.map((t) => (
              <li key={t.id}>
                <Link className="mz-list-item" href={`/ops/trips/${t.id}`}>
                  <div>
                    <div className="mz-display mz-h3">{t.destination}</div>
                    <div className="mz-tiny mz-muted mz-mono">
                      {t.owner} · {t.dateRange.start} → {t.dateRange.end} · {t.stops} stops
                    </div>
                  </div>
                  {t.pending > 0 && <span className="mz-tier t-TRAVELLER">{t.pending} open</span>}
                </Link>
              </li>
            ))}
          </ul>
        </aside>
      </div>
      <Toast toast={toast} />
    </>
  );
}
