/**
 * Tier 2 router for operator micro-edits. Grammar first (0 LLM calls);
 * if it doesn't parse and an LLM is configured, a fast model classifies the
 * text into { op, stop index, minutes } over the given stop list. Code builds
 * and validates the patch. Nothing is applied here — the operator previews
 * and applies through the normal Tier 1 patch route.
 */
import { z } from "zod";
import { newId } from "@/lib/musafir/ids.ts";
import { intentToPatches, parseMicroEdit, type EditIntent } from "@/lib/musafir/microedit.ts";
import { applyPatches, ScheduleError } from "@/lib/musafir/reducer.ts";
import type { TripPatch } from "@/lib/musafir/schemas.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { llmJson } from "./llm.ts";
import { routedLookup } from "./routing.ts";
import { getTripBundle } from "./trips.ts";

const LlmIntent = z.object({
  op: z.enum(["SHIFT", "REMOVE", "RESIZE", "UNKNOWN"]),
  stop: z.number().int().min(1).optional(),
  minutes: z.number().int().min(-600).max(600).optional(),
});

export interface MicroEditResult {
  patches: TripPatch[];
  summary: string;
  via: string;
  baseVersion: number;
}

export async function interpretMicroEdit(user: SessionUser, tripId: string, dayIndex: number, text: string): Promise<MicroEditResult> {
  if (user.role !== "operator") throw new HttpError(403, "Quick edits are for operators");
  const bundle = await getTripBundle(user, tripId);
  const day = bundle.trip.schedule.find((d) => d.dayIndex === dayIndex);
  if (!day) throw new HttpError(404, "Day not found");

  let intent: EditIntent;
  let via = "grammar";
  const parsed = parseMicroEdit(text, day.nodes);
  if (parsed.ok) {
    intent = parsed.intent;
  } else {
    const llm = await llmJson({
      tier: "fast",
      timeoutMs: 4000,
      schema: LlmIntent,
      system:
        'Classify an operator\'s itinerary edit. Stops are numbered from 1. Reply JSON {"op":"SHIFT"|"REMOVE"|"RESIZE"|"UNKNOWN","stop":<number>,"minutes":<signed integer>}. SHIFT minutes: positive = later. RESIZE minutes: positive = longer. Use UNKNOWN if unsure.',
      user: JSON.stringify({ text: text.slice(0, 200), stops: day.nodes.map((n, i) => ({ stop: i + 1, title: n.title, start: n.timeSlot.start })) }),
    });
    if (!llm.ok) throw new HttpError(422, `${parsed.reason}${llm.reason.startsWith("no LLM key") ? "" : ` (AI fallback failed: ${llm.reason})`}`);
    const v = llm.value;
    const node = v.stop ? day.nodes[v.stop - 1] : undefined;
    if (v.op === "UNKNOWN" || !node || (v.op !== "REMOVE" && !v.minutes)) throw new HttpError(422, parsed.reason);
    intent = v.op === "REMOVE" ? { op: "REMOVE", nodeId: node.id } : { op: v.op, nodeId: node.id, minutes: v.minutes! };
    via = `llm:${llm.via}`;
  }

  const patches = intentToPatches(intent, day.nodes, dayIndex, newId);
  if (typeof patches === "string") throw new HttpError(422, patches);
  try {
    applyPatches(day, patches, { routed: routedLookup }); // validate before showing
  } catch (e) {
    throw new HttpError(422, e instanceof ScheduleError ? e.message : "That edit doesn't fit the day");
  }
  return { patches, summary: patches.map((p) => p.reason).join("; "), via, baseVersion: bundle.trip.version };
}
