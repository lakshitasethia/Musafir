"use client";

import React, { useEffect, useState } from "react";

export function FooterSection() {
  const [dateTime, setDateTime] = useState({
    date: "Saturday, September 26, 2026",
    time: "02:29:13 PM",
  });

  useEffect(() => {
    const timeZone = "Asia/Dubai";

    const dateFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const timeFormatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });

    const updateClock = () => {
      const now = new Date();
      setDateTime({
        date: dateFormatter.format(now),
        time: timeFormatter.format(now),
      });
    };

    updateClock();
    const timer = setInterval(updateClock, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <footer className="footer_wrapper" id="footer">
      {/* Layered cinematic blurred background */}
      <div className="footer_bg-container" aria-hidden="true">
        <div className="footer_bg-scenic" />
        <div className="footer_bg-overlay" />
      </div>

      {/* Main footer foreground content */}
      <div className="section_footer">
        <div className="footer_content">
          <div className="footer_main">
            {/* Top row: 3 columns on left, accreditation on right */}
            <div className="footer_top-wrapper">
              <div className="footer_grid">
                {/* Column 1: MENU */}
                <div className="footer_column">
                  <span className="footer_column-heading">MENU</span>
                  <nav className="footer_column-content" aria-label="Footer Menu">
                    <a href="#about" className="footer_link">
                      About
                    </a>
                    <a href="#private" className="footer_link">
                      Private
                    </a>
                    <a href="#corporate" className="footer_link">
                      Corporate
                    </a>
                    <a href="#careers" className="footer_link">
                      Careers
                    </a>
                    <a href="#contact" className="footer_link">
                      Contact
                    </a>
                  </nav>
                </div>

                {/* Column 2: SOCIALS */}
                <div className="footer_column">
                  <span className="footer_column-heading">SOCIALS</span>
                  <nav className="footer_column-content" aria-label="Social Links">
                    <a
                      href="https://www.instagram.com/flyward"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="footer_link"
                    >
                      Instagram
                    </a>
                    <a
                      href="https://www.tiktok.com/@flyward"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="footer_link"
                    >
                      TikTok
                    </a>
                  </nav>
                </div>

                {/* Column 3: LOCATION */}
                <div className="footer_column footer_column-location">
                  <span className="footer_column-heading">LOCATION</span>
                  <div className="footer_column-content">
                    <span className="footer_text">Dubai, UAE</span>
                    <span className="footer_text footer_text-nowrap" data-date>
                      {dateTime.date}
                    </span>
                    <span className="footer_text" data-time>
                      {dateTime.time}
                    </span>
                  </div>
                </div>
              </div>

              {/* Right-side accreditation block */}
              <div className="footer_accreditation">
                <div className="footer_accreditation-item">
                  IATA Agent: 8622194
                </div>
                <div className="footer_accreditation-item">
                  DMCC License: 900695
                </div>
                <div className="footer_accreditation-item">
                  DCAA Accredited
                </div>
              </div>
            </div>

            {/* Bottom legal row */}
            <div className="footer_bottom">
              <div className="footer_bottom-left">
                © Flyward FZCO, a Panathon company
              </div>
              <div className="footer_bottom-center">
                All Rights Reserved
              </div>
              <div className="footer_bottom-links">
                <a
                  href="https://www.iubenda.com/privacy-policy/59084511/cookie-policy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="footer_legal-link"
                >
                  Cookie Policy
                </a>
                <a
                  href="https://www.iubenda.com/privacy-policy/59084511"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="footer_legal-link"
                >
                  Privacy Policy
                </a>
                <a
                  href="https://www.iubenda.com/terms-and-conditions/59084511"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="footer_legal-link"
                >
                  Terms of Use
                </a>
              </div>
            </div>
          </div>

          {/* Giant FLYWARD signature typography */}
          <div className="footer_logo-wrapper" aria-hidden="true">
            <img
              src="/images/footer-logo.svg"
              alt="FLYWARD"
              className="footer_logo"
              loading="lazy"
            />
          </div>
        </div>
      </div>
    </footer>
  );
}
