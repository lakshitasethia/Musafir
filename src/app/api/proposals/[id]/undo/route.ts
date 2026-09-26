import { requireUser } from "@/server/auth.ts";
import { handle, type IdCtx } from "@/server/http.ts";
import { undoProposal } from "@/server/trips.ts";

export const POST = handle<IdCtx>(async (_req, { params }) => {
  await undoProposal(await requireUser(), (await params).id);
});
