import { after } from "next/server";
import { requireUser } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";
import { runPlanner } from "@/server/planner.ts";
import { CreateTripSchema, createTrip, listTrips } from "@/server/trips.ts";

export const GET = handle(async () => ({ trips: await listTrips(await requireUser()) }));

export const POST = handle(async (req) => {
  const user = await requireUser("traveller");
  const input = await body(req, CreateTripSchema);
  const id = await createTrip(user, input);
  if (input.autoPlan) after(() => runPlanner(id));
  return { id };
});
