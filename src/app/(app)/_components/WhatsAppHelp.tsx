"use client";

/**
 * Floating "On-ground help" button for travellers: opens a WhatsApp chat with
 * Musafir's assistant, pre-filled with the trip they're looking at, so help
 * starts with context (nearby places, delays, closures, rain, getting back).
 */
import { usePathname } from "next/navigation";

export function WhatsAppHelp({ number, name }: { number: string; name?: string }) {
  const path = usePathname();
  const trip = /^\/trip\/([0-9a-f-]{36})/.exec(path ?? "")?.[1];
  const text = trip ? `Hi Musafir, I need help on my trip (ref ${trip.slice(0, 8)}).` : "Hi Musafir, I need help on the ground.";
  const href = `https://wa.me/${number}?text=${encodeURIComponent(text)}`;
  return (
    <a className="mz-wa-help" href={href} target="_blank" rel="noopener noreferrer" aria-label={`On-ground help on WhatsApp${name ? ` with ${name}` : ""}`}>
      <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true">
        <path
          fill="currentColor"
          d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 7L3 29l6.4-2c2 1.1 4.3 1.7 6.6 1.7 7.2 0 13-5.7 13-12.8S23.2 3 16 3zm0 23.4c-2.1 0-4.1-.6-5.9-1.7l-.4-.2-3.8 1.2 1.2-3.7-.3-.4c-1.2-1.8-1.8-3.8-1.8-5.9C5 10 9.9 5.2 16 5.2S27 10 27 15.8s-4.9 10.6-11 10.6zm6-7.9c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2-.2.3-.8 1-1 1.2-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.3.3-.6.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.8s1.2 3.2 1.4 3.5c.2.2 2.4 3.7 5.8 5.1 2.9 1.1 3.4.9 4 .8.6-.1 1.9-.8 2.2-1.5.3-.8.3-1.4.2-1.5-.1-.2-.3-.3-.6-.4z"
        />
      </svg>
      <span>
        <strong>On-ground help</strong>
        <em>WhatsApp · replies 24/7</em>
      </span>
    </a>
  );
}
