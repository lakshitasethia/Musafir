import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/server/auth.ts";

/** Server-side page gate: logged out → /login, wrong persona → their home. */
export async function gate(role: "traveller" | "operator"): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (user.role !== role) redirect(user.role === "operator" ? "/ops" : "/trip");
  return user;
}
