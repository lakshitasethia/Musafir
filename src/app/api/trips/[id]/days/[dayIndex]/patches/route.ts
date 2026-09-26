import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { DirectPatchSchema, applyDirectPatches } from "@/server/trips.ts";

export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  const version = await applyDirectPatches(await requireUser(), id, dayIndexOf(dayIndex), await body(req, DirectPatchSchema));
  return { version };
});
