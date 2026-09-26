import { after } from "next/server";
import { runAlternativeAgent } from "@/server/agents.ts";
import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { DisruptionSchema, createDisruptionProposal } from "@/server/trips.ts";

export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  const proposal = await createDisruptionProposal(await requireUser(), id, dayIndexOf(dayIndex), await body(req, DisruptionSchema));
  if (proposal.disruption.kind !== "DELAY") after(() => runAlternativeAgent(proposal.id));
  return { proposalId: proposal.id, status: proposal.status };
});
