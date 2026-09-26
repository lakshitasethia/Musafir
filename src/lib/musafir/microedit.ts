/**
 * Tier 2 micro-edits for operators ("push dinner 30 min"). A deterministic
 * grammar handles the common phrasings; anything else may be classified by an
 * LLM into the same small `EditIntent` (an index from a given list + minutes).
 * Either way, *code* builds the patch — the LLM never emits patches.
 */
import type { ItineraryNode, TripPatch } from "./schemas.ts";
import { toMinutes } from "./time.ts";

export type EditIntent =
  | { op: "SHIFT"; nodeId: string; minutes: number }
  | { op: "REMOVE"; nodeId: string }
  | { op: "RESIZE"; nodeId: string; minutes: number };

export type ParseResult = { ok: true; intent: EditIntent } | { ok: false; reason: string };

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** "stop 3" / "#3" / a unique (partial) name. */
export function matchStop(ref: string, nodes: readonly ItineraryNode[]): ItineraryNode | string {
  const r = norm(ref).replace(/^the /, "");
  const byIndex = /^(?:stop )?#?(\d{1,2})$/.exec(r);
  if (byIndex) {
    const n = nodes[Number(byIndex[1]) - 1];
    return n ?? `There is no stop ${byIndex[1]} today`;
  }
  if (!r) return "Which stop?";
  const exact = nodes.filter((n) => norm(n.title) === r);
  if (exact.length === 1) return exact[0];
  const partial = nodes.filter((n) => norm(n.title).includes(r) || (n.nativeTitle && norm(n.nativeTitle).includes(r)));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) return `"${ref}" matches ${partial.map((n) => n.title).join(", ")} — be more specific or use "stop N"`;
  // Category words ("lunch", "dinner", "museum") → the unique stop of that kind.
  const cat = r.match(/^(lunch|dinner|breakfast|meal|food)$/) ? "DINING" : null;
  if (cat) {
    const meals = nodes.filter((n) => n.category === cat);
    const byTime = r === "lunch" ? meals.filter((n) => toMinutes(n.timeSlot.start) < 16 * 60) : r === "dinner" ? meals.filter((n) => toMinutes(n.timeSlot.start) >= 16 * 60) : meals;
    if (byTime.length === 1) return byTime[0];
    if (byTime.length > 1) return `More than one ${r} today — use "stop N"`;
  }
  return `No stop called "${ref}" today`;
}

const DURATION = String.raw`(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)?`;
const toMin = (n: string, unit: string | undefined) => Number(n) * (unit && /^h/.test(unit) ? 60 : 1);

export function parseMicroEdit(text: string, nodes: readonly ItineraryNode[]): ParseResult {
  const t = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!t) return { ok: false, reason: "Type an edit, e.g. “push dinner 30 min”" };
  const resolve = (ref: string) => matchStop(ref, nodes);

  let m = new RegExp(`^(?:push|move|delay|shift) (.+?) (?:by )?\\+?${DURATION}(?: (later|earlier|back|forward))?$`).exec(t);
  if (m) {
    const node = resolve(m[1]);
    if (typeof node === "string") return { ok: false, reason: node };
    const sign = m[4] === "earlier" || m[4] === "forward" ? -1 : 1;
    return { ok: true, intent: { op: "SHIFT", nodeId: node.id, minutes: sign * toMin(m[2], m[3]) } };
  }
  m = new RegExp(`^(?:bring forward|pull|pull forward|advance) (.+?) (?:by )?${DURATION}$`).exec(t);
  if (m) {
    const node = resolve(m[1]);
    if (typeof node === "string") return { ok: false, reason: node };
    return { ok: true, intent: { op: "SHIFT", nodeId: node.id, minutes: -toMin(m[2], m[3]) } };
  }
  m = /^(?:remove|drop|skip|cancel|delete) (.+)$/.exec(t);
  if (m) {
    const node = resolve(m[1]);
    if (typeof node === "string") return { ok: false, reason: node };
    return { ok: true, intent: { op: "REMOVE", nodeId: node.id } };
  }
  m = new RegExp(`^(extend|lengthen|shorten|trim) (.+?) by ${DURATION}$`).exec(t);
  if (m) {
    const node = resolve(m[2]);
    if (typeof node === "string") return { ok: false, reason: node };
    const sign = m[1] === "shorten" || m[1] === "trim" ? -1 : 1;
    return { ok: true, intent: { op: "RESIZE", nodeId: node.id, minutes: sign * toMin(m[3], m[4]) } };
  }
  return { ok: false, reason: "Not understood. Try “push <stop> 30 min”, “skip <stop>”, or “extend <stop> by 15 min”." };
}

/** Builds the patch for an intent; errors are user-facing strings. */
export function intentToPatches(intent: EditIntent, nodes: readonly ItineraryNode[], dayIndex: number, newId: () => string): TripPatch[] | string {
  const node = nodes.find((n) => n.id === intent.nodeId);
  if (!node) return "That stop no longer exists";
  if (node.type === "HARD" && intent.op !== "REMOVE") return `"${node.title}" is a locked booking — rebook it from its editor instead`;
  const base = { patchId: newId(), targetDayIndex: dayIndex, nodeId: node.id };
  switch (intent.op) {
    case "REMOVE":
      return [{ ...base, operation: "REMOVE", reason: `Quick edit: remove "${node.title}"` }];
    case "SHIFT":
      if (intent.minutes === 0) return "Shift by 0 minutes does nothing";
      return [{ ...base, operation: "SHIFT_TIME", shiftOffsetMinutes: intent.minutes, reason: `Quick edit: move "${node.title}" ${intent.minutes > 0 ? "+" : ""}${intent.minutes} min` }];
    case "RESIZE": {
      const duration = node.timeSlot.durationMinutes + intent.minutes;
      if (duration < 5) return "That would make the visit shorter than 5 minutes";
      return [
        {
          ...base,
          operation: "REPLACE",
          payload: { ...node, timeSlot: { ...node.timeSlot, durationMinutes: duration } },
          reason: `Quick edit: ${intent.minutes > 0 ? "extend" : "shorten"} "${node.title}" to ${duration} min`,
        },
      ];
    }
  }
}
