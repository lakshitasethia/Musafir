import { redirect } from "next/navigation";
import { getSessionUser, type SessionUser } from "@/server/auth.ts";

/**
 * Server-side page gate.
 *  - Traveller pages work without login: no session → a guest session is started.
 *  - Operator pages need a real operator login.
 *  - Wrong persona → their own home.
 */
export async function gate(role: "traveller" | "operator", here: string): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) redirect(role === "traveller" ? `/api/auth/guest?next=${encodeURIComponent(here)}` : "/login");
  if (user.role !== role) redirect(user.role === "operator" ? "/ops" : "/trip");
  return user;
}
