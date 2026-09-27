import { after } from "next/server";
import { z } from "zod";
import { runAlternativeAgent } from "@/server/agents.ts";
import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { reportInWords } from "@/server/report.ts";

const Input = z.object({ text: z.string().trim().min(3).max(300), nowMinute: z.number().int().min(0).max(1439) });

/** POST — the traveller says what changed (or what to change) in plain words. */
export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  const { text, nowMinute } = await body(req, Input);
  const out = await reportInWords(await requireUser(), id, dayIndexOf(dayIndex), text, nowMinute);
  if ("runAgent" in out && out.runAgent && out.proposalId) {
    const pid = out.proposalId;
    after(() => runAlternativeAgent(pid));
  }
  return { understood: out.understood, via: out.via, status: out.status, proposalId: "proposalId" in out ? out.proposalId : undefined };
});
