import { z } from "zod";
import { VibeConfigSchema } from "@/lib/musafir/schemas.ts";
import { requireUser } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";
import { suggestDestinations } from "@/server/suggest.ts";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Input = z.object({
  text: z.string().trim().max(600).optional(),
  vibe: VibeConfigSchema,
  startDate: DATE,
  endDate: DATE,
  exclude: z.array(z.string().max(80)).max(30).optional(),
});

/** POST /api/suggest — destination ideas for "wherever" / "I want to chill": verified places with real facts. */
export const POST = handle(async (req) => {
  await requireUser();
  return suggestDestinations(await body(req, Input));
});
