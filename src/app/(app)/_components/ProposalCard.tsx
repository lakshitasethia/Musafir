"use client";

import type { TripBundle } from "@/server/trips.ts";
import { hhmm } from "./api";

type Proposal = TripBundle["proposals"][number];

const TIER_TEXT = { AUTO: "Automatic", TRAVELLER: "Traveller's call", OPERATOR: "Operator approval" } as const;
const STATUS_TEXT: Record<Proposal["status"], string> = {
  PENDING: "Waiting",
  AUTO_APPLIED: "Applied automatically",
  APPLIED: "Applied",
  DISMISSED: "Dismissed",
  STALE: "Out of date — the plan changed",
  UNDONE: "Undone",
};

interface Props {
  proposal: Proposal;
  titles: Map<string, string>;
  previewing: string | null;
  busy: boolean;
  onPreview: (optionId: string | null) => void;
  onApply: (optionId: string) => void;
  onDismiss: () => void;
  onUndo: () => void;
}

export function ProposalCard({ proposal: p, titles, previewing, busy, onPreview, onApply, onDismiss, onUndo }: Props) {
  const open = p.status === "PENDING";
  const deadline = p.operatorDeadline ? new Date(p.operatorDeadline) : null;
  return (
    <article className={`mz-card u-${p.urgency}${open ? "" : " is-closed"}`}>
      <div className="mz-spread">
        <span className="mz-status">
          {STATUS_TEXT[p.status]} · {hhmm(p.createdAt)}
        </span>
        {p.escalated && <span className="mz-tier t-TRAVELLER">Operator didn&apos;t respond — your call</span>}
      </div>
      <h3 className="mz-display mz-h3">{p.headline}</h3>
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        {p.context}
      </p>
      {open && deadline && !p.escalated && <p className="mz-tiny mz-muted" style={{ margin: 0 }}>Operator asked to respond by {hhmm(deadline.toISOString())}</p>}

      {(p.agentStatus === "RUNNING" || p.agentNote) && (
        <div className="mz-agent">
          {p.agentStatus === "RUNNING" && <span className="mz-pulse" />}
          <span>Agent: {p.agentNote ?? "working…"}</span>
        </div>
      )}

      {p.options.map((o, i) => {
        const allowed = p.canDecide[i];
        const applied = p.appliedOptionId === o.id;
        return (
          <div key={o.id} className="mz-option">
            <div className="mz-spread">
              <strong className="mz-small">{o.label}</strong>
              <span className={`mz-tier t-${o.risk.tier}`}>{TIER_TEXT[o.risk.tier]}</span>
            </div>
            {o.rationale && <p className="mz-small" style={{ margin: 0 }}>{o.rationale}</p>}
            {o.rankedBy && <p className="mz-tiny mz-muted" style={{ margin: 0 }}>Chosen by {o.rankedBy}</p>}
            {o.patches.length > 0 && (
              <ul className="mz-patch-list">
                {o.patches.map((x) => (
                  <li key={x.patchId}>
                    {x.operation === "REMOVE"
                      ? `Skip ${titles.get(x.nodeId ?? "") ?? "stop"}`
                      : x.operation === "INSERT"
                        ? `Add ${x.payload?.title} at ${x.payload?.timeSlot.start}`
                        : x.operation === "SHIFT_TIME"
                          ? `${titles.get(x.nodeId ?? "")} ${x.shiftOffsetMinutes! > 0 ? "+" : ""}${x.shiftOffsetMinutes} min`
                          : `${titles.get(x.nodeId ?? "")} → ${x.payload?.timeSlot.start}, ${x.payload?.timeSlot.durationMinutes} min`}
                  </li>
                ))}
              </ul>
            )}
            {o.conflicts.filter((c) => c.code !== "INPUT_OVERLAP" && c.code !== "SOFT_NODE_DROPPED").map((c) => (
              <p key={c.code + c.nodeId} className="mz-tiny" style={{ margin: 0, color: "var(--mz-red)" }}>
                {c.message}
              </p>
            ))}
            {open && (
              <div className="mz-row">
                {o.patches.length > 0 && (
                  <button className="mz-btn mz-btn-ghost mz-btn-sm" aria-pressed={previewing === o.id} onClick={() => onPreview(previewing === o.id ? null : o.id)}>
                    {previewing === o.id ? "Hide preview" : "Preview"}
                  </button>
                )}
                <button className="mz-btn mz-btn-solid mz-btn-sm" disabled={!allowed || busy} onClick={() => onApply(o.id)} title={allowed ? undefined : "Needs your operator"}>
                  {o.patches.length === 0 ? "Acknowledge" : "Apply"}
                </button>
              </div>
            )}
            {applied && <span className="mz-tiny mz-muted">Chosen by {p.decidedBy}</span>}
          </div>
        );
      })}

      {(open || p.undoable) && (
        <div className="mz-row">
          {open && (
            <button className="mz-btn mz-btn-ghost mz-btn-sm" disabled={busy} onClick={onDismiss}>
              Dismiss
            </button>
          )}
          {p.undoable && (
            <button className="mz-btn mz-btn-ghost mz-btn-sm" disabled={busy} onClick={onUndo}>
              Undo
            </button>
          )}
        </div>
      )}
    </article>
  );
}
