import { clearSessionCookie } from "@/server/auth.ts";
import { handle } from "@/server/http.ts";

export const POST = handle(async () => {
  await clearSessionCookie();
});
