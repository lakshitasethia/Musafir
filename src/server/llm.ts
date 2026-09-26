/**
 * Thin LLM gateway: one JSON-mode chat call, validated with zod.
 * Groq first (OpenAI-compatible, JSON mode on all models), Gemini's
 * OpenAI-compatible endpoint as fallback. No SDK, no agent framework.
 *
 * Model ids are env-configurable because provider catalogs change; defaults are
 * from the providers' docs as of 2026-09. With no keys configured the call
 * returns { ok: false } and callers use their deterministic fallback — output is
 * never simulated.
 */
import type { z } from "zod";

export type LlmTier = "fast" | "deep";

interface Provider {
  id: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function providers(tier: LlmTier): Provider[] {
  const list: Provider[] = [];
  if (process.env.GROQ_API_KEY) {
    list.push({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model:
        tier === "fast"
          ? (process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b")
          : (process.env.GROQ_MODEL_DEEP || "openai/gpt-oss-120b"),
    });
  }
  if (process.env.GEMINI_API_KEY) {
    list.push({
      id: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
    });
  }
  return list;
}

export function llmConfigured(): boolean {
  return providers("fast").length > 0;
}

export type LlmResult<T> = { ok: true; value: T; via: string; ms: number } | { ok: false; reason: string };

export async function llmJson<T>(opts: {
  tier: LlmTier;
  system: string;
  user: string;
  schema: z.ZodType<T>;
  timeoutMs?: number;
}): Promise<LlmResult<T>> {
  const list = providers(opts.tier);
  if (list.length === 0) return { ok: false, reason: "no LLM key configured (GROQ_API_KEY / GEMINI_API_KEY)" };

  const failures: string[] = [];
  for (const p of list) {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
    try {
      const res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.apiKey}` },
        body: JSON.stringify({
          model: p.model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: opts.user },
          ],
        }),
      });
      if (!res.ok) {
        failures.push(`${p.id} HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        failures.push(`${p.id} empty response`);
        continue;
      }
      const parsed = opts.schema.safeParse(JSON.parse(content));
      if (!parsed.success) {
        failures.push(`${p.id} returned JSON that failed validation`);
        continue;
      }
      return { ok: true, value: parsed.data, via: `${p.id}/${p.model}`, ms: Date.now() - started };
    } catch (e) {
      failures.push(`${p.id} ${(e as Error).name === "AbortError" ? "timed out" : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: failures.join("; ") };
}
