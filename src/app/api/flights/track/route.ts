import { HttpError, requireUser } from "@/server/auth.ts";
import { trackFlight } from "@/server/flights.ts";
import { handle } from "@/server/http.ts";

export const GET = handle(async (req) => {
  await requireUser();
  const callsign = new URL(req.url).searchParams.get("callsign")?.trim() ?? "";
  if (!/^[A-Za-z0-9 ]{3,10}$/.test(callsign)) throw new HttpError(400, "Enter a callsign like AIC101 (airline code + number)");
  try {
    const status = await trackFlight(callsign);
    return { status, note: status ? null : "Not airborne or not broadcasting right now. Flights appear from takeoff until shortly after landing." };
  } catch (e) {
    throw new HttpError(502, (e as Error).message);
  }
});
