import { redirect } from "next/navigation";
import { getSessionUser, operatorSignupMode } from "@/server/auth.ts";
import { AuthForm } from "../_components/AuthForm";

export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect(user.role === "operator" ? "/ops" : "/trip");
  return <AuthForm mode="login" operatorMode={operatorSignupMode()} />;
}
