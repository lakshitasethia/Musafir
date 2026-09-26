import { after } from "next/server";
import { z } from "zod";
import { runClusterAgent } from "@/server/agents.ts";
import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { startClusterProposal } from "@/server/trips.ts";

const Input = z.object({ nodeId: z.uuid() });

export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  const { nodeId } = await body(req, Input);
  const proposalId = await startClusterProposal(await requireUser(), id, dayIndexOf(dayIndex), nodeId);
  after(() => runClusterAgent(proposalId));
  return { proposalId };
});
