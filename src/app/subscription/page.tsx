import type { Metadata } from "next";
import { FooterSection } from "../components/FooterSection";
import { GridSvg } from "../components/GridSvg";
import { SiteNav } from "../components/SiteNav";

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
  /** href = plain link; checkout = Stripe Checkout for that plan (test mode) */
  cta: { label: string; href?: string; checkout?: "plus" | "studio" };
  featured?: boolean;
}

// Every feature listed is something Musafir does today.
const PLANS: Plan[] = [
  {
    audience: "For independent explorers",
    name: "Traveller Free",
    line: "Plan unlimited multi-day trips from real places, shaped by your vibe.",
    price: "₹0",
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
    name: "Musafir Plus",
    line: "Musafir watches every trip and fixes the day before you notice.",
    price: "₹2,499",
    per: "per trip",
    features: [
      "Everything in Traveller Free",
      "Weather watch on every day of your trip",
      "Automatic fixes within limits you set",
      "Operator backup for locked bookings",
      "One-tap cards whenever a choice is yours",
    ],
    cta: { label: "Unlock protection", checkout: "plus" },
    featured: true,
  },
  {
    audience: "For DMCs & tour operators",
    name: "Operator Studio",
    line: "The back office for every trip you run: approvals, weather and the whole fleet.",
    price: "₹16,999",
    per: "per trip",
    features: [
      "Approval queue with reply-by deadlines",
      "Weather digital twin with what-if simulation",
      "Fleet dashboard of every active trip",
      "Autonomy rules per trip",
      "Verify trips your team has checked",
    ],
    cta: { label: "Apply for operator access", checkout: "studio" },
  },
];

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="plan_cta-icon">
      <path d="M13.5026 7.05623L7.05882 13.5L6 12.4412L12.4438 5.9974H6.76429V4.5H15V12.7357H13.5026V7.05623Z" fill="currentColor" />
    </svg>
  );
}

// Where Stripe (or the checkout route) sent the visitor back to.
const CHECKOUT_BANNER: Record<string, { tone: "ok" | "info" | "warn"; text: string }> = {
  success: { tone: "ok", text: "Payment received in Stripe test mode. No real money moved, and nothing is unlocked yet: that needs a verified Stripe webhook." },
  cancelled: { tone: "info", text: "Checkout cancelled. Nothing was charged." },
  unconfigured: { tone: "warn", text: "Stripe isn't connected yet: add a test secret key (STRIPE_SECRET_KEY=sk_test_…) to .env.local and restart the dev server." },
  "live-key-refused": { tone: "warn", text: "A live Stripe key is set. This demo only runs in test mode, so the checkout was not opened." },
  "stripe-error": { tone: "warn", text: "Stripe couldn't open a checkout just now. Check the key and try again." },
  "unknown-plan": { tone: "warn", text: "That plan can't be bought online." },
};

export default async function SubscriptionPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const status = (await searchParams).checkout;
  const banner = typeof status === "string" ? CHECKOUT_BANNER[status] : undefined;
  return (
    <div className="page-wrapper subscription_page">
      <SiteNav current="subscription" />

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

          {banner && (
            <p id="checkout-status" className={`checkout_banner is-${banner.tone}`} role="status">
              {banner.text}
            </p>
          )}

          <ul className="plan_list" id="plans">
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
                {p.cta.checkout ? (
                  // Posts to our route, which opens Stripe's hosted checkout.
                  <form method="post" action="/api/checkout" className="plan_cta-form">
                    <input type="hidden" name="plan" value={p.cta.checkout} />
                    <button type="submit" className="plan_cta">
                      {p.cta.label}
                      <Arrow />
                    </button>
                  </form>
                ) : (
                  // eslint-disable-next-line @next/next/no-html-link-for-pages
                  <a href={p.cta.href} className="plan_cta">
                    {p.cta.label}
                    <Arrow />
                  </a>
                )}
              </li>
            ))}
          </ul>

          <p className="subscription_note">
            Prices in INR. Checkout runs on Stripe in test mode: pay with card 4242 4242 4242 4242, any future date, any CVC. No real money moves.
          </p>
        </div>
      </main>

      <FooterSection />
    </div>
  );
}
