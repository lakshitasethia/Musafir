import { HttpError, requireUser } from "@/server/auth.ts";
import { handle } from "@/server/http.ts";
import { reverseLocal } from "@/server/osm.ts";

export const GET = handle(async (req) => {
  await requireUser();
  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new HttpError(400, "Invalid coordinates");
  try {
    return { place: await reverseLocal(lat, lng) };
  } catch (e) {
    throw new HttpError(502, `Address lookup is unavailable right now (${(e as Error).message})`);
  }
});
