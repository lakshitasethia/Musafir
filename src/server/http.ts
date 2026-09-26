import { z } from "zod";
import { HttpError } from "./auth.ts";

/** Wraps a route handler: maps thrown errors to JSON responses. */
export function handle<C = unknown>(fn: (req: Request, ctx: C) => Promise<Response | unknown>) {
  return async (req: Request, ctx: C): Promise<Response> => {
    try {
      const out = await fn(req, ctx);
      return out instanceof Response ? out : Response.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof z.ZodError) {
        return Response.json(
          { error: e.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ") },
          { status: 422 },
        );
      }
      console.error("[musafir]", e);
      return Response.json({ error: "Something went wrong on our side" }, { status: 500 });
    }
  };
}

export async function body<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  return schema.parse(raw);
}

export type IdCtx = { params: Promise<{ id: string }> };
export type DayCtx = { params: Promise<{ id: string; dayIndex: string }> };

export function dayIndexOf(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, "Invalid day");
  return n;
}
