/**
 * "Something changed?" — the traveller says it in their own words. Grammar
 * first (lib/musafir/report.ts), the LLM only for wording the grammar can't
 * read. Two families:
 *  - what went wrong (late / closed / rain) → the self-healing engine's card
 *  - a specific edit → touches ONLY the named stop:
 *      REMOVE  that stop (nothing else moves)
 *      MOVE    that stop to a time / by minutes
 *      REPLACE that stop with real nearby places (a card with up to 3 options)
 * Edits never guess a target: an unclear or ambiguous one gets a question back.
 */
import { z } from "zod";
import { newId } from "@/lib/musafir/ids.ts";
import { keywordFit } from "@/lib/musafir/interests.ts";
import { englishTitle } from "@/lib/musafir/names.ts";
import { parseReport, REPORTED_RAIN_MINUTES, type ParsedReport, type ReportStop } from "@/lib/musafir/report.ts";
import { rankReplacements } from "@/lib/musafir/resolver.ts";
import type { DaySchedule, ItineraryNode, NodeCategory } from "@/lib/musafir/schemas.ts";
import { fromMinutes, MINUTES_PER_DAY, toMinutes } from "@/lib/musafir/time.ts";
import { replacementPatches } from "./agents.ts";
import { HttpError, type SessionUser } from "./auth.ts";
import { llmJson } from "./llm.ts";
import { nearbyCandidates, type CandidatePurpose } from "./osm.ts";
import { applyDirectPatches, createDisruptionProposal, createSwapProposal, getTripBundle } from "./trips.ts";

const SWAP_RADIUS_M = 1500;
const SWAP_OPTIONS = 3;

const LlmReport = z.object({
  kind: z.enum(["DELAY", "CLOSURE", "WEATHER", "REMOVE", "REPLACE", "MOVE", "UNKNOWN"]),
  stop: z.number().int().min(1).nullable().optional(),
  minutes: z.number().int().min(-600).max(600).nullable().optional(),
  toTime: z.string().regex(/^\d{1,2}:\d{2}$/).nullable().optional(),
  untilHour: z.number().int().min(0).max(24).nullable().optional(),
  want: z.string().max(60).nullable().optional(),
});

async function askLlm(text: string, stops: ReportStop[], nowMinute: number): Promise<{ parsed: ParsedReport | null; via: string }> {
  const r = await llmJson({
    tier: "fast",
    timeoutMs: 8000,
    schema: LlmReport,
    system: [
      "A traveller writes about today's plan. Classify it. Stops are numbered from 1.",
      "DELAY: they are late (minutes, stop). CLOSURE: a stop is closed (stop). WEATHER: rain/storm/flood/heat now (untilHour if said).",
      "REMOVE: they don't want one stop (stop). REPLACE: they want a different place instead of one stop (stop; want = what they'd like instead, e.g. 'park', 'something indoor', or null).",
      "MOVE: shift one stop (stop; toTime 'HH:MM' 24h, or minutes: positive later / negative earlier).",
      "Only set stop if the text clearly names it. Otherwise UNKNOWN.",
      'Reply JSON {"kind","stop","minutes","toTime","untilHour","want"}.',
    ].join(" "),
    user: JSON.stringify({ text, nowMinute, stops: stops.map((s) => ({ n: s.index, title: s.title, start: fromMinutes(s.startMinute), type: s.kind })) }),
  });
  if (!r.ok) return { parsed: null, via: "" };
  const v = r.value;
  const stop = typeof v.stop === "number" && v.stop >= 1 && v.stop <= stops.length ? v.stop : null;
  const via = r.via;
  switch (v.kind) {
    case "DELAY":
      return { parsed: stop && v.minutes && v.minutes > 0 ? { kind: "DELAY", stop, minutes: v.minutes } : null, via };
    case "CLOSURE":
      return { parsed: stop ? { kind: "CLOSURE", stop } : null, via };
    case "REMOVE":
      return { parsed: stop ? { kind: "REMOVE", stop } : null, via };
    case "REPLACE":
      return { parsed: stop ? { kind: "REPLACE", stop, ...(v.want ? { want: v.want } : {}) } : null, via };
    case "MOVE":
      if (!stop) return { parsed: null, via };
      if (v.toTime) return { parsed: { kind: "MOVE", stop, toMinute: toMinutes(v.toTime.padStart(5, "0")) }, via };
      return { parsed: v.minutes ? { kind: "MOVE", stop, byMinutes: v.minutes } : null, via };
    case "WEATHER": {
      const to = typeof v.untilHour === "number" && v.untilHour * 60 > nowMinute ? v.untilHour * 60 : nowMinute + REPORTED_RAIN_MINUTES;
      return { parsed: { kind: "WEATHER", fromMinute: nowMinute, toMinute: Math.min(MINUTES_PER_DAY, to) }, via };
    }
    default:
      return { parsed: null, via };
  }
}

/** What kind of place "want" asks for (else: the same kind as the stop being replaced). */
function purposeFor(want: string | undefined, node: ItineraryNode): { purpose: CandidatePurpose; category: NodeCategory } {
  const w = (want ?? "").toLowerCase();
  if (/indoor|inside|museum|gallery|mall|cinema/.test(w)) return { purpose: "INDOOR", category: /museum|gallery/.test(w) ? "CULTURE" : "LEISURE" };
  if (/park|garden|nature|outdoor|lake|view/.test(w)) return { purpose: "NATURE", category: "NATURE" };
  if (/cafe|coffee|restaurant|food|eat|lunch|dinner|veg/.test(w)) return { purpose: "DINING", category: "DINING" };
  if (/temple|fort|palace|monument|heritage|history|culture/.test(w)) return { purpose: "CULTURE", category: "CULTURE" };
  const c = node.category === "TRANSIT" || node.category === "ACCOMMODATION" ? "CULTURE" : node.category;
  return { purpose: c, category: c };
}

async function swapOptions(day: DaySchedule, node: ItineraryNode, want: string | undefined, dietary: readonly string[]) {
  const { purpose, category } = purposeFor(want, node);
  const inDay = new Set(day.nodes.map((n) => n.title.toLowerCase()));
  const all = await nearbyCandidates(node.location, purpose, SWAP_RADIUS_M).catch(() => []);
  // Like for like: a sight is swapped for a sight (not a café) unless they asked for food; never a street.
  const wantsFood = category === "DINING";
  const fresh = all.filter(
    (c) =>
      !inDay.has((c.nameEn ?? c.name).toLowerCase()) &&
      c.distanceMeters > 25 &&
      (wantsFood ? c.category === "DINING" : c.category !== "DINING") &&
      !/^(highway|place|boundary|landuse)=/.test(c.kind) &&
      !/\b(road|marg|street|lane|avenue|highway)\b/i.test(c.nameEn ?? c.name),
  );
  // "a vegetarian restaurant" → that diet is checked against OSM diet:* tags for this swap too.
  const askedDiet = ["vegetarian", "vegan", "halal", "kosher", "gluten_free"].filter((d) => new RegExp(d.replace("_", "[ -]?"), "i").test(want ?? ""));
  const { ranked } = rankReplacements(fresh, node, { date: day.date, wantCategory: category, dietary: [...new Set([...dietary, ...askedDiet])] });
  // Words the traveller used ("vegetarian", "rooftop") lift matching places to the top.
  const words = (want ?? "").split(/\s+/).filter((x) => x.length >= 4 && !/indoor|outdoor|something|place/.test(x));
  const ordered = [...ranked].sort((a, b) => keywordFit(b.candidate, words) - keywordFit(a.candidate, words) || b.score - a.score);
  return ordered.slice(0, SWAP_OPTIONS).map((r) => {
    const t = englishTitle(r.candidate);
    return {
      label: `${t.title} · ${r.candidate.distanceMeters} m away${r.hours === "unknown" ? " · hours unknown" : ""}`,
      patches: replacementPatches(day, node, r.candidate, "You asked to swap"),
      rankedBy: "open at that time, what you asked for, distance",
      rationale: `${r.hours === "open" ? "Open then per OpenStreetMap" : "Opening hours not listed"}; ${r.candidate.distanceMeters} m from "${node.title}".`,
    };
  });
}

export async function reportInWords(user: SessionUser, tripId: string, dayIndex: number, text: string, nowMinute: number) {
  const bundle = await getTripBundle(user, tripId);
  const day = bundle.trip.schedule.find((d) => d.dayIndex === dayIndex);
  if (!day || day.nodes.length === 0) throw new HttpError(422, "This day has no stops yet");
  const stops: ReportStop[] = day.nodes.map((n, i) => {
    const start = toMinutes(n.timeSlot.start);
    return { index: i + 1, title: n.title, startMinute: start, endMinute: start + n.timeSlot.durationMinutes, isOutdoor: n.isOutdoor, category: n.category, kind: String(n.metadata?.kind ?? "") };
  });
  const first = parseReport(text, stops, nowMinute);
  if (first && first.kind === "AMBIGUOUS") {
    const names = first.candidates.map((n) => `“${stops[n - 1].title}”`).join(" or ");
    throw new HttpError(422, `Which one — ${names}? Say it with the name.`);
  }
  let parsed: ParsedReport | null = first;
  let via = "understood";
  if (!parsed) {
    const ai = await askLlm(text, stops, nowMinute);
    parsed = ai.parsed;
    if (ai.via) via = `read by ${ai.via}`;
  }
  if (!parsed) {
    throw new HttpError(422, 'Sorry, I couldn\'t tell what to change. Try "skip the museum", "change the cafe", "move the fort to 4pm" or "20 min late".');
  }
  const node = (n: number) => day.nodes[n - 1];
  const reason = `Traveller: "${text.trim().slice(0, 120)}"`;
  const patchId = newId;

  switch (parsed.kind) {
    case "REMOVE": {
      const n = node(parsed.stop);
      const version = await applyDirectPatches(user, tripId, dayIndex, {
        baseVersion: bundle.trip.version,
        patches: [{ patchId: patchId(), targetDayIndex: dayIndex, operation: "REMOVE", nodeId: n.id, reason }],
      });
      return { understood: `Removed ${n.title}`, via, status: "APPLIED", version };
    }
    case "MOVE": {
      const n = node(parsed.stop);
      const start = toMinutes(n.timeSlot.start);
      const offset = parsed.toMinute !== undefined ? parsed.toMinute - start : (parsed.byMinutes ?? 0);
      if (offset === 0) throw new HttpError(422, `${n.title} already starts at ${n.timeSlot.start}`);
      // Only this stop moves — so it must land in a free slot, not on top of another stop.
      const dur = n.timeSlot.durationMinutes;
      const others = day.nodes.filter((x) => x.id !== n.id).map((x) => ({ title: x.title, s: toMinutes(x.timeSlot.start), e: toMinutes(x.timeSlot.start) + x.timeSlot.durationMinutes }));
      const clash = (at: number) => others.find((o) => at < o.e && at + dur > o.s);
      const wanted = start + offset;
      if (wanted < 0 || wanted + dur > MINUTES_PER_DAY) throw new HttpError(422, `That would put ${n.title} outside the day`);
      const hit = clash(wanted);
      if (hit) {
        const gaps = [0, ...others.map((o) => o.e)].filter((t) => !clash(t) && t + dur <= MINUTES_PER_DAY).sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
        throw new HttpError(
          422,
          `${fromMinutes(wanted)} clashes with ${hit.title} (${fromMinutes(hit.s)}–${fromMinutes(hit.e)}).${gaps.length ? ` Nearest free slot for ${n.title}: ${fromMinutes(gaps[0])} — say “move ${n.title} to ${fromMinutes(gaps[0])}”.` : ""}`,
        );
      }
      const version = await applyDirectPatches(user, tripId, dayIndex, {
        baseVersion: bundle.trip.version,
        patches: [{ patchId: patchId(), targetDayIndex: dayIndex, operation: "SHIFT_TIME", nodeId: n.id, shiftOffsetMinutes: offset, reason }],
      });
      return { understood: `Moved ${n.title} to ${fromMinutes(start + offset)}`, via, status: "APPLIED", version };
    }
    case "REPLACE": {
      const n = node(parsed.stop);
      const choices = await swapOptions(day, n, parsed.want, bundle.trip.dietaryRestrictions);
      if (choices.length === 0) throw new HttpError(422, `No open alternative${parsed.want ? ` (${parsed.want})` : ""} found near ${n.title} for that time`);
      const proposal = await createSwapProposal(user, tripId, dayIndex, n.id, choices, parsed.want);
      return { understood: `Options instead of ${n.title}`, via, status: proposal.status, proposalId: proposal.id };
    }
    default: {
      const disruption =
        parsed.kind === "DELAY"
          ? { kind: "DELAY" as const, nodeId: node(parsed.stop).id, delayMinutes: parsed.minutes, reason }
          : parsed.kind === "CLOSURE"
            ? { kind: "CLOSURE" as const, nodeId: node(parsed.stop).id, reason }
            : { kind: "WEATHER" as const, fromMinute: parsed.fromMinute, toMinute: Math.max(parsed.fromMinute + 15, parsed.toMinute), reason };
      const proposal = await createDisruptionProposal(user, tripId, dayIndex, disruption);
      const understood =
        parsed.kind === "DELAY" ? `${parsed.minutes} min late for ${node(parsed.stop).title}` : parsed.kind === "CLOSURE" ? `${node(parsed.stop).title} is closed` : "Rain where you are";
      return { understood, via, status: proposal.status, proposalId: proposal.id, runAgent: parsed.kind !== "DELAY" };
    }
  }
}
