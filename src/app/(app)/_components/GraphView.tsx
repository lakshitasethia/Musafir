"use client";

/**
 * Force-directed view of the live Neo4j trip graph (no library: a small
 * spring/charge simulation drawn in SVG). Nodes are coloured by label like
 * Neo4j Browser; drag nodes, wheel to zoom, drag the background to pan, click
 * to select.
 */
import { useEffect, useMemo, useRef, useState } from "react";

export interface GNode {
  id: string;
  label: "User" | "Trip" | "Day" | "Stop" | "Proposal";
  title: string;
  sub?: string;
  props: Record<string, string | number | boolean | null>;
}
export interface GEdge {
  from: string;
  to: string;
  type: string;
  label?: string;
}

const STYLE: Record<GNode["label"], { r: number; fill: string }> = {
  User: { r: 18, fill: "#3d2d20" },
  Trip: { r: 16, fill: "#4b6b94" },
  Day: { r: 10, fill: "#c98a45" },
  Stop: { r: 7, fill: "#5e8b72" },
  Proposal: { r: 9, fill: "#b8534f" },
};
const W = 900;
const H = 560;

interface P {
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed?: boolean;
}

export function GraphView({ nodes, edges, selected, onSelect }: { nodes: GNode[]; edges: GEdge[]; selected?: string | null; onSelect: (n: GNode | null) => void }) {
  const pos = useRef(new Map<string, P>());
  // Render from a snapshot (refs can't be read during render).
  const [snap, setSnap] = useState<Map<string, { x: number; y: number }>>(new Map());
  const publish = () => setSnap(new Map([...pos.current].map(([k, v]) => [k, { x: v.x, y: v.y }])));
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ id: string | null; sx: number; sy: number; vx: number; vy: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const key = useMemo(() => nodes.map((n) => n.id).join("|") + "#" + edges.length, [nodes, edges]);

  // (Re)seed positions: keep known nodes where they are, place new ones near a neighbour.
  useEffect(() => {
    const m = pos.current;
    for (const id of [...m.keys()]) if (!nodes.some((n) => n.id === id)) m.delete(id);
    nodes.forEach((n, i) => {
      if (m.has(n.id)) return;
      const nb = edges.find((e) => e.to === n.id && m.has(e.from)) ?? edges.find((e) => e.from === n.id && m.has(e.to));
      const anchor = nb ? m.get(nb.to === n.id ? nb.from : nb.to)! : { x: W / 2, y: H / 2 };
      const a = (i * 2.399) % (Math.PI * 2);
      m.set(n.id, { x: anchor.x + Math.cos(a) * 40, y: anchor.y + Math.sin(a) * 40, vx: 0, vy: 0 });
    });
    let frame = 0;
    let raf = 0;
    const idx = new Map(nodes.map((n) => [n.id, n]));
    const step = () => {
      const alpha = Math.max(0.02, 1 - frame / 260);
      const list = nodes.map((n) => [n, m.get(n.id)!] as const);
      // Charge (repulsion), O(n²) — fine for a few hundred nodes.
      for (let i = 0; i < list.length; i++) {
        const [, a] = list[i];
        for (let j = i + 1; j < list.length; j++) {
          const [, b] = list[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) {
            dx = Math.random() - 0.5;
            dy = Math.random() - 0.5;
            d2 = 1;
          }
          const f = (900 * alpha) / d2;
          a.vx -= dx * f;
          a.vy -= dy * f;
          b.vx += dx * f;
          b.vy += dy * f;
        }
      }
      // Springs along relationships.
      for (const e of edges) {
        const a = m.get(e.from);
        const b = m.get(e.to);
        if (!a || !b) continue;
        const want = e.type === "HAS_STOP" ? 34 : e.type === "NEXT" ? 30 : e.type === "HAS_DAY" ? 55 : 80;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = ((d - want) / d) * 0.06 * alpha;
        a.vx += dx * f;
        a.vy += dy * f;
        b.vx -= dx * f;
        b.vy -= dy * f;
      }
      for (const [n, p] of list) {
        // Gentle pull to the centre so separate trips stay on screen.
        p.vx += (W / 2 - p.x) * 0.002 * alpha;
        p.vy += (H / 2 - p.y) * 0.002 * alpha;
        if (p.fixed || drag.current?.id === n.id) {
          p.vx = p.vy = 0;
          continue;
        }
        p.vx *= 0.6;
        p.vy *= 0.6;
        p.x += p.vx;
        p.y += p.vy;
      }
      void idx;
      frame++;
      publish();
      if (frame < 320) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toGraph = (clientX: number, clientY: number) => {
    const r = svg.current!.getBoundingClientRect();
    const sx = ((clientX - r.left) / r.width) * W;
    const sy = ((clientY - r.top) / r.height) * H;
    return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
  };

  const p = (id: string) => snap.get(id);
  const sel = selected ?? null;
  const neighbours = useMemo(() => {
    if (!sel) return null;
    const s = new Set([sel]);
    for (const e of edges) {
      if (e.from === sel) s.add(e.to);
      if (e.to === sel) s.add(e.from);
    }
    return s;
  }, [sel, edges]);

  return (
    <svg
      ref={svg}
      className="mz-graph"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="Trip graph from Neo4j"
      onWheel={(e) => {
        const k = Math.min(4, Math.max(0.3, view.k * (e.deltaY < 0 ? 1.12 : 0.89)));
        const r = svg.current!.getBoundingClientRect();
        const sx = ((e.clientX - r.left) / r.width) * W;
        const sy = ((e.clientY - r.top) / r.height) * H;
        setView({ k, x: sx - ((sx - view.x) / view.k) * k, y: sy - ((sy - view.y) / view.k) * k });
      }}
      onPointerDown={(e) => {
        if ((e.target as Element).closest("[data-node]")) return;
        drag.current = { id: null, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        if (d.id) {
          const g = toGraph(e.clientX, e.clientY);
          const q = pos.current.get(d.id);
          if (q) {
            q.x = g.x;
            q.y = g.y;
            publish();
          }
        } else {
          const r = svg.current!.getBoundingClientRect();
          setView((v) => ({ ...v, x: d.vx + ((e.clientX - d.sx) / r.width) * W, y: d.vy + ((e.clientY - d.sy) / r.height) * H }));
        }
      }}
      onPointerUp={(e) => {
        const d = drag.current;
        drag.current = null;
        if (d && !d.id && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) onSelect(null);
      }}
    >
      <g transform={`translate(${view.x},${view.y}) scale(${view.k})`}>
        {edges.map((e, i) => {
          const a = p(e.from);
          const b = p(e.to);
          if (!a || !b) return null;
          const dim = neighbours && !(neighbours.has(e.from) && neighbours.has(e.to));
          return (
            <g key={i} opacity={dim ? 0.12 : 1}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`mz-graph-edge t-${e.type}`} />
              {e.type === "NEXT" && e.label && view.k > 1.3 && (
                <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} className="mz-graph-edge-label">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const q = p(n.id);
          if (!q) return null;
          const s = STYLE[n.label];
          const dim = neighbours && !neighbours.has(n.id);
          return (
            <g
              key={n.id}
              data-node
              transform={`translate(${q.x},${q.y})`}
              opacity={dim ? 0.2 : 1}
              style={{ cursor: "pointer" }}
              onPointerDown={(e) => {
                e.stopPropagation();
                drag.current = { id: n.id, sx: e.clientX, sy: e.clientY, vx: 0, vy: 0 };
                (e.currentTarget.ownerSVGElement as Element).setPointerCapture(e.pointerId);
              }}
              onPointerUp={(e) => {
                const d = drag.current;
                if (d?.id === n.id && Math.abs(e.clientX - d.sx) + Math.abs(e.clientY - d.sy) < 4) onSelect(n);
              }}
            >
              <circle r={s.r} fill={s.fill} stroke={sel === n.id ? "#1c2124" : "#fbf8f3"} strokeWidth={sel === n.id ? 3 : 1.5} />
              {n.props.verified === true && <circle r={s.r + 4} fill="none" stroke="#5e8b72" strokeWidth={2} strokeDasharray="3 2" />}
              {(n.label !== "Stop" || view.k > 1.1 || sel === n.id) && (
                <text y={s.r + 11} textAnchor="middle" className="mz-graph-label">
                  {n.title.length > 22 ? `${n.title.slice(0, 21)}…` : n.title}
                </text>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export const GRAPH_LEGEND = STYLE;
