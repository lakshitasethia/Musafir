import { NextResponse } from "next/server";
import { createGuest, getSessionUser, setSessionCookie } from "@/server/auth.ts";
import { HttpError } from "@/server/auth.ts";

/**
 * GET /api/auth/guest?next=/trip — starts a guest traveller session (no login
 * needed) and returns to `next`. Prefetches never create accounts.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("next") ?? "/trip";
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/trip";
  const prefetch = req.headers.get("next-router-prefetch") || /prefetch/i.test(req.headers.get("sec-purpose") ?? req.headers.get("purpose") ?? "");
  if (prefetch) return new Response(null, { status: 204 });
  if (!(await getSessionUser())) {
    try {
      const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || req.headers.get("x-real-ip") || "local";
      await setSessionCookie(await createGuest(ip));
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : "Couldn't start a session";
      return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, url));
    }
  }
  return NextResponse.redirect(new URL(next, url));
}
