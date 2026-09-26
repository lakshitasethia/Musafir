import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, handle, type IdCtx } from "@/server/http.ts";
import { decideProposal } from "@/server/trips.ts";

const Decision = z.object({ decision: z.enum(["APPLY", "DISMISS"]), optionId: z.string().optional() });

export const POST = handle<IdCtx>(async (req, { params }) => {
  const { decision, optionId } = await body(req, Decision);
  return decideProposal(await requireUser(), (await params).id, decision, optionId);
});
