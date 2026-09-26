import { redirect } from "next/navigation";
import { getSessionUser, operatorSignupMode } from "@/server/auth.ts";
import { AuthForm } from "../_components/AuthForm";

export default async function SignupPage() {
  const user = await getSessionUser();
  if (user && !user.guest) redirect(user.role === "operator" ? "/ops" : "/trip");
  return <AuthForm mode="signup" operatorMode={operatorSignupMode()} guest={!!user?.guest} />;
}
