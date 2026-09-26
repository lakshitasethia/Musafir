import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { interpretMicroEdit } from "@/server/microedit.ts";

const Input = z.object({ text: z.string().trim().min(1).max(200) });

/** Operator-only: interpret a quick edit into previewable patches (never applies). */
export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  const { text } = await body(req, Input);
  return interpretMicroEdit(await requireUser("operator"), id, dayIndexOf(dayIndex), text);
});
