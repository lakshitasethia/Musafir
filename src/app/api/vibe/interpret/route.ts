import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { interpretBrief } from "@/server/brief.ts";
import { body, handle } from "@/server/http.ts";

const Input = z.object({ text: z.string().trim().min(1).max(600) });

/** POST /api/vibe/interpret — the traveller's own words → suggested faders, interest chips and must-sees (shown back, editable). */
export const POST = handle(async (req) => {
  await requireUser();
  return interpretBrief((await body(req, Input)).text);
});
