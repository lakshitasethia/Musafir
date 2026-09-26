import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, handle, type IdCtx } from "@/server/http.ts";
import { ScenarioSchema } from "@/server/twin-schema.ts";
import { twinForTrip } from "@/server/twin.ts";

const Input = z.object({ scenario: ScenarioSchema, dayIndex: z.number().int().min(1).optional() });

/** POST /api/trips/:id/twin — the trip's Digital Twin: baseline forecast vs a what-if scenario. Read-only. */
export const POST = handle<IdCtx>(async (req, { params }) => {
  const user = await requireUser();
  const { scenario, dayIndex } = await body(req, Input);
  return twinForTrip(user, (await params).id, scenario, dayIndex);
});
