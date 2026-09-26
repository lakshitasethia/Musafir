import { requireUser } from "@/server/auth.ts";
import { sseResponse } from "@/server/events.ts";
import { handle, type IdCtx } from "@/server/http.ts";
import { getTripBundle } from "@/server/trips.ts";

export const GET = handle<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  await getTripBundle(await requireUser(), id); // authorizes access
  return sseResponse(req, `trip:${id}`);
});
