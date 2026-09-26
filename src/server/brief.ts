/**
 * Reads a traveller's free-text brief into faders + interest chips + must-sees.
 * LLM first (JSON, zod-validated, fixed vocabulary), keyword grammar fallback.
 * The result is shown back to the traveller as editable controls — never
 * applied silently — and must-sees are only kept if the traveller typed them.
 */
import { z } from "zod";
import { INTERESTS, PARTIES, readBrief, type BriefReading, type Party } from "@/lib/musafir/interests.ts";
import { llmJson } from "./llm.ts";

const unit = z.number().min(0).max(1);
const BriefSchema = z.object({
  pacing: unit.nullable().optional(),
  budget: unit.nullable().optional(),
  culturalDepth: unit.nullable().optional(),
  circadian: unit.nullable().optional(),
  interests: z.array(z.enum(INTERESTS)).max(8).default([]),
  avoid: z.array(z.enum(INTERESTS)).max(6).default([]),
  mustSee: z.array(z.string().trim().min(2).max(80)).max(6).default([]),
  party: z.enum(PARTIES).nullable().optional(),
  partySize: z.number().int().min(1).max(30).nullable().optional(),
});

export interface BriefResult extends BriefReading {
  mustSee: string[];
  partySize?: number;
  /** "llm:<provider/model>" or "keywords". */
  via: string;
}

export async function interpretBrief(text: string): Promise<BriefResult> {
  const brief = text.trim().slice(0, 600);
  const fallback = readBrief(brief);
  if (!brief) return { ...fallback, mustSee: [], via: "keywords" };
  const r = await llmJson({
    tier: "fast",
    timeoutMs: 7000,
    schema: BriefSchema,
    system: [
      "You turn a traveller's description of the trip they want into settings. Reply as JSON.",
      "Faders are 0..1 and optional (omit or null when the text doesn't say): pacing (0 slow, 1 packed),",
      "budget (0 shoestring, 1 luxury), culturalDepth (0 iconic landmarks, 1 local/offbeat), circadian (0 early riser, 1 night owl).",
      `interests and avoid: only values from ${JSON.stringify(INTERESTS)}.`,
      "mustSee: only specific places the text names verbatim (e.g. \"Taj Mahal\"); never suggest your own.",
      `party: one of ${JSON.stringify(PARTIES)} if stated; partySize if a number of people is stated.`,
    ].join(" "),
    user: brief,
  });
  if (!r.ok) return { ...fallback, mustSee: [], via: "keywords" };
  const v = r.value;
  const lower = brief.toLowerCase();
  const vibe: BriefReading["vibe"] = {};
  for (const k of ["pacing", "budget", "culturalDepth", "circadian"] as const) {
    const x = v[k];
    if (typeof x === "number") vibe[k] = Math.round(x * 100) / 100;
    // Where the keyword grammar is sure ("early risers") and the model points the other way, trust the words.
    const kw = fallback.vibe[k];
    if (kw !== undefined && (vibe[k] === undefined || Math.abs(vibe[k]! - kw) > 0.5)) vibe[k] = kw;
  }
  return {
    vibe,
    interests: [...new Set(v.interests)],
    avoid: [...new Set(v.avoid)].filter((a) => !v.interests.includes(a)),
    // Guard against invented places: keep only names the traveller actually wrote.
    mustSee: [...new Set(v.mustSee)].filter((m) => lower.includes(m.toLowerCase())),
    party: (v.party ?? fallback.party) as Party | undefined,
    partySize: v.partySize ?? undefined,
    via: r.via,
  };
}
