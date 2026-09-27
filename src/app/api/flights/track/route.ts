import { HttpError, requireUser } from "@/server/auth.ts";
import { trackFlight } from "@/server/flights.ts";
import { handle } from "@/server/http.ts";

/** GET /api/flights/track?callsign=6E%20964 — ticket flight number or radio callsign → live position. */
export const GET = handle(async (req) => {
  await requireUser();
  const query = new URL(req.url).searchParams.get("callsign")?.trim() ?? "";
  if (!/^[A-Za-z0-9 -]{3,10}$/.test(query)) throw new HttpError(400, "Enter a flight number like 6E 2131 or AI 101");
  try {
    const { status, searched } = await trackFlight(query);
    const looked = searched.map((g) => `${g.callsign}${g.airline ? ` (${g.airline})` : ""}`).join(", ");
    return {
      status,
      searched,
      note: status ? null : `Looked for ${looked}. Not in the air right now — live tracking shows flights from takeoff until shortly after landing.`,
    };
  } catch (e) {
    throw new HttpError(502, (e as Error).message);
  }
});
