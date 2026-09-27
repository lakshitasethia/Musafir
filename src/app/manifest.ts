import type { MetadataRoute } from "next";

/**
 * Web app manifest: lets phones install Musafir from the browser ("Add to Home
 * Screen") and open it full-screen like an app. Offline support comes from the
 * existing service worker (/sw.js, registered by OfflineRegistrar).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Musafir — self-healing travel companion",
    short_name: "Musafir",
    description: "Plans your trip from real places and heals the day when plans break.",
    start_url: "/trip",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#fbf8f3",
    theme_color: "#3d2d20",
    categories: ["travel", "navigation"],
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "My trips", url: "/trip" },
      { name: "My dashboard", url: "/dashboard" },
      { name: "Taxi card", url: "/taxi" },
    ],
  };
}
