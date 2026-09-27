/**
 * Subscription checkout (demo). Creates a Stripe Checkout Session over Stripe's
 * REST API (no SDK) and redirects to Stripe's hosted payment page; card details
 * never touch Musafir. Test mode only: a live key is refused, so no real money
 * can move until payments are designed properly (webhook, entitlements, GST).
 *
 * Nothing is unlocked on success yet: that needs a verified
 * checkout.session.completed webhook, never the redirect alone.
 */
import { NextResponse } from "next/server";

const PLANS = {
  plus: { name: "Musafir Plus", description: "One trip, watched and healed", amountPaise: 249900 },
  studio: { name: "Operator Studio", description: "One trip, run from the operator back office", amountPaise: 1699900 },
} as const;
type PlanId = keyof typeof PLANS;

const back = (origin: string, status: string) => NextResponse.redirect(`${origin}/subscription?checkout=${status}#checkout-status`, 303);

export async function POST(request: Request) {
  const origin = new URL(request.url).origin;
  const form = await request.formData();
  const planId = String(form.get("plan") ?? "") as PlanId;
  const plan = PLANS[planId];
  if (!plan) return back(origin, "unknown-plan");

  const key = process.env.STRIPE_SECRET_KEY || "";
  if (!key) return back(origin, "unconfigured");
  if (!key.startsWith("sk_test_")) return back(origin, "live-key-refused");

  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "inr",
    "line_items[0][price_data][unit_amount]": String(plan.amountPaise),
    "line_items[0][price_data][product_data][name]": plan.name,
    "line_items[0][price_data][product_data][description]": plan.description,
    "metadata[plan]": planId,
    success_url: `${origin}/subscription?checkout=success&plan=${planId}#checkout-status`,
    cancel_url: `${origin}/subscription?checkout=cancelled#checkout-status`,
  });

  try {
    const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const session = (await res.json()) as { url?: string; error?: { message?: string } };
    if (!res.ok || !session.url) {
      console.error("[checkout] Stripe refused the session:", session.error?.message ?? res.status);
      return back(origin, "stripe-error");
    }
    return NextResponse.redirect(session.url, 303);
  } catch (e) {
    console.error("[checkout] Stripe unreachable:", (e as Error).message);
    return back(origin, "stripe-error");
  }
}
