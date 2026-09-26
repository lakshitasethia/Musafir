/**
 * Thin LLM gateway: one JSON chat call, validated with zod.
 * Groq first (OpenAI-compatible, JSON mode on all models), Gemini's
 * OpenAI-compatible endpoint as fallback. No SDK, no agent framework.
 *
 * Domain tasks (`domain: true` — weather-impact and social-signal reading for
 * the Digital Twin) go to Musafir's Nugen-aligned model first (NUGEN_API_KEY +
 * NUGEN_MODEL, produced by scripts/nugen-align.mjs), with Groq/Gemini behind it.
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
  /** Provider supports response_format json_object; otherwise JSON is extracted from the text. */
  jsonMode: boolean;
}

export function nugenProvider(): Provider | null {
  const apiKey = process.env.NUGEN_API_KEY || process.env.NUGEN_API;
  if (!apiKey || !process.env.NUGEN_MODEL) return null;
  return { id: "nugen", baseUrl: process.env.NUGEN_BASE_URL || "https://api.nugen.in/api/v3/inference", apiKey, model: process.env.NUGEN_MODEL, jsonMode: false };
}

function providers(tier: LlmTier, domain = false): Provider[] {
  const list: Provider[] = [];
  const nugen = nugenProvider();
  if (nugen && domain) list.push(nugen);
  if (process.env.GROQ_API_KEY) {
    list.push({
      id: "groq",
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: process.env.GROQ_API_KEY,
      model:
        tier === "fast"
          ? (process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b")
          : (process.env.GROQ_MODEL_DEEP || "openai/gpt-oss-120b"),
      jsonMode: true,
    });
  }
  if (process.env.GEMINI_API_KEY) {
    list.push({
      id: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-3.8-flash",
      jsonMode: true,
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
  /** Musafir-domain task: try the Nugen-aligned model first. */
  domain?: boolean;
}): Promise<LlmResult<T>> {
  const list = providers(opts.tier, opts.domain);
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
          ...(p.jsonMode ? { response_format: { type: "json_object" } } : { max_tokens: 700 }),
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
      const parsed = opts.schema.safeParse(parseJsonLoose(content));
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

/** JSON from a model reply: whole text, else the first {...} block (for providers without JSON mode). */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}
