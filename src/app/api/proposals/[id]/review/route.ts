import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, handle, type IdCtx } from "@/server/http.ts";
import { reviewAdvisory } from "@/server/trips.ts";

const Input = z.object({ action: z.enum(["SEND", "DISMISS"]), note: z.string().max(240).optional() });

/** POST /api/proposals/:id/review — operator sends a weather advisory to the traveller, or keeps it internal. */
export const POST = handle<IdCtx>(async (req, { params }) => {
  const { action, note } = await body(req, Input);
  return reviewAdvisory(await requireUser("operator"), (await params).id, action, note);
});
