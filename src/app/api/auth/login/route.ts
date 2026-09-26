import { LoginSchema, login, setSessionCookie } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";

export const POST = handle(async (req) => {
  const user = await login(await body(req, LoginSchema));
  await setSessionCookie(user);
  return { user };
});
