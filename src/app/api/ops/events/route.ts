import { requireUser } from "@/server/auth.ts";
import { sseResponse } from "@/server/events.ts";
import { handle } from "@/server/http.ts";

export const GET = handle(async (req) => {
  await requireUser("operator");
  return sseResponse(req, "ops");
});
