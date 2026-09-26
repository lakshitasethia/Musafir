"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";
import { clearOfflineData } from "./offlineStore";

const OPERATOR_NAV = [
  { href: "/", label: "Home" },
  { href: "/ops", label: "Operations" },
];

const TRAVELLER_NAV = [
  { href: "/", label: "Home" },
  { href: "/trip", label: "Trips" },
  { href: "/flights", label: "Flights" },
  { href: "/hotels", label: "Hotels" },
  { href: "/packages", label: "Packages" },
];

export function TopBar({ name, role, home, guest = false }: { name: string; role: "traveller" | "operator"; home: string; guest?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  // Guests confirm with a second tap: leaving guest mode loses unsaved trips. No blocking dialogs.
  const [confirmLeave, setConfirmLeave] = useState(false);
  return (
    <header className="mz-topbar">
      <Link href={home} className="mz-brand">
        Musafir
      </Link>
      <nav className="mz-topnav" aria-label="Main">
          {(role === "traveller" ? TRAVELLER_NAV : OPERATOR_NAV).map((n) => (
            <Link key={n.href} href={n.href} className="mz-topnav-link" aria-current={pathname === n.href || (n.href === "/trip" && pathname.startsWith("/trip/")) ? "page" : undefined}>
              {n.label}
            </Link>
          ))}
      </nav>
      <div className="mz-topbar-right">
        <span className="mz-small mz-muted" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {name}
        </span>
        <span className="mz-role">{guest ? "guest" : role}</span>
        {guest && (
          <Link className="mz-btn mz-btn-solid mz-btn-sm" href="/signup">
            Save my trips
          </Link>
        )}
        <button
          className="mz-btn mz-btn-ghost mz-btn-sm"
          onBlur={() => setConfirmLeave(false)}
          onClick={async () => {
            if (guest && !confirmLeave) return setConfirmLeave(true);
            await api("/api/auth/logout", { body: {} });
            await clearOfflineData(); // shared phones: don't leave trips behind
            router.replace("/login");
            router.refresh();
          }}
        >
          {guest ? (confirmLeave ? "Tap again — guest trips will be lost" : "Leave") : "Log out"}
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
