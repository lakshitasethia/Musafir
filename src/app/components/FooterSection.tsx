"use client";

import Link from "next/link";
import React, { useEffect, useState } from "react";

/* Dashed arc drawn inside each grid row, echoing GridSvg in the hero.
   Stretched with preserveAspectRatio="none"; the stroke stays 1px via
   vector-effect so it never thickens on wide screens. */
function RowArc({ flip = false }: { flip?: boolean }) {
  return (
    <svg
      className="footer_arc"
      viewBox="0 0 1336 346"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <path
        d={
          flip
            ? "M0 346C145.7 136.8 390.5 0 668 0C945.5 0 1190.3 136.8 1336 346"
            : "M0 0C145.7 209.2 390.5 346 668 346C945.5 346 1190.3 209.2 1336 0"
        }
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function FooterSection() {
  // Rendered only after mount so server and client markup match; the
  // viewer's own timezone is used, since Musafir has no single home city.
  const [now, setNow] = useState<{ date: string; time: string; zone: string } | null>(null);

  useEffect(() => {
    const dateFormatter = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
    const timeFormatter = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone.replace(/_/g, " ");

    const tick = () => {
      const d = new Date();
      setNow({ date: dateFormatter.format(d), time: timeFormatter.format(d), zone });
    };

    tick();
    const timer = setInterval(tick, 15_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <footer className="footer_paper" id="footer">
      {/* Nautical coastline line-art bleeding off both edges */}
      <img
        src="/images/transition-map.svg"
        alt=""
        aria-hidden="true"
        className="footer_map footer_map-right"
      />
      <img
        src="/images/transition-map.svg"
        alt=""
        aria-hidden="true"
        className="footer_map footer_map-left"
      />

      <div className="footer_sheet">
        {/* Row 1: statement */}
        <div className="footer_row">
          <RowArc />
          <h2 className="footer_headline">
            Plans break.
            <br />
            Journeys don&rsquo;t.
          </h2>

          <div className="footer_cell footer_cell-intro">
            <p className="footer_body">
              Musafir drafts every day of your trip from real places, then
              quietly re-plans it when a train runs late, a museum shuts or the
              rain rolls in. You only step in when a choice is truly yours to
              make.
            </p>
            <div className="footer_actions">
              <Link href="/signup" className="footer_cta">
                Start a trip
              </Link>
              <Link href="/login" className="footer_cta is-ghost">
                Log in
              </Link>
            </div>
          </div>
        </div>

        {/* Row 2: wayfinding, staggered into the grid */}
        <div className="footer_row is-second">
          <RowArc flip />

          <div className="footer_cell footer_cell-time">
            <span className="footer_label">Your local time</span>
            <span className="footer_clock" suppressHydrationWarning>
              {now?.time ?? "--:--"}
            </span>
            <span className="footer_meta">
              {now ? `${now.date}, ${now.zone}` : " "}
            </span>
          </div>

          <nav className="footer_cell footer_cell-nav" aria-label="Footer">
            <span className="footer_label">Explore</span>
            <a href="#discover" className="footer_link">
              Discover
            </a>
            <a href="#how-we-support" className="footer_link">
              How it works
            </a>
            <Link href="/trip" className="footer_link">
              Your trips
            </Link>
            <Link href="/ops" className="footer_link">
              Operator console
            </Link>
          </nav>

          <div className="footer_cell footer_cell-data">
            <span className="footer_label">Built on open data</span>
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noopener noreferrer"
              className="footer_link"
            >
              © OpenStreetMap contributors
            </a>
            <a
              href="https://open-meteo.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="footer_link"
            >
              Weather by Open-Meteo
            </a>
            <a
              href="https://project-osrm.org/"
              target="_blank"
              rel="noopener noreferrer"
              className="footer_link"
            >
              Routing by OSRM
            </a>
          </div>
        </div>

        <div className="footer_bottom-row">
          <span>© 2026 Musafir</span>
          <a href="#" className="footer_link is-small">
            Back to top
          </a>
        </div>
      </div>

      {/* Wordmark set in Apris, cropped by the page edge */}
      <div className="footer_wordmark" aria-hidden="true">
        Musafir
      </div>
    </footer>
  );
}
