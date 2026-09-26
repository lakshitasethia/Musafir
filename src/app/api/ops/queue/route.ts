import { requireUser } from "@/server/auth.ts";
import { handle } from "@/server/http.ts";
import { listTrips, operatorQueue } from "@/server/trips.ts";

export const GET = handle(async () => {
  const user = await requireUser("operator");
  return { queue: await operatorQueue(user), trips: await listTrips(user) };
});
