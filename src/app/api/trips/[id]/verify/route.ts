import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { setVerified } from "@/server/graph.ts";
import { body, handle, type IdCtx } from "@/server/http.ts";

const Input = z.object({ verified: z.boolean(), note: z.string().max(200).optional() });

/** POST /api/trips/:id/verify — operator marks a trip as checked end to end (or clears it). */
export const POST = handle<IdCtx>(async (req, { params }) => {
  const { verified, note } = await body(req, Input);
  return setVerified(await requireUser("operator"), (await params).id, verified, note);
});
