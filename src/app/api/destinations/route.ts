import { HttpError, requireUser } from "@/server/auth.ts";
import { resolveDestination } from "@/server/destinations.ts";
import { handle } from "@/server/http.ts";

/** GET /api/destinations?q=Japan — what the text means (place / region / country) and, for areas, the cities worth visiting. */
export const GET = handle(async (req) => {
  await requireUser();
  const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) throw new HttpError(400, "Type at least 2 characters");
  const d = await resolveDestination(q);
  return { destination: d };
});
