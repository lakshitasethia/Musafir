import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";
import { ScenarioSchema } from "@/server/twin-schema.ts";
import { fleetTwin } from "@/server/twin.ts";

const Input = z.object({ scenario: ScenarioSchema });

/** POST /api/ops/twin — fleet-wide twin for operators: workload, hotspots, city conditions, social signals. */
export const POST = handle(async (req) => {
  const user = await requireUser("operator");
  return fleetTwin(user, (await body(req, Input)).scenario);
});
