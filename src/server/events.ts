/**
 * In-process event bus for Server-Sent Events. One emitter per server process
 * (on globalThis so hot reload doesn't orphan listeners). Multi-instance
 * deployments need a shared channel (e.g. Supabase Realtime) instead.
 */
import { EventEmitter } from "node:events";

export type MusafirEvent =
  | { type: "trip.updated"; tripId: string; version: number }
  | { type: "proposal.changed"; tripId: string; proposalId: string }
  | { type: "activity"; tripId: string; message: string }
  | { type: "room.changed"; tripId: string; roomId: string };

const g = globalThis as typeof globalThis & { __musafirBus?: EventEmitter };
const bus = (g.__musafirBus ??= (() => {
  const e = new EventEmitter();
  e.setMaxListeners(0);
  return e;
})());

/** Every event also goes to the "ops" channel so operator consoles see all trips. */
export function publish(event: MusafirEvent) {
  if (event.type === "room.changed") bus.emit(`room:${event.roomId}`, event);
  bus.emit(`trip:${event.tripId}`, event);
  bus.emit("ops", event);
}

export function subscribe(channel: string, fn: (e: MusafirEvent) => void): () => void {
  bus.on(channel, fn);
  return () => bus.off(channel, fn);
}

const HEARTBEAT_MS = 20_000;

/** SSE response for a channel; cleans up on client disconnect. */
export function sseResponse(request: Request, channel: string): Response {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          cleanup();
        }
      };
      send(`retry: 3000\n: connected\n\n`);
      const unsubscribe = subscribe(channel, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      request.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
