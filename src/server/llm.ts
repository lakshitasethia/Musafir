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
  // Groq's free tier allows ~8k tokens per minute per key, so every configured key is used in turn:
  // a key that answers 429 is skipped until its minute resets.
  const groqKeys = [...new Set([process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, ...(process.env.GROQ_API_KEYS ?? "").split(",")].map((k) => k?.trim()).filter((k): k is string => !!k))];
  const fastModel = process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";
  const deepModel = process.env.GROQ_MODEL_DEEP || "openai/gpt-oss-120b";
  const groq = (apiKey: string, model: string): Provider => ({ id: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKey, model, jsonMode: true });
  const usable = groqKeys.filter((k) => (limitedUntil.get(k) ?? 0) < Date.now());
  const keys = usable.length ? usable : groqKeys;
  for (const k of keys) list.push(groq(k, tier === "fast" ? fastModel : deepModel));
  // JSON mode occasionally rejects a generation (400) or returns a wrong shape: one retry on the larger model.
  if (tier === "fast") for (const k of keys) list.push(groq(k, deepModel));
  if (process.env.GEMINI_API_KEY) {
    // Google retires model ids for new keys (404 "not available to new users"): try the configured one, then current ones.
    for (const model of [...new Set([process.env.GEMINI_MODEL, "gemini-3.5-flash", "gemini-flash-latest"].filter((m): m is string => !!m))]) {
      if ((goneModels.get(model) ?? 0) > Date.now()) continue;
      list.push({ id: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: process.env.GEMINI_API_KEY, model, jsonMode: true });
    }
  }
  return list;
}

/** Groq keys that answered 429, until their per-minute window resets; Gemini models that answered 404. */
const g = globalThis as typeof globalThis & { __musafirLlmLimits?: { keys: Map<string, number>; models: Map<string, number> } };
const limits = (g.__musafirLlmLimits ??= { keys: new Map(), models: new Map() });
const limitedUntil = limits.keys;
const goneModels = limits.models;

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
        if (res.status === 429 && p.id === "groq") {
          // Per-minute token budget used up on this key: rest it until Groq says it resets.
          const wait = Number(res.headers.get("retry-after")) || 60;
          limitedUntil.set(p.apiKey, Date.now() + Math.min(120, wait) * 1000);
        }
        if (res.status === 404 && p.id === "gemini") goneModels.set(p.model, Date.now() + 6 * 3600_000);
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
      if (failures.length) console.warn(`[llm] answered by ${p.id} after: ${failures.join("; ")}`);
      return { ok: true, value: parsed.data, via: `${p.id}/${p.model}`, ms: Date.now() - started };
    } catch (e) {
      failures.push(`${p.id} ${(e as Error).name === "AbortError" ? "timed out" : (e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: failures.join("; ") };
}

/**
 * JSON from a model reply: whole text, else the first {...} block (for providers without JSON mode).
 * Unparseable → the raw text, so a schema that preprocesses can salvage it (plain schemas still reject a string).
 */
function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return text;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return text;
    }
  }
}
