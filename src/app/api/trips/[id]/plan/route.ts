import { after } from "next/server";
import { requireUser } from "@/server/auth.ts";
import { handle, type IdCtx } from "@/server/http.ts";
import { runPlanner } from "@/server/planner.ts";
import { startPlanner } from "@/server/trips.ts";

export const POST = handle<IdCtx>(async (_req, { params }) => {
  const { id } = await params;
  await startPlanner(await requireUser(), id);
  after(() => runPlanner(id));
});
