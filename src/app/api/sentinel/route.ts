import { timingSafeEqual } from "node:crypto";
import { after } from "next/server";
import { z } from "zod";
import { runAlternativeAgent } from "@/server/agents.ts";
import { HttpError, requireUser } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";
import { runSentinelForTrip, runSentinelSweep } from "@/server/sentinel.ts";
import { getTripBundle } from "@/server/trips.ts";

function hasSecret(req: Request): boolean {
  const secret = process.env.SENTINEL_SECRET;
  const header = req.headers.get("authorization") ?? "";
  if (!secret || !header.startsWith("Bearer ")) return false;
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

const OneTrip = z.object({ tripId: z.uuid() });

/**
 * POST with `Authorization: Bearer $SENTINEL_SECRET` → sweep all active trips (scheduled job).
 * POST with a session and { tripId } → check that trip (the open trip page polls this).
 */
export const POST = handle(async (req) => {
  const results = hasSecret(req)
    ? await runSentinelSweep()
    : await (async () => {
        const user = await requireUser();
        const { tripId } = await body(req, OneTrip);
        await getTripBundle(user, tripId); // authorizes access
        return [await runSentinelForTrip(tripId)];
      })();
  const created = results.flatMap((r) => r.proposalIds);
  for (const id of created) after(() => runAlternativeAgent(id));
  if (results.length === 0 && !hasSecret(req)) throw new HttpError(404, "Trip not found");
  return { results };
});
