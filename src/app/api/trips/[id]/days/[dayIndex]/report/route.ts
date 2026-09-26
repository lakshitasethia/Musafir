import { after } from "next/server";
import { z } from "zod";
import { runAlternativeAgent } from "@/server/agents.ts";
import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { reportInWords } from "@/server/report.ts";

const Input = z.object({ text: z.string().trim().min(3).max(300), nowMinute: z.number().int().min(0).max(1439) });

/** POST — the traveller says what changed in plain words; returns the healed plan as a card. */
export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  const { text, nowMinute } = await body(req, Input);
  const out = await reportInWords(await requireUser(), id, dayIndexOf(dayIndex), text, nowMinute);
  if (out.proposal.disruption.kind !== "DELAY") after(() => runAlternativeAgent(out.proposal.id));
  return { understood: out.understood, via: out.via, proposalId: out.proposal.id, status: out.proposal.status };
});
