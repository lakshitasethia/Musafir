import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { z } from "zod";
import { llmJson } from "./llm.ts";

/** A stand-in for Nugen's /chat/completions, replying in its documented (OpenAI-shaped) format. */
async function fakeNugen(reply: string) {
  const seen: { auth?: string; body?: Record<string, unknown> } = {};
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.auth = req.headers.authorization;
    seen.body = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "c1", object: "chat.completion", model: seen.body?.model, choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

const Schema = z.object({ hazard: z.string(), severity: z.number() });

test("domain tasks go to the Nugen-aligned model; JSON is pulled out of chatty text", async () => {
  const fake = await fakeNugen('Sure! Here it is: {"hazard":"flood","severity":0.8} Hope that helps.');
  const saved = { ...process.env };
  try {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.NUGEN_API_KEY;
    process.env.NUGEN_API = "test-key";
    process.env.NUGEN_MODEL = "model_musafir_aligned";
    process.env.NUGEN_BASE_URL = fake.url;
    const r = await llmJson({ tier: "fast", domain: true, schema: Schema, system: "s", user: "u" });
    assert.ok(r.ok, !r.ok ? r.reason : "");
    assert.equal(r.via, "nugen/model_musafir_aligned");
    assert.deepEqual(r.value, { hazard: "flood", severity: 0.8 });
    assert.equal(fake.seen.auth, "Bearer test-key");
    assert.equal(fake.seen.body?.model, "model_musafir_aligned");
    assert.equal(fake.seen.body?.response_format, undefined, "Nugen has no JSON mode");

    // Non-domain tasks never use the domain model.
    const general = await llmJson({ tier: "fast", schema: Schema, system: "s", user: "u" });
    assert.equal(general.ok, false);
  } finally {
    process.env = saved;
    await fake.close();
  }
});

test("without NUGEN_MODEL the gateway doesn't pretend: no provider, clear reason", async () => {
  const saved = { ...process.env };
  try {
    delete process.env.GROQ_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.NUGEN_MODEL;
    process.env.NUGEN_API = "k";
    const r = await llmJson({ tier: "fast", domain: true, schema: Schema, system: "s", user: "u" });
    assert.equal(r.ok, false);
  } finally {
    process.env = saved;
  }
});
