"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";

export function AuthForm({ mode, operatorMode }: { mode: "login" | "signup"; operatorMode: "invite" | "open-dev" | "disabled" }) {
  const router = useRouter();
  const [role, setRole] = useState<"traveller" | "operator">("traveller");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === "login"
          ? { email: f.get("email"), password: f.get("password") }
          : { email: f.get("email"), password: f.get("password"), name: f.get("name"), role, inviteCode: f.get("inviteCode") || undefined };
      const { user } = await api<{ user: { role: string } }>(`/api/auth/${mode}`, { body });
      router.replace(user.role === "operator" ? "/ops" : "/trip");
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="mz-auth">
      <form className="mz-auth-card" onSubmit={submit}>
        <Link href="/" className="mz-brand">
          Musafir
        </Link>
        <h1 className="mz-display mz-h1">{mode === "login" ? "Welcome back" : "Begin the journey"}</h1>
        {mode === "signup" && (
          <div className="mz-row" role="group" aria-label="Account type">
            {(["traveller", "operator"] as const).map((r) => (
              <button key={r} type="button" className="mz-chip" aria-pressed={role === r} onClick={() => setRole(r)} disabled={r === "operator" && operatorMode === "disabled"}>
                {r === "traveller" ? "I'm travelling" : "I'm an operator"}
              </button>
            ))}
          </div>
        )}
        {mode === "signup" && (
          <label className="mz-field">
            <span className="mz-label">Name</span>
            <input className="mz-input" name="name" required maxLength={80} autoComplete="name" />
          </label>
        )}
        <label className="mz-field">
          <span className="mz-label">Email</span>
          <input className="mz-input" name="email" type="email" required autoComplete="email" />
        </label>
        <label className="mz-field">
          <span className="mz-label">Password</span>
          <input className="mz-input" name="password" type="password" required minLength={mode === "signup" ? 8 : 1} autoComplete={mode === "signup" ? "new-password" : "current-password"} />
        </label>
        {mode === "signup" && role === "operator" && operatorMode === "invite" && (
          <label className="mz-field">
            <span className="mz-label">Operator invite code</span>
            <input className="mz-input" name="inviteCode" required />
          </label>
        )}
        {mode === "signup" && role === "operator" && operatorMode === "open-dev" && (
          <p className="mz-note">Demo mode: operator sign-up is open because OPERATOR_INVITE_CODE isn&apos;t set. Set it before deploying.</p>
        )}
        {error && <p className="mz-error">{error}</p>}
        <button className="mz-btn mz-btn-solid" disabled={busy}>
          {busy ? "One moment…" : mode === "login" ? "Log in" : "Create account"}
        </button>
        <p className="mz-small mz-muted">
          {mode === "login" ? (
            <>
              New here? <Link href="/signup">Create an account</Link>
            </>
          ) : (
            <>
              Have an account? <Link href="/login">Log in</Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
