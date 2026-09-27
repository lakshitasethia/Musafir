"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

const POLL_MS = 30_000;
const DEBOUNCE_MS = 300;

/**
 * Keeps a server-rendered page (the printable itinerary) in step with the trip:
 * any trip event re-renders it, and a 30 s poll covers servers where the event
 * stream can't reach this instance. Shows when it was last brought up to date.
 */
export function LiveRefresh({ tripId, version }: { tripId: string; version: number }) {
  const router = useRouter();
  const [updatedAt, setUpdatedAt] = useState<string>("");

  // Stamp the viewer's local time after each new render (not during SSR, whose
  // clock and time zone are the server's).
  useEffect(() => {
    const id = requestAnimationFrame(() =>
      setUpdatedAt(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
    );
    return () => cancelAnimationFrame(id);
  }, [version]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };
    const es = new EventSource(`/api/trips/${tripId}/events`);
    es.onmessage = refresh;
    const poll = setInterval(refresh, POLL_MS);
    return () => {
      es.close();
      clearInterval(poll);
      if (t) clearTimeout(t);
    };
  }, [tripId, router]);

  return (
    <p className="mz-print-live" suppressHydrationWarning>
      <i aria-hidden="true" /> Live itinerary{updatedAt ? ` · updated ${updatedAt}` : ""} · plan v{version}
    </p>
  );
}
