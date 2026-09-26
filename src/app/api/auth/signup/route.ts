import { SignupSchema, setSessionCookie, signup } from "@/server/auth.ts";
import { body, handle } from "@/server/http.ts";

export const POST = handle(async (req) => {
  const user = await signup(await body(req, SignupSchema));
  await setSessionCookie(user);
  return { user };
});
