/**
 * "Something changed?" — the traveller says it in their own words; Musafir
 * turns it into a disruption and hands back the healed plan. Grammar first
 * (lib/musafir/report.ts), the LLM only for wording the grammar can't read.
 * The engine, risk tiers and operator rules apply exactly as for any report.
 */
import { z } from "zod";
import { parseReport, REPORTED_RAIN_MINUTES, type ParsedReport, type ReportStop } from "@/lib/musafir/report.ts";
import { MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { llmJson } from "./llm.ts";
import { createDisruptionProposal, getTripBundle } from "./trips.ts";

const LlmReport = z.object({
  kind: z.enum(["DELAY", "CLOSURE", "WEATHER", "UNKNOWN"]),
  stop: z.number().int().min(1).nullable().optional(),
  minutes: z.number().int().min(1).max(600).nullable().optional(),
  untilHour: z.number().int().min(0).max(24).nullable().optional(),
});

async function askLlm(text: string, stops: ReportStop[], nowMinute: number): Promise<{ parsed: ParsedReport | null; via: string }> {
  const r = await llmJson({
    tier: "fast",
    timeoutMs: 7000,
    schema: LlmReport,
    system:
      'A traveller describes a problem with today\'s plan. Classify it. DELAY needs minutes and the stop number; CLOSURE needs the stop number; WEATHER is rain/storm/flood/extreme heat where they are (untilHour if they say when it stops). Use UNKNOWN if it is none of these. Stops are numbered from 1. Reply JSON {"kind","stop","minutes","untilHour"}.',
    user: JSON.stringify({ text, nowMinute, stops: stops.map((s) => ({ n: s.index, title: s.title, start: s.startMinute, outdoor: s.isOutdoor })) }),
  });
  if (!r.ok) return { parsed: null, via: "" };
  const v = r.value;
  const valid = (n?: number | null) => typeof n === "number" && n >= 1 && n <= stops.length;
  if (v.kind === "DELAY" && valid(v.stop) && v.minutes) return { parsed: { kind: "DELAY", stop: v.stop!, minutes: v.minutes }, via: r.via };
  if (v.kind === "CLOSURE" && valid(v.stop)) return { parsed: { kind: "CLOSURE", stop: v.stop! }, via: r.via };
  if (v.kind === "WEATHER") {
    const to = typeof v.untilHour === "number" && v.untilHour * 60 > nowMinute ? v.untilHour * 60 : nowMinute + REPORTED_RAIN_MINUTES;
    return { parsed: { kind: "WEATHER", fromMinute: nowMinute, toMinute: Math.min(MINUTES_PER_DAY, to) }, via: r.via };
  }
  return { parsed: null, via: r.via };
}

export async function reportInWords(user: SessionUser, tripId: string, dayIndex: number, text: string, nowMinute: number) {
  const { trip } = await getTripBundle(user, tripId);
  const day = trip.schedule.find((d) => d.dayIndex === dayIndex);
  if (!day || day.nodes.length === 0) throw new HttpError(422, "This day has no stops yet");
  const stops: ReportStop[] = day.nodes.map((n, i) => {
    const start = toMinutes(n.timeSlot.start);
    return { index: i + 1, title: n.title, startMinute: start, endMinute: start + n.timeSlot.durationMinutes, isOutdoor: n.isOutdoor };
  });
  let parsed = parseReport(text, stops, nowMinute);
  let via = "understood";
  if (!parsed) {
    const ai = await askLlm(text, stops, nowMinute);
    parsed = ai.parsed;
    via = ai.via ? `read by ${ai.via}` : via;
  }
  if (!parsed) {
    throw new HttpError(422, 'Sorry, I couldn\'t tell what changed. Try "20 min late", "the fort is closed" or "it\'s pouring".');
  }
  const node = (n: number) => day.nodes[n - 1];
  const reason = `Reported by the traveller: "${text.trim().slice(0, 120)}"`;
  const disruption =
    parsed.kind === "DELAY"
      ? { kind: "DELAY" as const, nodeId: node(parsed.stop).id, delayMinutes: parsed.minutes, reason }
      : parsed.kind === "CLOSURE"
        ? { kind: "CLOSURE" as const, nodeId: node(parsed.stop).id, reason }
        : { kind: "WEATHER" as const, fromMinute: parsed.fromMinute, toMinute: Math.max(parsed.fromMinute + 15, parsed.toMinute), reason };
  const proposal = await createDisruptionProposal(user, tripId, dayIndex, disruption);
  const understood =
    parsed.kind === "DELAY"
      ? `${parsed.minutes} min late for ${node(parsed.stop).title}`
      : parsed.kind === "CLOSURE"
        ? `${node(parsed.stop).title} is closed`
        : "Rain where you are";
  return { proposal, understood, via };
}
