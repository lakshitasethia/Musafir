import { HttpError, requireUser } from "@/server/auth.ts";
import { handle } from "@/server/http.ts";
import { searchPlaces } from "@/server/osm.ts";

export const GET = handle(async (req) => {
  await requireUser();
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const lat = Number(url.searchParams.get("lat"));
  const lng = Number(url.searchParams.get("lng"));
  const near = url.searchParams.has("lat") && Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : undefined;
  try {
    return { results: await searchPlaces(q, near) };
  } catch (e) {
    throw new HttpError(502, `Place search is unavailable right now (${(e as Error).message})`);
  }
});
