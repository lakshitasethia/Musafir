import type { Metadata } from "next";
import Link from "next/link";
import { FooterSection } from "../components/FooterSection";
import { GridSvg } from "../components/GridSvg";

export const metadata: Metadata = {
  title: "Subscription | Musafir",
  description: "Plan free. Upgrade only when Musafir's automation starts paying for itself.",
};

interface Plan {
  audience: string;
  name: string;
  line: string;
  price: string;
  per: string;
  features: string[];
  cta: { label: string; href: string };
  featured?: boolean;
}

// Every feature listed is something Musafir does today.
const PLANS: Plan[] = [
  {
    audience: "For independent explorers",
    name: "Traveller Free",
    line: "Plan unlimited multi-day trips from real places, shaped by your vibe.",
    price: "$0",
    per: "forever",
    features: [
      "Day-by-day plans drafted from real map data",
      "Vibe faders for pace, budget, atmosphere and rhythm",
      "Say what changed, get a healed day back",
      "Group vote for a meal with friends",
      "Your trip saved for offline use",
    ],
    cta: { label: "Start planning free", href: "/trip" },
  },
  {
    audience: "For frequent travellers",
    name: "Musafir Sentinel Plus",
    line: "Musafir watches every trip and fixes the day before you notice.",
    price: "$29",
    per: "per trip",
    features: [
      "Everything in Traveller Free",
      "Weather watch on every day of your trip",
      "Automatic fixes within limits you set",
      "Operator backup for locked bookings",
      "One-tap cards whenever a choice is yours",
    ],
    cta: { label: "Unlock protection", href: "/signup" },
    featured: true,
  },
  {
    audience: "For DMCs & tour operators",
    name: "Operator Studio",
    line: "The back office for every trip you run: approvals, weather and the whole fleet.",
    price: "$199",
    per: "per month",
    features: [
      "Approval queue with reply-by deadlines",
      "Weather digital twin with what-if simulation",
      "Fleet dashboard of every active trip",
      "Autonomy rules per trip",
      "Verify trips your team has checked",
    ],
    cta: { label: "Apply for operator access", href: "/signup" },
  },
];

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="plan_cta-icon">
      <path d="M13.5026 7.05623L7.05882 13.5L6 12.4412L12.4438 5.9974H6.76429V4.5H15V12.7357H13.5026V7.05623Z" fill="currentColor" />
    </svg>
  );
}

export default function SubscriptionPage() {
  return (
    <div className="page-wrapper subscription_page">
      <header className="nav_component" style={{ color: "#3d2d20" }}>
        <div className="padding-global">
          <div className="nav_container">
            <nav className="nav_menu" role="navigation">
              <div className="nav_menu-content">
                {/* Plain <a>: a full page load lets the guest-session redirect set its cookie. */}
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
            <Link href="/" className="nav_brand" aria-label="Musafir home">
              <div className="nav_logo">
                <span className="nav_wordmark">Musafir</span>
              </div>
            </Link>
            <div className="nav_contact-wrp">
              <a href="/login" className="button is-secondary is-nav" style={{ borderColor: "#3d2d20", color: "#3d2d20", marginRight: "0.5rem" }}>
                LOG IN
              </a>
              <Link href="/subscription" className="button is-secondary is-nav is-current" aria-current="page">
                SUBSCRIPTION
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="section_subscription">
        <div className="subscription_grid" aria-hidden="true">
          <GridSvg />
        </div>
        <div className="padding-global">
          <div className="subscription_head">
            <h1 className="subscription_title">
              Plan free.
              <br />
              Pay when it pays off.
            </h1>
            <p className="subscription_lead">
              Start with everything you need to plan and heal a trip. Upgrade only when the automation starts paying for itself.
            </p>
          </div>

          <ul className="plan_list">
            {PLANS.map((p) => (
              <li key={p.name} className={`plan_card${p.featured ? " is-featured" : ""}`}>
                <span className="plan_audience">{p.audience}</span>
                <h2 className="plan_name">{p.name}</h2>
                <p className="plan_line">{p.line}</p>
                <p className="plan_price">
                  <span className="plan_amount">{p.price}</span>
                  <span className="plan_per">/ {p.per}</span>
                </p>
                <ul className="plan_features">
                  {p.features.map((f) => (
                    <li key={f}>
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M6.2 11.6 2.8 8.2l1-1 2.4 2.4 6-6 1 1z" fill="currentColor" />
                      </svg>
                      {f}
                    </li>
                  ))}
                </ul>
                {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
                <a href={p.cta.href} className="plan_cta">
                  {p.cta.label}
                  <Arrow />
                </a>
              </li>
            ))}
          </ul>

          <p className="subscription_note">
            Prices in USD. Payments aren&apos;t live yet, so every plan starts on the free tier today.
          </p>
        </div>
      </main>

      <FooterSection />
    </div>
  );
}
