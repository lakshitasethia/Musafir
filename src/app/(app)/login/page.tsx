import { redirect } from "next/navigation";
import { getSessionUser, operatorSignupMode } from "@/server/auth.ts";
import { AuthForm } from "../_components/AuthForm";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ as?: string }> }) {
  const user = await getSessionUser();
  if (user && !user.guest) redirect(user.role === "operator" ? "/ops" : "/trip");
  const as = (await searchParams).as === "operator" ? "operator" : "traveller";
  return <AuthForm mode="login" operatorMode={operatorSignupMode()} initialRole={as} />;
}
