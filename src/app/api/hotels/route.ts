import { z } from "zod";
import { HttpError, requireUser } from "@/server/auth.ts";
import { hotelsForTrip } from "@/server/essentials.ts";
import { handle } from "@/server/http.ts";

export const GET = handle(async (req) => {
  const user = await requireUser();
  const tripId = z.uuid().safeParse(new URL(req.url).searchParams.get("tripId"));
  if (!tripId.success) throw new HttpError(400, "Pick a trip first");
  try {
    return await hotelsForTrip(user, tripId.data);
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `Hotel search is unavailable right now (${(e as Error).message})`);
  }
});
