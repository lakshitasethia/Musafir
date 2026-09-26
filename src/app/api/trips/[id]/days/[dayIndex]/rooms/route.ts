import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, dayIndexOf, handle, type DayCtx } from "@/server/http.ts";
import { createRoom } from "@/server/rooms.ts";

const Input = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  durationMinutes: z.number().int().min(20).max(240).default(75),
});

/** Trip owner opens a group vote for a meal slot. */
export const POST = handle<DayCtx>(async (req, { params }) => {
  const { id, dayIndex } = await params;
  return createRoom(await requireUser("traveller"), id, dayIndexOf(dayIndex), await body(req, Input));
});
