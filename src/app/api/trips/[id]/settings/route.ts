import { requireUser } from "@/server/auth.ts";
import { body, handle, type IdCtx } from "@/server/http.ts";
import { TripSettingsSchema, updateTripSettings } from "@/server/trips.ts";

export const PATCH = handle<IdCtx>(async (req, { params }) => {
  await updateTripSettings(await requireUser(), (await params).id, await body(req, TripSettingsSchema));
});
