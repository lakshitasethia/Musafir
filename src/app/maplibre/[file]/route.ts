import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Serves MapLibre's module worker and its shared chunk from node_modules so the
 * worker's relative import resolves (webpack can't follow MapLibre's dynamic
 * `new URL(variable, import.meta.url)`). Whitelisted files only.
 */
const FILES = new Set(["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]);

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!FILES.has(file)) return new Response("Not found", { status: 404 });
  const body = await fs.readFile(path.join(process.cwd(), "node_modules", "maplibre-gl", "dist", file));
  return new Response(body, {
    headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" },
  });
}
