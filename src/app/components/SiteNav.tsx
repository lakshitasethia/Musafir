"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

/**
 * Landing and subscription nav. Desktop: links · centred wordmark · Log in /
 * Subscription. Phones (≤767px): wordmark + a Menu button that opens a panel
 * with every link, since the full bar doesn't fit.
 */
export function SiteNav({ dark = false, current }: { dark?: boolean; current?: "subscription" }) {
  const [open, setOpen] = useState(false);
  const ink = dark && !open ? "#ffffff" : "#3d2d20";

  // Close the panel on Escape and when the viewport grows past phone width.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const mq = window.matchMedia("(min-width: 768px)");
    const onWide = () => mq.matches && setOpen(false);
    window.addEventListener("keydown", onKey);
    mq.addEventListener("change", onWide);
    return () => {
      window.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onWide);
    };
  }, [open]);

  const pill = (style: React.CSSProperties = {}) => ({ borderColor: ink, color: ink, ...style });

  return (
    <header className={`nav_component${open ? " is-open" : ""}${dark && !open ? " is-dark" : ""}`} style={{ color: ink }}>
      <div className="padding-global">
        <div className="nav_container">
          <nav className="nav_menu" role="navigation" aria-label="Main">
            <div className="nav_menu-content">
              {/* Product entry points work without login — a guest session starts on arrival.
                  Plain <a> on purpose: a full page load lets the guest-session redirect set its cookie. */}
              {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
              <a href="/trip" className="nav_menu_link">
                PLAN
              </a>
              <a href="/flights" className="nav_menu_link">
                FLIGHTS
              </a>
              <a href="/hotels" className="nav_menu_link">
                HOTELS
              </a>
              <a href="/packages" className="nav_menu_link">
                PACKAGES
              </a>
            </div>
          </nav>

          <Link href="/" className="nav_brand" aria-label="Musafir home" onClick={() => setOpen(false)}>
            <div className="nav_logo">
              <span className="nav_wordmark">Musafir</span>
            </div>
          </Link>

          <div className="nav_contact-wrp">
            <a href="/login" className="button is-secondary is-nav" style={pill({ marginRight: "0.5rem" })}>
              LOG IN
            </a>
            <Link
              href="/subscription"
              className={`button is-secondary is-nav${current === "subscription" ? " is-current" : ""}`}
              aria-current={current === "subscription" ? "page" : undefined}
              style={current === "subscription" ? undefined : pill()}
            >
              SUBSCRIPTION
            </Link>
          </div>

          <button
            type="button"
            className="nav_toggle"
            aria-expanded={open}
            aria-controls="nav-mobile-panel"
            onClick={() => setOpen((o) => !o)}
            style={{ color: ink, borderColor: ink }}
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>

      <div id="nav-mobile-panel" className="nav_mobile-panel" hidden={!open}>
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/trip">Plan a trip</a>
        <a href="/flights">Flights</a>
        <a href="/hotels">Hotels</a>
        <a href="/packages">Packages</a>
        <div className="nav_mobile-actions">
          <a href="/login" className="nav_mobile-btn">
            Log in
          </a>
          <Link href="/subscription" className="nav_mobile-btn is-solid" onClick={() => setOpen(false)}>
            Subscription
          </Link>
        </div>
      </div>
    </header>
  );
}
