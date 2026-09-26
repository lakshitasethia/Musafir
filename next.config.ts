import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // src/app/maplibre/[file]/route.ts reads MapLibre's worker files from node_modules at runtime.
  outputFileTracingIncludes: {
    "/maplibre/\\[file\\]": ["./node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs", "./node_modules/maplibre-gl/dist/maplibre-gl-shared.mjs"],
  },
};

export default nextConfig;
