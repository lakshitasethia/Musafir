import { HttpError, requireUser } from "@/server/auth.ts";
import { handle } from "@/server/http.ts";
import { socialSignals } from "@/server/social.ts";

/** GET /api/twin/social?city=Mumbai — public posts and news about weather there, read into hazards. */
export const GET = handle(async (req) => {
  await requireUser();
  const city = new URL(req.url).searchParams.get("city")?.trim() ?? "";
  if (city.length < 2 || city.length > 80) throw new HttpError(400, "Give a city name");
  return socialSignals(city);
});
