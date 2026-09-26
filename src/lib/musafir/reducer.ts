/**
 * Canonical Trip Graph Reducer: deterministic self-healing for one day.
 *
 * A day is a chain of temporal nodes ordered by start time (ties keep input order).
 * Invariants:
 *  - HARD nodes never move and are never dropped by the engine.
 *  - The input is never mutated; output is TripPatch[] + a preview day.
 *
 * Disruptions:
 *  - DELAY: the traveller reaches a SOFT stop `delayMinutes` late. From then on
 *    nothing can start before that moment (the "availability floor"), even if
 *    the delayed stop itself is skipped. A delay on a HARD stop only reports
 *    HARD_ANCHOR_LATE.
 *  - CLOSURE: a SOFT stop is removed (replacement is an agent's job). A closed
 *    HARD stop is reported as HARD_VENUE_CLOSED for an operator.
 *  - WEATHER: outdoor SOFT stops overlapping [fromMinute, toMinute) are moved to
 *    after the window and the day is re-ordered around them. Outdoor HARD stops
 *    are reported as WEATHER_EXPOSED_LOCKED.
 *
 * Recovery between locked anchors is a min-cost search, not a fixed recipe.
 * For every subset of droppable SOFT stops in a segment (enumerated up to
 * `maxEnumerateItems`, greedy by priority above that) the segment is laid out,
 * visits are compressed by up to their `bufferMinutes` latest-first if needed,
 * and the feasible option with the lowest cost wins:
 *     cost = Σ dropped  dropWeight × priority
 *          + Σ kept     trimWeight × compressedMinutes + shiftWeight × |moved minutes|
 * Ties: fewer drops, then dropping later stops. Weights come from HealingPolicy,
 * which `policyFromVibe` derives from the traveller's Vibe Equalizer.
 *
 * Transit gaps: for pairs adjacent in the original plan the required gap is
 * min(transit estimate, original gap), so estimates never amplify a delay the
 * plan already allowed for. New adjacencies use the full transit estimate.
 */
import {
  DayScheduleSchema,
  TripPatchSchema,
  type DaySchedule,
  type DayScheduleInput,
  type ItineraryNode,
  type TripPatch,
  type VibeConfig,
} from "./schemas.ts";
import { MINUTES_PER_DAY, fromMinutes, isRepresentableMinute, toMinutes } from "./time.ts";
import { dailyFatigueScore, estimateLeg, rebuildTransitSegments, type LegLookup } from "./geo.ts";
import { newId } from "./ids.ts";

export interface HealingPolicy {
  /** Cost of dropping a stop whose priority is 1. */
  dropWeight: number;
  /** Cost per minute a visit is compressed. */
  trimWeight: number;
  /** Cost per minute a kept stop moves from its planned start. */
  shiftWeight: number;
  /** Priority for stops without `metadata.priority` (0–1). */
  defaultPriority: number;
  /** Visits are never compressed below this. */
  minVisitMinutes: number;
  /** Segments larger than this use greedy drop selection instead of full enumeration. */
  maxEnumerateItems: number;
}

export const DEFAULT_HEALING_POLICY: HealingPolicy = {
  dropWeight: 120,
  trimWeight: 1,
  shiftWeight: 0.2,
  defaultPriority: 0.5,
  minVisitMinutes: 15,
  maxEnumerateItems: 10,
};
/** @deprecated use HealingPolicy.minVisitMinutes */
export const MIN_VISIT_MINUTES = DEFAULT_HEALING_POLICY.minVisitMinutes;

/**
 * Fast-paced travellers value the number of stops, so dropping costs more and
 * compressing less; slow travellers would rather lose a stop than rush one.
 */
export function policyFromVibe(vibe: Pick<VibeConfig, "pacing">): HealingPolicy {
  const pacing = Math.min(1, Math.max(0, vibe.pacing));
  return {
    ...DEFAULT_HEALING_POLICY,
    dropWeight: 60 + 120 * pacing,
    trimWeight: 1.5 - pacing,
  };
}

export type Disruption =
  | { kind: "DELAY"; nodeId: string; delayMinutes: number; reason: string }
  | { kind: "CLOSURE"; nodeId: string; reason: string }
  | { kind: "WEATHER"; fromMinute: number; toMinute: number; reason: string };

export interface DelayDisruption {
  nodeId: string;
  delayMinutes: number;
  reason: string;
}

export type ConflictCode =
  | "INPUT_OVERLAP"
  | "HARD_ANCHOR_LATE"
  | "HARD_ANCHOR_UNREACHABLE"
  | "HARD_VENUE_CLOSED"
  | "WEATHER_EXPOSED_LOCKED"
  | "SOFT_NODE_DROPPED"
  | "PAST_END_OF_DAY";

export interface Conflict {
  code: ConflictCode;
  nodeId: string;
  /** Minutes of lateness / overflow where applicable. */
  minutes?: number;
  message: string;
}

export interface CascadeOptions {
  /** Latest minute any node may end at. Default 1440 (midnight). */
  dayEndMinute?: number;
  /** Door-to-door minutes between two nodes. Default: known segment, else Haversine estimate. */
  transitMinutes?: (from: ItineraryNode, to: ItineraryNode) => number;
  idFactory?: () => string;
  policy?: Partial<HealingPolicy>;
  /** Routed legs (e.g. cached OSRM) used for the preview's transit segments. */
  routed?: LegLookup;
}

export interface CascadeResult {
  patches: TripPatch[];
  conflicts: Conflict[];
  /** The day with patches applied (not persisted anywhere). */
  preview: DaySchedule;
  /** Nodes the disruption touched directly (before any cascade). */
  affectedNodeIds: string[];
}

export class ScheduleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleError";
  }
}

interface Slot {
  node: ItineraryNode;
  /** Position in the sorted original plan. */
  order: number;
  origStart: number;
  origDuration: number;
  minStart: number;
  start: number;
  duration: number;
  removed: boolean;
  priority: number;
}

const endOf = (s: Pick<Slot, "start" | "duration">) => s.start + s.duration;

export function sortNodes(nodes: readonly ItineraryNode[]): ItineraryNode[] {
  return nodes
    .map((node, i) => ({ node, i, start: toMinutes(node.timeSlot.start) }))
    .sort((a, b) => a.start - b.start || a.i - b.i)
    .map((x) => x.node);
}

function assertUniqueIds(nodes: readonly ItineraryNode[]) {
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) throw new ScheduleError(`Duplicate node id ${n.id}`);
    seen.add(n.id);
  }
}

export function nodePriority(node: ItineraryNode, fallback: number): number {
  const p = node.metadata?.priority;
  return typeof p === "number" && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : fallback;
}

const popcount = (m: number) => {
  let c = 0;
  for (let x = m; x; x &= x - 1) c++;
  return c;
};

/** Backwards-compatible entry point for a DELAY disruption. */
export function cascadeDelay(
  dayInput: DayScheduleInput,
  disruption: DelayDisruption,
  options: CascadeOptions = {},
): CascadeResult {
  return heal(dayInput, { kind: "DELAY", ...disruption }, options);
}

export function heal(dayInput: DayScheduleInput, disruption: Disruption, options: CascadeOptions = {}): CascadeResult {
  const day = DayScheduleSchema.parse(dayInput);
  assertUniqueIds(day.nodes);

  const policy: HealingPolicy = { ...DEFAULT_HEALING_POLICY, ...options.policy };
  const dayEnd = options.dayEndMinute ?? MINUTES_PER_DAY;
  if (!Number.isInteger(dayEnd) || dayEnd <= 0 || dayEnd > MINUTES_PER_DAY) {
    throw new ScheduleError(`dayEndMinute must be an integer in (0, ${MINUTES_PER_DAY}]`);
  }
  const idFactory = options.idFactory ?? newId;
  const knownSegments = new Map(day.transitSegments.map((s) => [`${s.fromNodeId}>${s.toNodeId}`, s.durationMinutes]));
  const transit =
    options.transitMinutes ??
    ((a: ItineraryNode, b: ItineraryNode) =>
      options.routed?.(a, b)?.durationMinutes ?? knownSegments.get(`${a.id}>${b.id}`) ?? estimateLeg(a.location, b.location).durationMinutes);

  const slots: Slot[] = sortNodes(day.nodes).map((node, order) => {
    const start = toMinutes(node.timeSlot.start);
    const duration = node.timeSlot.durationMinutes;
    return {
      node,
      order,
      origStart: start,
      origDuration: duration,
      minStart: start,
      start,
      duration,
      removed: false,
      priority: nodePriority(node, policy.defaultPriority),
    };
  });
  const byId = new Map(slots.map((s) => [s.node.id, s]));

  const conflicts: Conflict[] = [];
  for (let i = 1; i < slots.length; i++) {
    const overlap = endOf(slots[i - 1]) - slots[i].start;
    if (overlap > 0) {
      conflicts.push({
        code: "INPUT_OVERLAP",
        nodeId: slots[i].node.id,
        minutes: overlap,
        message: `"${slots[i].node.title}" starts ${overlap} min before "${slots[i - 1].node.title}" ends`,
      });
    }
  }

  const affected: string[] = [];
  const finish = (): CascadeResult => {
    const patches = buildPatches(slots, day.dayIndex, disruption.reason, idFactory);
    return { patches, conflicts, preview: applyPatches(day, patches, { routed: options.routed }), affectedNodeIds: affected };
  };
  const requireSlot = (id: string) => {
    const s = byId.get(id);
    if (!s) throw new ScheduleError(`Node ${id} is not in day ${day.dayIndex}`);
    return s;
  };

  // ── Translate the disruption into minStart changes ─────────────────
  let origin: Slot | null = null; // availability floor source (DELAY only)
  let reorder = false;
  switch (disruption.kind) {
    case "DELAY": {
      const { delayMinutes } = disruption;
      if (!Number.isInteger(delayMinutes) || delayMinutes < 0) {
        throw new ScheduleError(`delayMinutes must be a non-negative integer, got ${delayMinutes}`);
      }
      const target = requireSlot(disruption.nodeId);
      affected.push(target.node.id);
      if (delayMinutes === 0) return finish();
      if (target.node.type === "HARD") {
        conflicts.push({
          code: "HARD_ANCHOR_LATE",
          nodeId: target.node.id,
          minutes: delayMinutes,
          message: `"${target.node.title}" is a locked booking; arrival is ${delayMinutes} min late and it cannot be moved`,
        });
        return finish();
      }
      target.minStart = target.origStart + delayMinutes;
      origin = target;
      break;
    }
    case "CLOSURE": {
      const target = requireSlot(disruption.nodeId);
      affected.push(target.node.id);
      if (target.node.type === "HARD") {
        conflicts.push({
          code: "HARD_VENUE_CLOSED",
          nodeId: target.node.id,
          message: `Locked booking "${target.node.title}" is closed; an operator needs to rebook or refund`,
        });
      } else {
        target.removed = true;
      }
      return finish();
    }
    case "WEATHER": {
      const { fromMinute, toMinute } = disruption;
      if (!Number.isInteger(fromMinute) || !Number.isInteger(toMinute) || fromMinute < 0 || toMinute <= fromMinute) {
        throw new ScheduleError(`Weather window must be integers with 0 ≤ from < to, got ${fromMinute}–${toMinute}`);
      }
      for (const s of slots) {
        if (!s.node.isOutdoor || endOf(s) <= fromMinute || s.origStart >= toMinute) continue;
        affected.push(s.node.id);
        if (s.node.type === "HARD") {
          conflicts.push({
            code: "WEATHER_EXPOSED_LOCKED",
            nodeId: s.node.id,
            message: `Locked outdoor booking "${s.node.title}" overlaps the weather window ${fromMinutes(Math.min(fromMinute, 1439))}–${toMinute >= MINUTES_PER_DAY ? "24:00" : fromMinutes(toMinute)}`,
          });
        } else {
          s.minStart = toMinute;
        }
      }
      reorder = true;
      break;
    }
  }

  // ── Order and fixed prefix ──────────────────────────────────────────
  const sequence = reorder ? [...slots].sort((a, b) => a.minStart - b.minStart || a.order - b.order) : slots;
  const firstMoving = sequence.findIndex((s, i) => s.order !== i || s.minStart !== s.origStart);
  if (firstMoving === -1) return finish();

  const gap = (prev: Slot, next: Slot) => {
    const t = Math.max(0, transit(prev.node, next.node));
    if (next.order === prev.order + 1) {
      return Math.min(t, Math.max(0, next.origStart - (prev.origStart + prev.origDuration)));
    }
    return t;
  };

  /** Places `items` after `anchor`; returns minutes of overflow past `boundary`'s start (or the day end). */
  const layout = (anchor: Slot | null, items: Slot[], boundary: Slot | null): number => {
    let prev: Slot | null = anchor;
    for (const s of items) {
      const earliest = Math.max(s.minStart, prev ? endOf(prev) + gap(prev, s) : 0);
      if (s.removed) {
        // A skipped delayed stop still pins when the traveller is free, at its location.
        if (s === origin) prev = { ...s, start: earliest, duration: 0 };
        continue;
      }
      s.start = earliest;
      prev = s;
    }
    if (boundary) return (prev ? endOf(prev) + gap(prev, boundary) : 0) - boundary.start;
    return prev ? endOf(prev) - dayEnd : 0;
  };

  interface Evaluation {
    mask: number;
    feasible: boolean;
    overflow: number;
    cost: number;
  }

  const evaluate = (anchor: Slot | null, items: Slot[], boundary: Slot | null, mask: number): Evaluation => {
    items.forEach((s, i) => {
      s.removed = (mask & (1 << i)) !== 0;
      s.duration = s.origDuration;
    });
    let overflow = layout(anchor, items, boundary);
    for (let i = items.length - 1; i >= 0 && overflow > 0; i--) {
      const s = items[i];
      if (s.removed) continue;
      const maxTrim = Math.max(0, Math.min(s.node.timeSlot.bufferMinutes, s.origDuration - policy.minVisitMinutes));
      s.duration = s.origDuration - Math.min(maxTrim, overflow);
      overflow = layout(anchor, items, boundary);
    }
    let cost = 0;
    for (const s of items) {
      cost += s.removed
        ? policy.dropWeight * s.priority
        : policy.trimWeight * (s.origDuration - s.duration) + policy.shiftWeight * Math.abs(s.start - s.origStart);
    }
    return { mask, feasible: overflow <= 0, overflow, cost };
  };

  /** true if `a` is preferred over `b`. */
  const better = (a: Evaluation, b: Evaluation) => {
    if (Math.abs(a.cost - b.cost) > 1e-9) return a.cost < b.cost;
    const da = popcount(a.mask);
    const db = popcount(b.mask);
    if (da !== db) return da < db;
    const diff = a.mask ^ b.mask; // prefer dropping the later stop
    return diff !== 0 && (a.mask & (1 << (31 - Math.clz32(diff)))) !== 0;
  };

  const solveSegment = (anchor: Slot | null, items: Slot[], boundary: Slot | null) => {
    const n = items.length;
    const masks: number[] = [];
    if (n <= policy.maxEnumerateItems) {
      for (let m = 0; m < 1 << n; m++) masks.push(m);
    } else {
      const dropOrder = items
        .map((s, i) => ({ s, i }))
        .sort((a, b) => a.s.priority - b.s.priority || b.i - a.i)
        .map((x) => x.i);
      let m = 0;
      masks.push(0);
      for (const i of dropOrder) masks.push((m |= 1 << i));
    }

    let best: Evaluation | null = null;
    for (const mask of masks) {
      const e = evaluate(anchor, items, boundary, mask);
      if (e.feasible && (!best || better(e, best))) best = e;
    }
    const allDropped = n === 0 ? 0 : masks[masks.length - 1];
    const chosen = best ?? evaluate(anchor, items, boundary, allDropped);
    evaluate(anchor, items, boundary, chosen.mask); // leave slots in the chosen state

    if (!chosen.feasible && boundary) {
      conflicts.push({
        code: "HARD_ANCHOR_UNREACHABLE",
        nodeId: boundary.node.id,
        minutes: chosen.overflow,
        message: `Locked "${boundary.node.title}" will be reached ${chosen.overflow} min late even after clearing flexible stops`,
      });
    }
    for (const s of items) {
      if (!s.removed) continue;
      conflicts.push(
        boundary
          ? { code: "SOFT_NODE_DROPPED", nodeId: s.node.id, message: `"${s.node.title}" no longer fits before locked "${boundary.node.title}"` }
          : {
              code: "PAST_END_OF_DAY",
              nodeId: s.node.id,
              message: `"${s.node.title}" would run past ${dayEnd === MINUTES_PER_DAY ? "midnight" : fromMinutes(dayEnd)}`,
            },
      );
    }
  };

  let anchor: Slot | null = firstMoving > 0 ? sequence[firstMoving - 1] : null;
  let segment: Slot[] = [];
  for (let i = firstMoving; i < sequence.length; i++) {
    const s = sequence[i];
    if (s.node.type === "HARD") {
      solveSegment(anchor, segment, s);
      anchor = s;
      segment = [];
    } else {
      segment.push(s);
    }
  }
  solveSegment(anchor, segment, null);

  return finish();
}

function buildPatches(slots: readonly Slot[], dayIndex: number, reason: string, idFactory: () => string): TripPatch[] {
  const patches: TripPatch[] = [];
  for (const s of slots) {
    const base = { patchId: idFactory(), targetDayIndex: dayIndex, nodeId: s.node.id };
    if (s.removed) {
      patches.push(TripPatchSchema.parse({ ...base, operation: "REMOVE", reason: `${reason}: removed "${s.node.title}"` }));
    } else if (s.duration !== s.origDuration) {
      patches.push(
        TripPatchSchema.parse({
          ...base,
          operation: "REPLACE",
          payload: {
            ...s.node,
            timeSlot: { ...s.node.timeSlot, start: fromMinutes(s.start), durationMinutes: s.duration },
          },
          reason: `${reason}: "${s.node.title}" moved to ${fromMinutes(s.start)}, shortened by ${s.origDuration - s.duration} min`,
        }),
      );
    } else if (s.start !== s.origStart) {
      const offset = s.start - s.origStart;
      patches.push(
        TripPatchSchema.parse({
          ...base,
          operation: "SHIFT_TIME",
          shiftOffsetMinutes: offset,
          reason: `${reason}: "${s.node.title}" shifted ${offset > 0 ? "+" : ""}${offset} min to ${fromMinutes(s.start)}`,
        }),
      );
    }
  }
  return patches;
}

/**
 * Applies patches atomically: either every patch is valid and a new day is
 * returned, or a ScheduleError is thrown and nothing changes. Transit segments
 * and the daily fatigue score are recomputed for the new ordering.
 */
export function applyPatches(dayInput: DayScheduleInput, patchesInput: readonly unknown[], opts: { routed?: LegLookup } = {}): DaySchedule {
  const day = DayScheduleSchema.parse(dayInput);
  assertUniqueIds(day.nodes);
  const nodes = new Map(day.nodes.map((n) => [n.id, n]));

  for (const raw of patchesInput) {
    const patch = TripPatchSchema.parse(raw);
    if (patch.targetDayIndex !== day.dayIndex) {
      throw new ScheduleError(`Patch ${patch.patchId} targets day ${patch.targetDayIndex}, not ${day.dayIndex}`);
    }
    const existing = patch.nodeId ? nodes.get(patch.nodeId) : undefined;
    const needExisting = () => {
      if (!existing) throw new ScheduleError(`Patch ${patch.patchId}: node ${patch.nodeId ?? "(none)"} not found`);
      return existing;
    };

    switch (patch.operation) {
      case "REMOVE":
        nodes.delete(needExisting().id);
        break;
      case "SHIFT_TIME": {
        const node = needExisting();
        if (patch.shiftOffsetMinutes === undefined) throw new ScheduleError(`Patch ${patch.patchId}: missing shiftOffsetMinutes`);
        if (node.type === "HARD" && patch.shiftOffsetMinutes !== 0) {
          throw new ScheduleError(`Patch ${patch.patchId}: HARD node "${node.title}" cannot be shifted`);
        }
        const start = toMinutes(node.timeSlot.start) + patch.shiftOffsetMinutes;
        if (!isRepresentableMinute(start)) throw new ScheduleError(`Patch ${patch.patchId}: shift leaves the day`);
        nodes.set(node.id, { ...node, timeSlot: { ...node.timeSlot, start: fromMinutes(start) } });
        break;
      }
      case "REPLACE": {
        const node = needExisting();
        if (!patch.payload || patch.payload.id !== node.id) {
          throw new ScheduleError(`Patch ${patch.patchId}: REPLACE payload must carry node id ${node.id}`);
        }
        const p = patch.payload;
        if (
          node.type === "HARD" &&
          (p.type !== "HARD" || p.timeSlot.start !== node.timeSlot.start || p.timeSlot.durationMinutes !== node.timeSlot.durationMinutes)
        ) {
          throw new ScheduleError(`Patch ${patch.patchId}: HARD node "${node.title}" cannot be unlocked, moved or resized`);
        }
        nodes.set(node.id, p);
        break;
      }
      case "INSERT": {
        if (!patch.payload) throw new ScheduleError(`Patch ${patch.patchId}: INSERT needs a payload`);
        if (nodes.has(patch.payload.id)) throw new ScheduleError(`Patch ${patch.patchId}: node ${patch.payload.id} already exists`);
        nodes.set(patch.payload.id, patch.payload);
        break;
      }
    }
  }

  const ordered = sortNodes([...nodes.values()]);
  for (const n of ordered) {
    if (toMinutes(n.timeSlot.start) + n.timeSlot.durationMinutes > MINUTES_PER_DAY) {
      throw new ScheduleError(`"${n.title}" would end after midnight`);
    }
  }
  const transitSegments = rebuildTransitSegments(ordered, day.transitSegments, opts.routed);
  return DayScheduleSchema.parse({
    ...day,
    nodes: ordered,
    transitSegments,
    dailyFatigueScore: dailyFatigueScore(transitSegments),
  });
}
