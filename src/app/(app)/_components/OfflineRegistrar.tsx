"use client";

import Link from "next/link";
import { useEffect } from "react";

/**
 * Registers the service worker in production only (in dev it would cache HMR
 * chunks and break everyone's dev server). The hidden prefetch link makes the
 * browser fetch the /taxi route's JS while online, so the SW can cache it.
 */
export function OfflineRegistrar() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return <Link href="/taxi" prefetch aria-hidden="true" tabIndex={-1} style={{ display: "none" }} />;
}
