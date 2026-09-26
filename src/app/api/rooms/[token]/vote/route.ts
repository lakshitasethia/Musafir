import { z } from "zod";
import { body, handle } from "@/server/http.ts";
import { castVote, rateLimit } from "@/server/rooms.ts";
import { clientIp, type TokenCtx } from "../../shared.ts";

const Input = z.object({
  participantId: z.uuid(),
  key: z.string().regex(/^[0-9a-f]{32}$/),
  optionId: z.string().min(1).max(80),
  vote: z.enum(["yes", "no"]),
});

export const POST = handle<TokenCtx>(async (req, { params }) => {
  rateLimit(clientIp(req));
  const v = await body(req, Input);
  await castVote((await params).token, v.participantId, v.key, v.optionId, v.vote);
});
