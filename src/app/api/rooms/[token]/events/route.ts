import { sseResponse } from "@/server/events.ts";
import { handle } from "@/server/http.ts";
import { rateLimit, roomView } from "@/server/rooms.ts";
import { clientIp, type TokenCtx } from "../../shared.ts";

export const GET = handle<TokenCtx>(async (req, { params }) => {
  rateLimit(clientIp(req));
  const room = await roomView((await params).token); // validates the token
  return sseResponse(req, `room:${room.id}`);
});
