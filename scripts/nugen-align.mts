/**
 * Nugen alignment (fine-tuning) for Musafir's domain model.
 *
 *   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts <step>
 *
 * Steps (state is kept in .data/nugen/state.json, so each step resumes):
 *   corpus   Build the domain dataset from Musafir's own data (no key needed):
 *            - real disruption cases from the store (Neo4j or file): situation → what
 *              the self-healing engine proposed → risk tier → what happened
 *            - the Digital Twin's weather-impact beliefs (cited classes, learned odds)
 *            - public social posts about weather in trip cities, labelled by the
 *              deterministic hazard rules
 *            - Wikivoyage Climate / Stay safe / Get around sections for trip destinations
 *            80% → corpus.jsonl (training document), 20% → benchmark.json (held out)
 *   upload   Upload the corpus; wait until READY; upload the held-out benchmark.
 *   align    Pick an alignment-ready base model (GET /models/base, or NUGEN_BASE_MODEL)
 *            and create the alignment project.
 *   status   Poll alignment status (progress, ETA, queue position, metrics when done).
 *   deploy   Deploy the aligned model (early=true if the run allows an early checkpoint).
 *   eval     Evaluate aligned vs base model on the held-out benchmark.
 *   try      One live inference call to the aligned model (prints the raw reply).
 *   all      corpus → upload → align, then poll every 60 s until done → deploy.
 *
 * Then put NUGEN_MODEL=<printed model id> in .env.local: Musafir's domain tasks
 * (social-signal reading for the twin) use it first, with Groq behind it.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import neo4j from "neo4j-driver";
import { GUST_CLASSES, HEAT_CLASSES, mean, priorModel, RAIN_CLASSES } from "../src/lib/musafir/twin.ts";

const BASE = "https://api.nugen.in";
const DIR = path.join(process.env.MUSAFIR_DATA_DIR || ".data", "nugen");
const STATE = path.join(DIR, "state.json");
const UA = `Musafir/0.1 (nugen alignment${process.env.OSM_CONTACT_EMAIL ? `; ${process.env.OSM_CONTACT_EMAIL}` : ""})`;
mkdirSync(DIR, { recursive: true });

type State = Partial<{ documentId: string; benchmarkId: string; alignmentId: string; baseModelId: string; modelId: string; evaluationId: string }>;
const state = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, "utf8")) : {});
const save = (s: State) => writeFileSync(STATE, JSON.stringify({ ...state(), ...s }, null, 2));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function key(): string {
  const k = process.env.NUGEN_API_KEY;
  if (!k) throw new Error("NUGEN_API_KEY is not set in .env.local (sign up at https://nugen.in/signup?invite=PILLAIUNIV2026, then create an API key)");
  return k;
}

async function api<T>(method: string, p: string, body?: unknown, form?: FormData): Promise<T> {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { Authorization: `Bearer ${key()}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

// ── corpus ───────────────────────────────────────────────────────────
interface QA {
  question: string;
  answer: string;
  kind: string;
}

interface StoredTrip {
  trip: { id: string; destination: string; schedule: { dayIndex: number; date: string; nodes: { id: string; title: string; isOutdoor: boolean; type: string; category: string; timeSlot: { start: string; durationMinutes: number }; location: { city: string } }[] }[] };
}
interface StoredProposal {
  tripId: string;
  dayIndex: number;
  status: string;
  headline: string;
  disruption: { kind: string; reason?: string; delayMinutes?: number; fromMinute?: number; toMinute?: number; nodeId?: string };
  affectedNodeIds: string[];
  options: { label: string; risk: { tier: string; reasons: string[] }; rankedBy?: string; rationale?: string }[];
  decidedBy?: string;
  appliedOptionId?: string;
}

async function loadStore(): Promise<{ trips: StoredTrip[]; proposals: StoredProposal[] }> {
  if (process.env.NEO4J_URI) {
    const driver = neo4j.driver(process.env.NEO4J_URI, neo4j.auth.basic(process.env.NEO4J_USERNAME ?? "", process.env.NEO4J_PASSWORD ?? ""));
    const session = driver.session({ database: process.env.NEO4J_DATABASE || undefined });
    try {
      const props = (await session.run("MATCH (p:Proposal) RETURN p.json AS j")).records.map((r) => JSON.parse(String(r.get("j"))) as StoredProposal);
      const rows = await session.run(
        "MATCH (t:Trip) OPTIONAL MATCH (t)-[:HAS_DAY]->(d:Day) OPTIONAL MATCH (d)-[:HAS_STOP]->(s:Stop) RETURN t.id AS id, t.destination AS dest, d.dayIndex AS di, d.date AS date, collect(s {.*}) AS stops",
      );
      const trips = new Map<string, StoredTrip>();
      for (const r of rows.records) {
        const id = String(r.get("id"));
        const t = trips.get(id) ?? { trip: { id, destination: String(r.get("dest")), schedule: [] } };
        if (r.get("di") !== null) {
          const stops = (r.get("stops") as Record<string, unknown>[]).map((s) => ({
            id: String(s.id),
            title: String(s.title),
            isOutdoor: Boolean(s.isOutdoor),
            type: String(s.type),
            category: String(s.category),
            timeSlot: { start: String(s.start ?? s.timeStart ?? "09:00"), durationMinutes: Number(s.durationMinutes ?? 60) },
            location: { city: String(s.city ?? "") },
          }));
          t.trip.schedule.push({ dayIndex: Number(r.get("di")), date: String(r.get("date")), nodes: stops });
        }
        trips.set(id, t);
      }
      return { trips: [...trips.values()], proposals: props };
    } finally {
      await session.close();
      await driver.close();
    }
  }
  const file = path.join(process.env.MUSAFIR_DATA_DIR || ".data", "musafir.json");
  const db = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { trips: [], proposals: [] };
  return { trips: db.trips, proposals: db.proposals };
}

function caseQA(p: StoredProposal, t: StoredTrip | undefined): QA | null {
  const day = t?.trip.schedule.find((d) => d.dayIndex === p.dayIndex);
  if (!day || p.options.length === 0) return null;
  const name = (id?: string) => day.nodes.find((n) => n.id === id)?.title ?? "a stop";
  const what =
    p.disruption.kind === "DELAY"
      ? `the traveller is running ${p.disruption.delayMinutes} minutes late for ${name(p.disruption.nodeId)}`
      : p.disruption.kind === "CLOSURE"
        ? `${name(p.disruption.nodeId)} is closed`
        : `rain is expected from ${String(Math.floor((p.disruption.fromMinute ?? 0) / 60)).padStart(2, "0")}:00 to ${String(Math.floor((p.disruption.toMinute ?? 0) / 60)).padStart(2, "0")}:00`;
  const plan = day.nodes.map((n) => `${n.timeSlot.start} ${n.title}${n.isOutdoor ? " (outdoor)" : ""}${n.type === "HARD" ? " [locked booking]" : ""}`).join("; ");
  const opts = p.options.map((o, i) => `${i + 1}) ${o.label} — ${o.risk.tier === "AUTO" ? "applied automatically" : o.risk.tier === "TRAVELLER" ? "traveller's call" : "needs operator approval"}${o.risk.reasons.length ? ` (${o.risk.reasons.join("; ")})` : ""}`);
  const outcome = p.status === "AUTO_APPLIED" ? "It was fixed automatically." : p.status === "APPLIED" ? `It was applied by ${p.decidedBy ?? "the traveller"}.` : p.status === "DISMISSED" ? "The traveller dismissed it." : `Status: ${p.status.toLowerCase()}.`;
  return {
    kind: "disruption-case",
    question: `Musafir trip in ${t!.trip.destination}, day ${p.dayIndex} (${day.date}). Plan: ${plan}. Now ${what}. What does Musafir do?`,
    answer: `${p.headline}. ${opts.join(" ")} ${outcome}`.trim(),
  };
}

function weatherQA(): QA[] {
  const m = priorModel();
  const pct = (k: keyof typeof m) => Math.round(mean(m[k]) * 100);
  return [
    ...RAIN_CLASSES.map((c) => ({
      kind: "weather-impact",
      question: `In Musafir's weather twin, how likely is an outdoor visit to be disrupted in ${c.label} rain?`,
      answer: `About ${pct(c.key)}% before local evidence (AMS/WMO rain-rate class "${c.label}"). Musafir updates this with every observed visit; indoor visits are unaffected except by slower roads (+3% travel time per mm/h, capped at +60%).`,
    })),
    ...HEAT_CLASSES.map((c) => ({
      kind: "weather-impact",
      question: `How does Musafir treat outdoor visits when the feels-like temperature is in the NWS ${c.label} band?`,
      answer: `It estimates about a ${pct(c.key)}% chance the visit is cut short or moved, schedules rest breaks, and prefers moving outdoor stops to cooler hours before dropping them.`,
    })),
    ...GUST_CLASSES.map((c) => ({
      kind: "weather-impact",
      question: `What happens to viewpoints and other outdoor stops with ${c.label}?`,
      answer: `Musafir estimates about a ${pct(c.key)}% chance of closure or an unsafe visit and offers an indoor swap nearby from real open data.`,
    })),
    {
      kind: "weather-impact",
      question: "How does Musafir decide who approves a weather-driven change?",
      answer:
        "Small shifts of flexible stops within the traveller's limits apply automatically (AUTO). Drops, swaps and bigger shifts become a one-tap card for the traveller. Anything touching a locked booking, extra cost above the limit, or a booking conflict goes to the operator, with a deadline.",
    },
  ];
}

const HAZARD_RULES: [RegExp, string][] = [
  [/\b(flood\w*|waterlog\w*|inundat\w*|submerged)\b/i, "flood"],
  [/\b(cyclone|typhoon|hurricane|thunderstorm|storm)\b/i, "storm"],
  [/\b(heat ?wave|heatstroke|scorching|hottest)\b/i, "heat"],
  [/\b(rain\w*|downpour|showers?|monsoon)\b/i, "rain"],
];

async function socialQA(cities: string[]): Promise<QA[]> {
  const out: QA[] = [];
  for (const city of cities.slice(0, 8)) {
    const slug = city.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const tag of [`${slug}rain`, `${slug}rains`, `${slug}weather`, slug]) {
      const posts = (await fetch(`https://mastodon.social/api/v1/timelines/tag/${tag}?limit=20`, { headers: { "User-Agent": UA } })
        .then((r) => (r.ok ? r.json() : []))
        .catch(() => [])) as { content: string; language?: string }[];
      for (const p of posts) {
        if (p.language && p.language !== "en") continue;
        const text = p.content.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim().slice(0, 240);
        const hit = HAZARD_RULES.find(([re]) => re.test(text));
        if (!hit || text.length < 30) continue;
        const severe = /\b(red alert|evacuat\w*|record|extreme|severe|stranded|submerged)\b/i.test(text);
        out.push({
          kind: "social-signal",
          question: `Classify this public post about conditions in ${city} for travellers (hazard: rain, flood, storm, heat, wind, closure, traffic or none; severity 0-1): "${text}"`,
          answer: JSON.stringify({ hazard: hit[1], severity: severe ? 0.85 : 0.45 }),
        });
      }
    }
  }
  return out;
}

async function guideQA(destinations: string[]): Promise<QA[]> {
  const out: QA[] = [];
  for (const d of destinations.slice(0, 15)) {
    const api = (params: Record<string, string>) =>
      fetch(`https://en.wikivoyage.org/w/api.php?${new URLSearchParams({ format: "json", formatversion: "2", redirects: "1", ...params })}`, { headers: { "User-Agent": UA } }).then((r) => r.json());
    const secs = ((await api({ action: "parse", page: d, prop: "sections" }).catch(() => null)) as { parse?: { sections?: { line: string; index: string }[] } } | null)?.parse?.sections ?? [];
    for (const want of ["Climate", "Stay safe", "Get around"]) {
      const sec = secs.find((s) => s.line.trim().toLowerCase() === want.toLowerCase());
      if (!sec) continue;
      const wt = ((await api({ action: "parse", page: d, section: sec.index, prop: "wikitext" }).catch(() => null)) as { parse?: { wikitext?: string } } | null)?.parse?.wikitext ?? "";
      const text = wt
        .replace(/\{\{[^}]*\}\}/g, "")
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
        .replace(/'{2,}/g, "")
        .replace(/^=+.*=+$/gm, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1200);
      if (text.length < 80) continue;
      out.push({ kind: "destination-guide", question: `${want} in ${d}: what should a traveller know?`, answer: `${text} (Source: Wikivoyage, "${d}", CC BY-SA.)` });
    }
  }
  return out;
}

async function corpus() {
  const { trips, proposals } = await loadStore();
  const byId = new Map(trips.map((t) => [t.trip.id, t]));
  const cases = proposals.map((p) => caseQA(p, byId.get(p.tripId))).filter((x): x is QA => x !== null);
  const cities = [...new Set(trips.flatMap((t) => t.trip.schedule.flatMap((d) => d.nodes.map((n) => n.location.city))).filter((c) => c && c !== "undefined"))];
  const destinations = [...new Set([...trips.map((t) => t.trip.destination), ...cities])];
  const [social, guides] = [await socialQA(cities), await guideQA(destinations)];
  const all = [...cases, ...weatherQA(), ...social, ...guides];
  // Deterministic 80/20 split per kind so every kind appears in both.
  const train: QA[] = [];
  const held: QA[] = [];
  const kinds = [...new Set(all.map((q) => q.kind))];
  for (const k of kinds) all.filter((q) => q.kind === k).forEach((q, i) => ((i + 1) % 5 === 0 ? held : train).push(q));
  writeFileSync(path.join(DIR, "corpus.jsonl"), train.map((q) => JSON.stringify({ question: q.question, answer: q.answer })).join("\n") + "\n");
  writeFileSync(path.join(DIR, "benchmark.json"), JSON.stringify(held.map((q, i) => ({ sample_num: i + 1, instruction: q.question, response: q.answer })), null, 2));
  const count = (xs: QA[]) => Object.fromEntries(kinds.map((k) => [k, xs.filter((q) => q.kind === k).length]));
  console.log(`corpus: ${train.length} training records ${JSON.stringify(count(train))}`);
  console.log(`benchmark (held out): ${held.length} ${JSON.stringify(count(held))}`);
  console.log(`written to ${DIR}`);
}

// ── Nugen workflow ───────────────────────────────────────────────────
async function upload() {
  const f = path.join(DIR, "corpus.jsonl");
  if (!existsSync(f)) throw new Error("run the corpus step first");
  const form = new FormData();
  form.append("files", new Blob([readFileSync(f)], { type: "application/json" }), "musafir-weather-ops.jsonl");
  form.append("categories", "travel-weather-operations");
  form.append("names", "Musafir weather & disruption operations");
  const { document_ids } = await api<{ document_ids: string[] }>("POST", "/api/v3/documents/create", undefined, form);
  const documentId = document_ids[0];
  save({ documentId });
  console.log("document", documentId, "— waiting for READY…");
  for (;;) {
    const s = await api<{ status: string; progress?: number | null }>("GET", `/api/v3/documents/${documentId}/status`);
    if (s.status === "READY") break;
    if (s.status === "FAILED") throw new Error("document processing FAILED");
    process.stdout.write(`  ${s.status} ${s.progress ?? ""}\r`);
    await sleep(5000);
  }
  const bench = new FormData();
  bench.append("file", new Blob([readFileSync(path.join(DIR, "benchmark.json"))], { type: "application/json" }), "musafir-benchmark.json");
  bench.append("name", "Musafir held-out weather-ops benchmark");
  bench.append("document_id", documentId);
  bench.append("description", "20% of Musafir's real disruption cases, twin beliefs, social labels and guides, held out from training");
  const b = await api<{ benchmark_id: string; n_samples: number }>("POST", "/api/v3/benchmarks/upload", undefined, bench);
  save({ benchmarkId: b.benchmark_id });
  console.log(`benchmark ${b.benchmark_id} (${b.n_samples} samples)`);
}

async function align() {
  const s = state();
  if (!s.documentId) throw new Error("run the upload step first");
  const { models } = await api<{ models: { model_id: string; model_name: string; parameters: string; alignment_ready: boolean; type: string }[] }>("GET", "/api/v3/models/base?limit=100");
  const ready = models.filter((m) => m.alignment_ready && !/vision|embed|rerank/i.test(`${m.type} ${m.model_name}`));
  console.log("alignment-ready base models:", ready.map((m) => `${m.model_id} (${m.parameters})`).join(", "));
  const pick = process.env.NUGEN_BASE_MODEL ? ready.find((m) => m.model_id === process.env.NUGEN_BASE_MODEL) : ready.find((m) => /instruct|reasoning/i.test(m.model_id)) ?? ready[0];
  if (!pick) throw new Error("no alignment-ready base model available to this key");
  const r = await api<{ alignment_id: string; status: string }>("POST", "/api/v3/alignment-projects/create", {
    alignment_name: "Musafir weather-disruption tour manager",
    base_model_id: pick.model_id,
    document_ids: [s.documentId],
    ...(s.benchmarkId ? { benchmark_id: s.benchmarkId } : {}),
    description: "Reads weather/social signals and explains Musafir's self-healing decisions for travellers and operators.",
  });
  save({ alignmentId: r.alignment_id, baseModelId: pick.model_id });
  console.log(`alignment ${r.alignment_id} on ${pick.model_id}: ${r.status}`);
}

async function status(): Promise<string> {
  const s = state();
  if (!s.alignmentId) throw new Error("run the align step first");
  const st = await api<{ status: string; progress: number | null; eta_seconds: number | null; queue_position: number | null; early_deployable: boolean }>("GET", `/api/v3/alignment-projects/${s.alignmentId}/status`);
  console.log(`status ${st.status} · progress ${st.progress ?? "-"} · ETA ${st.eta_seconds ?? "-"} s · queue ${st.queue_position ?? "-"} · early-deployable ${st.early_deployable}`);
  if (["READY", "EVALUATED", "UNDEPLOYED", "DEPLOYING"].includes(st.status) || st.early_deployable) {
    const d = await api<{ model_id: string | null; performance_metrics: Record<string, number> | null; error: string | null }>("GET", `/api/v3/alignment-projects/${s.alignmentId}`);
    if (d.model_id) save({ modelId: d.model_id });
    if (d.performance_metrics) console.log("metrics:", JSON.stringify(d.performance_metrics));
    if (d.error) console.log("error:", d.error);
    if (d.model_id) console.log(`model id: ${d.model_id}`);
  }
  return st.status;
}

async function deploy() {
  const s = state();
  if (!s.modelId) await status();
  const modelId = state().modelId;
  if (!modelId) throw new Error("no aligned model id yet — wait for the alignment to finish (step: status)");
  try {
    await api("POST", `/api/v3/models/${modelId}/deployment`);
  } catch (e) {
    if (/HTTP 409/.test((e as Error).message)) await api("POST", `/api/v3/models/${modelId}/deployment?early=true`);
    else if (!/HTTP 400/.test((e as Error).message)) throw e; // 400 = already deployed
  }
  for (;;) {
    const d = await api<{ status: string; error: string | null }>("GET", `/api/v3/models/${modelId}/deployment/status`);
    console.log(`deployment ${d.status}${d.error ? ` (${d.error})` : ""}`);
    if (d.status === "DEPLOYED") break;
    if (d.error) throw new Error(d.error);
    await sleep(10_000);
  }
  console.log(`\nAdd to .env.local:\nNUGEN_MODEL=${modelId}`);
}

async function evaluate() {
  const s = state();
  if (!s.modelId || !s.benchmarkId) throw new Error("need a deployed model and the uploaded benchmark");
  if (!s.evaluationId) {
    const e = await api<{ evaluation_id: string }>("POST", "/api/v3/evaluations/create", {
      model_id: s.modelId,
      benchmark_id: s.benchmarkId,
      baseline_model_id: s.baseModelId,
      evaluation_name: "Musafir aligned vs base",
    });
    save({ evaluationId: e.evaluation_id });
  }
  const id = state().evaluationId!;
  for (;;) {
    const st = await api<{ status: string }>("GET", `/api/v3/evaluations/${id}/status`);
    console.log(`evaluation ${st.status}`);
    if (/COMPLETED|EVALUATED|READY|DONE/i.test(st.status)) break;
    if (/FAIL/i.test(st.status)) throw new Error("evaluation failed");
    await sleep(15_000);
  }
  const r = await api<unknown>("GET", `/api/v3/evaluations/${id}/results`);
  writeFileSync(path.join(DIR, "evaluation.json"), JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2).slice(0, 3000));
}

async function tryIt() {
  const model = process.env.NUGEN_MODEL || state().modelId;
  if (!model) throw new Error("no model id");
  const r = await api<unknown>("POST", "/api/v3/inference/chat/completions", {
    model,
    messages: [
      { role: "system", content: "You are Musafir's weather operations model. Reply as JSON." },
      { role: "user", content: 'Classify for travellers in Mumbai: "Local trains suspended, Andheri subway waterlogged after 180 mm overnight". JSON {"hazard","severity"}' },
    ],
    max_tokens: 200,
    temperature: 0,
  });
  console.log(JSON.stringify(r, null, 2));
}

const step = process.argv[2] ?? "corpus";
const steps: Record<string, () => Promise<unknown>> = {
  corpus,
  upload,
  align,
  status,
  deploy,
  eval: evaluate,
  try: tryIt,
  all: async () => {
    await corpus();
    await upload();
    await align();
    for (;;) {
      const st = await status();
      if (["READY", "EVALUATED", "UNDEPLOYED"].includes(st) || st === "DEPLOYING") break;
      if (["FAILED", "STOPPED"].includes(st)) throw new Error(`alignment ${st}`);
      await sleep(60_000);
    }
    await deploy();
  },
};
if (!steps[step]) {
  console.error(`unknown step "${step}". Steps: ${Object.keys(steps).join(", ")}`);
  process.exit(1);
}
steps[step]()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
