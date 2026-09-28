"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Landing and subscription nav. Desktop: links · centred wordmark · Log in /
 * Subscription. Hovering (or focusing) a left link drops a full-width menu
 * panel under the bar; moving between links swaps the contents in place.
 * Phones (≤767px): wordmark + a Menu button that opens a panel with every
 * link, since the full bar doesn't fit.
 */

type MenuLink = { label: string; href: string; note?: string };
type MenuColumn = { eyebrow: string; links: MenuLink[] };
type Menu = {
  id: string;
  label: string;
  href: string;
  columns: MenuColumn[];
  feature: { img: string; eyebrow: string; title: string; text: string; href: string; cta: string };
};

// Every href is a real route. Traveller pages start a guest session on arrival.
const MENUS: Menu[] = [
  {
    id: "plan",
    label: "PLAN",
    href: "/trip",
    columns: [
      {
        eyebrow: "Start here",
        links: [
          { label: "Plan a trip", href: "/trip", note: "A destination, your dates and a few faders. Every day drafted from real places." },
          { label: "My dashboard", href: "/dashboard", note: "All your trips as one live map of days and stops." },
        ],
      },
      {
        eyebrow: "Who's going",
        links: [
          { label: "Solo travel", href: "/solo/packages", note: "Your pace, your stops, handled quietly." },
          { label: "Group travel", href: "/group/packages", note: "Everyone votes on the vibe, one plan comes out." },
        ],
      },
    ],
    feature: {
      img: "/images/journey-kerala.jpg",
      eyebrow: "When plans break",
      title: "A day that heals itself",
      text: "A delay, a closure, rain. The day rearranges around it and asks for a tap only when it must.",
      href: "/trip",
      cta: "Start planning",
    },
  },
  {
    id: "flights",
    label: "FLIGHTS",
    href: "/flights",
    columns: [
      {
        eyebrow: "Flights",
        links: [
          { label: "Find a flight", href: "/flights", note: "Google Flights, prefilled from your trip." },
          { label: "Track a flight", href: "/flights", note: "Live position of a flight in the air." },
        ],
      },
      {
        eyebrow: "On the ground",
        links: [
          { label: "Taxi rescue card", href: "/taxi", note: "Your next stop in the local script. Works offline." },
        ],
      },
    ],
    feature: {
      img: "/images/journey-ladakh.jpg",
      eyebrow: "Landed late?",
      title: "The plan catches up",
      text: "Tell us you're running behind and the rest of the day moves with you.",
      href: "/flights",
      cta: "Find a flight",
    },
  },
  {
    id: "hotels",
    label: "HOTELS",
    href: "/hotels",
    columns: [
      {
        eyebrow: "Stays",
        links: [
          { label: "Where to stay", href: "/hotels", note: "Real places to stay near your day's stops." },
          { label: "Add a stay to your trip", href: "/hotels", note: "Pin it to the plan, with a taxi card to get there." },
        ],
      },
    ],
    feature: {
      img: "/images/journey-hawa-mahal.jpg",
      eyebrow: "Close to the plan",
      title: "Sleep near tomorrow",
      text: "Stays are picked around the stops you'll actually visit, not a city centre pin.",
      href: "/hotels",
      cta: "Find a stay",
    },
  },
  {
    id: "packages",
    label: "PACKAGES",
    href: "/packages",
    columns: [
      {
        eyebrow: "Travel styles",
        links: [
          { label: "Heritage & Street Food", href: "/packages" },
          { label: "Slow & Scenic", href: "/packages" },
          { label: "Local & After Dark", href: "/packages" },
          { label: "See It All", href: "/packages" },
          { label: "Treat Yourself", href: "/packages" },
        ],
      },
      {
        eyebrow: "Made for",
        links: [
          { label: "Solo travellers", href: "/solo/packages", note: "One tap creates and plans the trip." },
          { label: "Groups", href: "/group/packages", note: "Friends, families, the whole office." },
        ],
      },
    ],
    feature: {
      img: "/images/package-heritage.jpg",
      eyebrow: "One tap",
      title: "Pick a way to travel",
      text: "Choose a style, name a place, and the whole trip is drafted for you.",
      href: "/packages",
      cta: "See packages",
    },
  },
];

// Hover intent: a short pause before the first open so a cursor passing over
// the bar doesn't flash the panel, and a grace period before closing so the
// cursor can travel from a link down into the panel.
const OPEN_DELAY_MS = 70;
const CLOSE_DELAY_MS = 180;

const Chevron = () => (
  <svg className="nav_dd-chevron" viewBox="0 0 10 6" width="10" height="6" aria-hidden="true">
    <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.2" />
  </svg>
);

const Arrow = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M13.5026 7.05623L7.05882 13.5L6 12.4412L12.4438 5.9974H6.76429V4.5H15V12.7357H13.5026V7.05623Z" fill="currentColor" />
  </svg>
);

export function SiteNav({ dark = false, current }: { dark?: boolean; current?: "subscription" }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // The bar turns to paper whenever a panel is showing, so ink goes umber.
  const paper = open || active !== null;
  const ink = dark && !paper ? "#ffffff" : "#3d2d20";

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const show = useCallback(
    (id: string) => {
      clearTimer();
      // Already open: swap straight away. First open: wait a beat.
      if (active !== null) setActive(id);
      else timer.current = window.setTimeout(() => setActive(id), OPEN_DELAY_MS);
    },
    [active],
  );

  const hide = useCallback(() => {
    clearTimer();
    timer.current = window.setTimeout(() => setActive(null), CLOSE_DELAY_MS);
  }, []);

  const closeNow = useCallback(() => {
    clearTimer();
    setActive(null);
  }, []);

  useEffect(() => clearTimer, []);

  // Panel height follows the active menu, so switching menus glides.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const body = active ? bodyRefs.current[active] : null;
    panel.style.height = body ? `${body.offsetHeight}px` : "0px";
  }, [active]);

  // Escape closes; scrolling the page closes the menu like any overlay.
  useEffect(() => {
    if (active === null) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeNow();
    const onScroll = () => closeNow();
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll);
    };
  }, [active, closeNow]);

  // Close the phone panel on Escape and when the viewport grows past phone width.
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

  // Mouse only: on touch, a tap on PLAN should just go to /trip.
  const onEnter = (id: string) => (e: React.PointerEvent) => {
    if (e.pointerType === "mouse") show(id);
  };

  return (
    <header
      className={`nav_component${open ? " is-open" : ""}${dark && !paper ? " is-dark" : ""}${active ? " is-menu-open" : ""}`}
      style={{ color: ink, ["--nav-ink" as string]: ink }}
      onPointerLeave={(e) => e.pointerType === "mouse" && hide()}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeNow();
      }}
    >
      <div className="padding-global">
        <div className="nav_container">
          <nav className="nav_menu" role="navigation" aria-label="Main">
            <div className="nav_menu-content">
              {/* Product entry points work without login — a guest session starts on arrival.
                  Plain <a> on purpose: a full page load lets the guest-session redirect set its cookie. */}
              {MENUS.map((m) => (
                <a
                  key={m.id}
                  href={m.href}
                  className={`nav_menu_link${active === m.id ? " is-active" : ""}`}
                  aria-expanded={active === m.id}
                  aria-controls={`nav-dd-${m.id}`}
                  onPointerEnter={onEnter(m.id)}
                  onFocus={() => show(m.id)}
                >
                  {m.label}
                  <Chevron />
                </a>
              ))}
            </div>
          </nav>

          <Link href="/" className="nav_brand" aria-label="Musafir home" onClick={() => setOpen(false)}>
            <div className="nav_logo">
              <span className="nav_wordmark">Musafir</span>
            </div>
          </Link>

          <div className="nav_contact-wrp" onPointerEnter={(e) => e.pointerType === "mouse" && hide()}>
            <a href="/login" className="button is-secondary is-nav" style={{ marginRight: "0.5rem" }}>
              LOG IN
            </a>
            <Link
              href="/subscription"
              className={`button is-secondary is-nav${current === "subscription" ? " is-current" : ""}`}
              aria-current={current === "subscription" ? "page" : undefined}
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

      {/* Desktop menu panel. Every menu is rendered; only the active one shows. */}
      <div className="nav_dd" ref={panelRef} onPointerEnter={clearTimer}>
        {MENUS.map((m) => {
          const on = active === m.id;
          return (
            <div
              key={m.id}
              id={`nav-dd-${m.id}`}
              ref={(el) => {
                bodyRefs.current[m.id] = el;
              }}
              className={`nav_dd-body${on ? " is-active" : ""}`}
              inert={!on}
              aria-hidden={!on}
            >
              <div className="padding-global">
                <div className="nav_dd-grid">
                  <div className="nav_dd-cols">
                    {m.columns.map((c, ci) => (
                      <div key={c.eyebrow} className="nav_dd-col" style={{ ["--i" as string]: ci }}>
                        <div className="nav_dd-eyebrow">{c.eyebrow}</div>
                        <ul className="nav_dd-list">
                          {c.links.map((l) => (
                            <li key={l.label}>
                              <a href={l.href} className={`nav_dd-link${l.note ? " has-note" : ""}`} onClick={closeNow}>
                                <span className="nav_dd-label">{l.label}</span>
                                {l.note && <span className="nav_dd-note">{l.note}</span>}
                              </a>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>

                  <a
                    href={m.feature.href}
                    className="nav_dd-feature"
                    style={{ ["--i" as string]: m.columns.length }}
                    onClick={closeNow}
                  >
                    <div className="nav_dd-feature-img">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={m.feature.img} alt="" loading="lazy" />
                    </div>
                    <div className="nav_dd-feature-text">
                      <div className="nav_dd-eyebrow">{m.feature.eyebrow}</div>
                      <div className="nav_dd-feature-title">{m.feature.title}</div>
                      <p>{m.feature.text}</p>
                      <span className="nav_dd-feature-cta">
                        {m.feature.cta} <Arrow />
                      </span>
                    </div>
                  </a>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Dims the page under an open menu; a click on it closes. */}
      <div className="nav_dd-scrim" aria-hidden="true" onClick={closeNow} onPointerEnter={(e) => e.pointerType === "mouse" && hide()} />

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
