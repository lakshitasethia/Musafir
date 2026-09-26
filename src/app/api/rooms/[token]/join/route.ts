import { z } from "zod";
import { body, handle } from "@/server/http.ts";
import { joinRoom, rateLimit } from "@/server/rooms.ts";
import { clientIp, type TokenCtx } from "../../shared.ts";

const Input = z.object({ name: z.string().trim().min(1).max(40) });

export const POST = handle<TokenCtx>(async (req, { params }) => {
  rateLimit(clientIp(req));
  return joinRoom((await params).token, (await body(req, Input)).name);
});
