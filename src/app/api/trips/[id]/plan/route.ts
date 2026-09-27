import { after } from "next/server";
import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { handle, type IdCtx } from "@/server/http.ts";
import { runPlanner } from "@/server/planner.ts";
import { startPlanner } from "@/server/trips.ts";

const Input = z.object({ replan: z.boolean().optional() });

/** POST — plan empty days; { replan: true } redrafts planned days with the current preferences. */
export const POST = handle<IdCtx>(async (req, { params }) => {
  const { id } = await params;
  const text = await req.text();
  const { replan } = text ? Input.parse(JSON.parse(text)) : { replan: false };
  const out = await startPlanner(await requireUser(), id, { replan });
  after(() => runPlanner(id));
  return out;
});
