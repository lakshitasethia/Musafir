"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";

type Role = "traveller" | "operator";

export function AuthForm({ mode, operatorMode, guest = false, initialRole = "traveller" }: { mode: "login" | "signup"; operatorMode: "invite" | "open-dev" | "disabled"; guest?: boolean; initialRole?: Role }) {
  const router = useRouter();
  const [role, setRole] = useState<Role>(initialRole === "operator" && operatorMode === "disabled" && mode === "signup" ? "traveller" : initialRole);
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
          ? { email: f.get("email"), password: f.get("password"), as: role }
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
        <h1 className="mz-display mz-h1">
          {mode === "login" ? (role === "operator" ? "Operator log in" : "Welcome back") : role === "operator" ? "Operator account" : guest ? "Save your trips" : "Begin the journey"}
        </h1>
        <div className="mz-row" role="group" aria-label="Account type">
          {(["traveller", "operator"] as const).map((r) => (
            <button
              key={r}
              type="button"
              className="mz-chip"
              aria-pressed={role === r}
              onClick={() => setRole(r)}
              disabled={mode === "signup" && r === "operator" && operatorMode === "disabled"}
              title={mode === "signup" && r === "operator" && operatorMode === "disabled" ? "Operator sign-up is disabled on this deployment" : undefined}
            >
              {r === "traveller" ? "Traveller" : "Operator"}
            </button>
          ))}
        </div>
        {guest && mode === "signup" && role === "traveller" && <p className="mz-note">You&apos;re using Musafir as a guest. Add an email and password to keep your trips on any device — nothing you planned is lost.</p>}
        {role === "operator" && <p className="mz-note">Operators approve changes that touch locked bookings or money, set autonomy rules and see every active trip.{mode === "signup" && operatorMode === "invite" ? " You need the invite code from your Musafir admin." : ""}</p>}
        {mode === "login" && role === "traveller" && (
          <Link className="mz-btn mz-btn-ghost" href="/api/auth/guest?next=/trip">
            Continue without an account
          </Link>
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
            <input className="mz-input" name="inviteCode" type="password" required autoComplete="off" />
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
              New here? <Link href={role === "operator" ? "/signup?as=operator" : "/signup"}>Create {role === "operator" ? "an operator" : "an"} account</Link>
            </>
          ) : (
            <>
              Have an account? <Link href={role === "operator" ? "/login?as=operator" : "/login"}>Log in</Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
