import { z } from "zod";
import { requireUser } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";
import { ownerDecide } from "@/server/rooms.ts";
import type { TokenCtx } from "../../shared.ts";

const Input = z.object({ optionId: z.string().min(1).max(80) });

export const POST = handle<TokenCtx>(async (req, { params }) => {
  await ownerDecide(await requireUser("traveller"), (await params).token, (await body(req, Input)).optionId);
});
