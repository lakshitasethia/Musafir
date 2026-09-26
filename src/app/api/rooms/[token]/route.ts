import { handle } from "@/server/http.ts";
import { rateLimit, roomView } from "@/server/rooms.ts";
import { clientIp, type TokenCtx } from "../shared.ts";

/** Public (link-holders): room state without participant keys. */
export const GET = handle<TokenCtx>(async (req, { params }) => {
  rateLimit(clientIp(req));
  return roomView((await params).token);
});
