"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { commuteBand, type CommuteBand } from "@/lib/musafir/geo.ts";
import type { DaySchedule, ItineraryNode } from "@/lib/musafir/schemas.ts";
import { fromMinutes, MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";

/**
 * The day as a Flyward-style journey: stops sit at their time (vertical scale is
 * minutes), alternate sides on wide screens, and a hand-drawn route winds through
 * numbered markers. The route draws itself as you scroll. Flexible stops can be
 * dragged (5-min snap) or moved with arrow keys; locked bookings never move.
 */

const SNAP_MIN = 5;
const DRAG_THRESHOLD_PX = 6;
const KEY_STEP_MIN = 15;
const WIDE_PX = 760;
const BAND_COLOR: Record<CommuteBand, string> = { HEALTHY: "var(--mz-sage)", MODERATE: "var(--mz-amber)", SPIKE: "var(--mz-red)" };
const MODE_WORD = { WALK: "walk", SUBWAY: "metro", BUS: "bus", CAB: "cab" } as const;

interface Props {
  day: DaySchedule;
  preview?: DaySchedule | null;
  selectedId?: string | null;
  canDrag: (n: ItineraryNode) => boolean;
  onSelect: (n: ItineraryNode) => void;
  onShift: (n: ItineraryNode, offsetMinutes: number) => void;
}

const startOf = (n: ItineraryNode) => toMinutes(n.timeSlot.start);
const endOf = (n: ItineraryNode) => startOf(n) + n.timeSlot.durationMinutes;

export function JourneyGraph({ day, preview, selectedId, canDrag, onSelect, onShift }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef<SVGPathElement>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<{ id: string; offset: number } | null>(null);
  const origin = useRef<{ y: number; id: string } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);

  const wide = width >= WIDE_PX;
  const pxPerMin = wide ? 2 : 1.7;
  const minBlock = wide ? 150 : 128;

  const { fromHour, toHour } = useMemo(() => {
    const all = [...day.nodes, ...(preview?.nodes ?? [])];
    if (all.length === 0) return { fromHour: 8, toHour: 20 };
    return {
      fromHour: Math.max(0, Math.floor((Math.min(...all.map(startOf)) - 30) / 60)),
      toHour: Math.min(24, Math.ceil((Math.max(...all.map(endOf)) + 60) / 60)),
    };
  }, [day, preview]);

  const y = (minute: number) => (minute - fromHour * 60) * pxPerMin + 24;
  // Blocks keep their time position but never overlap visually on the same side.
  const layout = useMemo(() => {
    const lastBottom = [-Infinity, -Infinity];
    return day.nodes.map((n, i) => {
      const side = wide ? i % 2 : 0;
      const top = Math.max(y(startOf(n)), lastBottom[side] + 16);
      const height = Math.max(minBlock, n.timeSlot.durationMinutes * pxPerMin);
      lastBottom[side] = top + height;
      return { n, side, top, height };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, wide, pxPerMin, fromHour]);
  // The route follows the committed plan; a live drag only moves its own block.
  const offsetOf = (id: string) => (drag?.id === id ? drag.offset : 0);

  const height = Math.max(y(toHour * 60), ...layout.map((l) => l.top + l.height + 40));
  const markerX = (side: number) => (wide ? (side === 0 ? width * 0.47 : width * 0.53) : 22);
  const points = layout.map((l) => ({ x: markerX(l.side), y: l.top + 18 }));

  // A meandering route: each leg swings outward before landing on the next marker.
  const d = useMemo(() => {
    if (points.length === 0 || width === 0) return "";
    const swing = wide ? width * 0.16 : 14;
    let path = `M ${wide ? width * 0.5 : 22} 0 C ${points[0].x} ${points[0].y * 0.4}, ${points[0].x + swing * 0.3} ${points[0].y * 0.6}, ${points[0].x} ${points[0].y}`;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      const dir = i % 2 === 0 ? 1 : -1;
      const my = (a.y + b.y) / 2;
      path += ` C ${a.x + dir * swing} ${a.y + (my - a.y) * 0.5}, ${b.x - dir * swing} ${my + (b.y - my) * 0.5}, ${b.x} ${b.y}`;
    }
    const last = points[points.length - 1];
    path += ` C ${last.x} ${last.y + 60}, ${wide ? width * 0.5 : 22} ${height - 60}, ${wide ? width * 0.5 : 22} ${height}`;
    return path;
  }, [points, width, wide, height]);

  // Draw the route on scroll (GSAP ScrollTrigger, as on the landing page).
  useEffect(() => {
    const path = pathRef.current;
    if (!path || !d) return;
    let cleanup = () => {};
    let cancelled = false;
    (async () => {
      const gsap = (await import("gsap")).default;
      const { ScrollTrigger } = await import("gsap/ScrollTrigger");
      if (cancelled) return;
      gsap.registerPlugin(ScrollTrigger);
      const length = path.getTotalLength();
      path.style.strokeDasharray = `${length}`;
      const tween = gsap.fromTo(
        path,
        { strokeDashoffset: length },
        { strokeDashoffset: 0, ease: "none", scrollTrigger: { trigger: wrapRef.current, start: "top 75%", end: "bottom 60%", scrub: 0.6 } },
      );
      cleanup = () => {
        tween.scrollTrigger?.kill();
        tween.kill();
      };
    })();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [d]);

  const segments = new Map(day.transitSegments.map((s) => [`${s.fromNodeId}>${s.toNodeId}`, s]));
  const previewById = new Map((preview?.nodes ?? []).map((n) => [n.id, n]));
  const clampOffset = (n: ItineraryNode, off: number) => Math.min(MINUTES_PER_DAY - endOf(n), Math.max(-startOf(n), off));

  function onPointerDown(e: React.PointerEvent, n: ItineraryNode) {
    if (e.button !== 0) return;
    origin.current = { y: e.clientY, id: n.id };
    if (canDrag(n)) (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent, n: ItineraryNode) {
    const o = origin.current;
    if (!o || o.id !== n.id || !canDrag(n)) return;
    const dy = e.clientY - o.y;
    if (!drag && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
    setDrag({ id: n.id, offset: clampOffset(n, Math.round(dy / pxPerMin / SNAP_MIN) * SNAP_MIN) });
  }
  function onPointerUp(n: ItineraryNode) {
    const dr = drag;
    origin.current = null;
    setDrag(null);
    if (dr && dr.id === n.id) {
      if (dr.offset !== 0) onShift(n, dr.offset);
    } else onSelect(n);
  }

  return (
    <div ref={wrapRef} className={`mz-journey${wide ? " is-wide" : ""}`} style={{ height: day.nodes.length ? height : undefined }}>
      {day.nodes.length === 0 && !preview?.nodes.length ? null : (
        <>
          <svg className="mz-journey-route" width={width} height={height} aria-hidden="true">
            <path d={d} stroke="#d1c2ab" strokeWidth={wide ? 4 : 3} fill="none" strokeLinecap="round" opacity={0.25} />
            <path ref={pathRef} d={d} stroke="#d1c2ab" strokeWidth={wide ? 4 : 3} fill="none" strokeLinecap="round" />
          </svg>

          {wide && layout.slice(1).map((l, i) => {
            const prev = layout[i];
            const seg = segments.get(`${prev.n.id}>${l.n.id}`);
            if (!seg) return null;
            const band = commuteBand(seg.durationMinutes);
            const tight = startOf(l.n) - endOf(prev.n) < seg.durationMinutes;
            const my = (points[i].y + points[i + 1].y) / 2;
            return (
              <span
                key={`leg-${l.n.id}`}
                className={`mz-leg${tight ? " is-tight" : ""}`}
                style={{ top: my, left: width / 2, color: BAND_COLOR[band] }}
                title={`${Math.round(seg.distanceMeters)} m · fatigue ${seg.fatigueScore}/100`}
              >
                <i style={{ background: BAND_COLOR[band] }} />
                {seg.durationMinutes} min {MODE_WORD[seg.mode]}
                {tight ? " · tight" : ""}
              </span>
            );
          })}

          {layout.map((l, i) => {
            const n = l.n;
            const removed = !!preview && !previewById.has(n.id);
            const offset = offsetOf(n.id);
            const shown = startOf(n) + offset;
            const cls = [
              "mz-stop",
              l.side === 1 ? "is-right" : "is-left",
              n.type === "HARD" ? "is-hard" : "",
              selectedId === n.id ? "is-selected" : "",
              drag?.id === n.id ? "is-dragging" : "",
              removed ? "is-removed" : "",
              canDrag(n) ? "is-draggable" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={n.id}
                type="button"
                className={cls}
                style={{ top: l.top + offset * pxPerMin, minHeight: l.height, ...(wide ? {} : { left: 52 }) }}
                onPointerDown={(e) => onPointerDown(e, n)}
                onPointerMove={(e) => onPointerMove(e, n)}
                onPointerUp={() => onPointerUp(n)}
                onPointerCancel={() => {
                  origin.current = null;
                  setDrag(null);
                }}
                onKeyDown={(e) => {
                  if (!canDrag(n) || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
                  e.preventDefault();
                  const off = clampOffset(n, e.key === "ArrowUp" ? -KEY_STEP_MIN : KEY_STEP_MIN);
                  if (off !== 0) onShift(n, off);
                }}
                onClick={(e) => {
                  if (e.detail === 0) onSelect(n);
                }}
                aria-label={`Stop ${i + 1}: ${n.title}, ${fromMinutes(shown)} for ${n.timeSlot.durationMinutes} minutes${n.type === "HARD" ? ", reserved" : ""}${canDrag(n) ? ". Drag or use arrow keys to move." : ""}`}
              >
                {!wide && i > 0 && (() => {
                  const seg = segments.get(`${layout[i - 1].n.id}>${n.id}`);
                  if (!seg) return null;
                  const tight = startOf(n) - endOf(layout[i - 1].n) < seg.durationMinutes;
                  return (
                    <span className="mz-stop-leg" style={{ color: BAND_COLOR[commuteBand(seg.durationMinutes)] }}>
                      ↑ {seg.durationMinutes} min {MODE_WORD[seg.mode]} from previous{tight ? " · tight" : ""}
                    </span>
                  );
                })()}
                <span className="mz-marker" style={wide ? { [l.side === 0 ? "right" : "left"]: -22 } : { left: -52 }}>
                  {i + 1}
                </span>
                <span className="mz-stop-time mz-mono">
                  {fromMinutes(shown)} — {fromMinutes(Math.min(MINUTES_PER_DAY - 1, shown + n.timeSlot.durationMinutes))}
                  {offset !== 0 ? `  (${offset > 0 ? "+" : ""}${offset})` : ""}
                </span>
                <span className="mz-stop-title">{n.title}</span>
                {n.nativeTitle && <span className="mz-stop-native">{n.nativeTitle}</span>}
                <span className="mz-stop-meta">
                  {n.type === "HARD" ? "Reserved · " : ""}
                  {n.category.toLowerCase()}
                  {n.isOutdoor ? " · outdoors" : ""}
                  {n.metadata?.plannedBy === "planner" ? " · planned by Musafir" : ""}
                </span>
              </button>
            );
          })}

          {preview?.nodes
            .filter((p) => {
              const cur = day.nodes.find((n) => n.id === p.id);
              return !cur || cur.timeSlot.start !== p.timeSlot.start || cur.timeSlot.durationMinutes !== p.timeSlot.durationMinutes;
            })
            .map((p) => {
              const cur = layout.find((l) => l.n.id === p.id);
              const side = cur?.side ?? 0;
              return (
                <div
                  key={`ghost-${p.id}`}
                  className={`mz-stop is-ghost ${side === 1 ? "is-right" : "is-left"}`}
                  style={{ top: y(startOf(p)), minHeight: Math.max(minBlock * 0.6, p.timeSlot.durationMinutes * pxPerMin), ...(wide ? {} : { left: 52 }) }}
                  aria-hidden="true"
                >
                  <span className="mz-stop-time mz-mono">
                    Proposed · {p.timeSlot.start} — {fromMinutes(Math.min(MINUTES_PER_DAY - 1, endOf(p)))}
                  </span>
                  <span className="mz-stop-title">{p.title}</span>
                </div>
              );
            })}
        </>
      )}
    </div>
  );
}
