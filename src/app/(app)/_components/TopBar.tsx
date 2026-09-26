"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "./api";

export function TopBar({ name, role, home }: { name: string; role: "traveller" | "operator"; home: string }) {
  const router = useRouter();
  return (
    <header className="mz-topbar">
      <Link href={home} className="mz-brand">
        Musafir
      </Link>
      <div className="mz-topbar-right">
        <span className="mz-small mz-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <span className="mz-role">{role}</span>
        <button
          className="mz-btn mz-btn-ghost mz-btn-sm"
          onClick={async () => {
            await api("/api/auth/logout", { body: {} });
            router.replace("/login");
            router.refresh();
          }}
        >
          Log out
        </button>
      </div>
    </header>
  );
}

export function Toast({ toast }: { toast: { text: string; error?: boolean } | null }) {
  if (!toast) return null;
  return (
    <div className={`mz-toast${toast.error ? " is-error" : ""}`} role="status" aria-live="polite">
      {toast.text}
    </div>
  );
}
