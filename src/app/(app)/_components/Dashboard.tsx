"use client";

/**
 * Personal dashboard (traveller: your trips; operator: the fleet), drawn from
 * the live Neo4j graph. Click a node to act on it: open a trip or day, remove
 * a stop, verify a trip (operators).
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { newId } from "@/lib/musafir/ids.ts";
import { api } from "./api";
import { GRAPH_LEGEND, GraphView, type GEdge, type GNode } from "./GraphView";
import { Toast } from "./TopBar";

interface Node extends GNode {
  tripId?: string;
  dayIndex?: number;
}
interface Graph {
  source: "neo4j" | "file";
  cypher?: string;
  nodes: Node[];
  edges: GEdge[];
  stats: { users: number; trips: number; days: number; stops: number; openCards: number; verifiedTrips: number; advisoriesForReview: number };
}

export function Dashboard({ role }: { role: "traveller" | "operator" }) {
  const [g, setG] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState<Node | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const tripHref = (id: string) => (role === "operator" ? `/ops/trips/${id}` : `/trip/${id}`);

  const load = useCallback(async () => {
    try {
      setG(await api<Graph>("/api/graph"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  const say = (text: string, err = false) => {
    setToast({ text, error: err });
    setTimeout(() => setToast(null), 3000);
  };

  async function removeStop(n: Node) {
    if (!n.tripId || n.dayIndex === undefined) return;
    setBusy(true);
    try {
      const b = await api<{ trip: { version: number } }>(`/api/trips/${n.tripId}`);
      await api(`/api/trips/${n.tripId}/days/${n.dayIndex}/patches`, {
        body: { baseVersion: b.trip.version, patches: [{ patchId: newId(), targetDayIndex: n.dayIndex, operation: "REMOVE", nodeId: String(n.props.nodeId), reason: `Removed "${n.title}" from the dashboard` }] },
      });
      say(`Removed ${n.title}`);
      setSel(null);
      await load();
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  async function verify(n: Node, verified: boolean) {
    if (!n.tripId) return;
    setBusy(true);
    try {
      await api(`/api/trips/${n.tripId}/verify`, { body: { verified } });
      say(verified ? "Trip verified" : "Verification cleared");
      await load();
      setSel((s) => (s ? { ...s, props: { ...s.props, verified } } : s));
    } catch (e) {
      say((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  }

  const tiles = useMemo(() => {
    if (!g) return [];
    const s = g.stats;
    return role === "operator"
      ? [
          ["Travellers", s.users],
          ["Trips", s.trips],
          ["Stops", s.stops],
          ["Open cards", s.openCards],
          ["Weather to review", s.advisoriesForReview],
          ["Verified trips", s.verifiedTrips],
        ]
      : [
          ["Trips", s.trips],
          ["Days", s.days],
          ["Stops", s.stops],
          ["Open cards", s.openCards],
        ];
  }, [g, role]);

  return (
    <div className="mz-stack">
      <div className="mz-page-head">
        <h1 className="mz-display mz-h1">{role === "operator" ? "Fleet dashboard" : "My dashboard"}</h1>
        <p className="mz-small mz-muted" style={{ margin: 0 }}>
          {g?.source === "neo4j" ? "Live from Neo4j" : g ? "From the local store" : "Loading…"} · {role === "operator" ? "every recent trip" : "your trips"} as a graph. Click anything.
        </p>
      </div>
      {error && <p className="mz-error">{error}</p>}
      {g && (
        <>
          <div className="mz-dash-tiles">
            {tiles.map(([k, v]) => (
              <div key={k} className="mz-dash-tile">
                <span className="mz-display mz-h2">{v}</span>
                <span className="mz-label">{k}</span>
              </div>
            ))}
          </div>
          <div className="mz-dash">
            <div className="mz-panel mz-dash-graph">
              {g.nodes.length === 0 ? (
                <p className="mz-muted">
                  No trips yet. <Link href={role === "operator" ? "/ops" : "/trip"}>{role === "operator" ? "Open operations" : "Plan one"}</Link>
                </p>
              ) : (
                <GraphView nodes={g.nodes} edges={g.edges} selected={sel?.id} onSelect={(n) => setSel(n as Node | null)} />
              )}
              <div className="mz-row mz-dash-legend" style={{ flexWrap: "wrap" }}>
                {Object.entries(GRAPH_LEGEND).map(([label, s]) => (
                  <span key={label} className="mz-tiny">
                    <i style={{ background: s.fill }} /> {label}
                  </span>
                ))}
              </div>
            </div>
            <aside className="mz-panel mz-stack mz-dash-side" aria-label="Selected">
              {!sel ? (
                <p className="mz-small mz-muted" style={{ margin: 0 }}>
                  Select a node. Drag to rearrange, scroll to zoom.
                </p>
              ) : (
                <>
                  <span className="mz-label">{sel.label}</span>
                  <h2 className="mz-display mz-h3" style={{ margin: 0 }}>
                    {sel.title}
                  </h2>
                  {sel.sub && <p className="mz-small mz-muted" style={{ margin: 0 }}>{sel.sub}</p>}
                  <div className="mz-row" style={{ flexWrap: "wrap" }}>
                    {sel.tripId && (
                      <Link className="mz-btn mz-btn-solid mz-btn-sm" href={tripHref(sel.tripId)}>
                        {sel.label === "Stop" ? "Edit in the planner" : "Open trip"}
                      </Link>
                    )}
                    {sel.label === "Stop" && !(role === "traveller" && sel.props.locked) && (
                      <button className="mz-btn mz-btn-ghost mz-btn-sm" disabled={busy} onClick={() => removeStop(sel)}>
                        Remove stop
                      </button>
                    )}
                    {role === "operator" && sel.label === "Trip" && (
                      <button className="mz-btn mz-btn-ghost mz-btn-sm" disabled={busy} onClick={() => verify(sel, !sel.props.verified)}>
                        {sel.props.verified ? "Clear verification" : "Verify trip"}
                      </button>
                    )}
                  </div>
                </>
              )}
              {g.cypher && (
                <details>
                  <summary className="mz-label">Cypher behind this view</summary>
                  <pre className="mz-tiny mz-mono mz-cypher">{g.cypher}</pre>
                </details>
              )}
            </aside>
          </div>
        </>
      )}
      <Toast toast={toast} />
    </div>
  );
}
