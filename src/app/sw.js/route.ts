/**
 * Service worker served from a route (public/ belongs to the UI owner).
 * Scope "/": caches the Taxi Rescue shell (/taxi) and Next's hashed static
 * assets so the card opens with zero signal. Trip data comes from IndexedDB,
 * not from here. Registered only in production (see OfflineRegistrar).
 */
const VERSION = "musafir-v1";

const SW_SOURCE = `
const CACHE = ${JSON.stringify(VERSION)};
const SHELL = ["/taxi"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("musafir") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Taxi card shell: network first, cached copy when offline.
  if (req.mode === "navigate" && url.pathname === "/taxi") {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("/taxi", copy));
          return res;
        })
        .catch(() => caches.match("/taxi")),
    );
    return;
  }

  // Hashed build assets never change: cache first.
  if (url.pathname.startsWith("/_next/static/")) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});
`;

export function GET() {
  return new Response(SW_SOURCE, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
