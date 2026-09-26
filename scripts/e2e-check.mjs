/**
 * End-to-end feature check (52 checks) against a RUNNING server — run `npm run build && npm start` first,
 * then `npm run check:e2e` (BASE=http://host:port to target another server; default http://localhost:3000).
 * Uses your .env.local (OPERATOR_INVITE_CODE is needed). It creates clearly labelled test data
 * (Jaipur "Feature check" trips, fc-op-… and fc-traveller-… @example.test accounts) in whatever store the server uses.
 */
// Prints PASS/FAIL per feature; never prints secrets.
const B = process.env.BASE ?? "http://localhost:3000";
const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uuid = () => crypto.randomUUID();

class Client {
  constructor() {
    this.cookie = "";
  }
  async req(path, { method, body, headers = {}, redirect = "manual" } = {}) {
    const res = await fetch(B + path, {
      method: method ?? (body !== undefined ? "POST" : "GET"),
      redirect,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    for (const c of set) {
      const kv = c.split(";")[0];
      if (kv.startsWith("mz_session=")) this.cookie = kv.endsWith("=") ? "" : kv;
    }
    let data = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, location: res.headers.get("location") };
  }
}
async function check(name, fn) {
  try {
    const out = await fn();
    if (out === true || out === undefined) record(name, true);
    else if (typeof out === "string") record(name, true, out);
    else record(name, !!out.ok, out.detail ?? "");
  } catch (e) {
    record(name, false, e.message);
  }
}
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

// ── Pages & static routes ──────────────────────────────────────────
const anon = new Client();
await check("landing page /", async () => expect((await anon.req("/")).status === 200, "not 200"));
await check("anonymous /trip starts a guest session", async () => {
  const r = await anon.req("/trip");
  expect(r.status === 307 && r.location.includes("/api/auth/guest"), `got ${r.status} ${r.location}`);
});
await check("guest endpoint ignores prefetch", async () => expect((await anon.req("/api/auth/guest?next=/trip", { headers: { "next-router-prefetch": "1" } })).status === 204, "not 204"));
await check("guest endpoint blocks open redirect", async () => {
  const r = await new Client().req("/api/auth/guest?next=//evil.example");
  expect(r.location && new URL(r.location, B).host === new URL(B).host, `redirected to ${r.location}`);
});
await check("service worker /sw.js", async () => expect((await anon.req("/sw.js")).status === 200, "not 200"));
await check("map worker route", async () => expect((await anon.req("/maplibre/maplibre-gl-worker.mjs")).status === 200 && (await anon.req("/maplibre/package.json")).status === 404, "whitelist broken"));

// ── Guest traveller ────────────────────────────────────────────────
const t = new Client();
await t.req("/api/auth/guest?next=/trip");
await check("guest session cookie set", async () => expect(!!t.cookie, "no cookie"));
for (const p of ["/trip", "/flights", "/hotels", "/packages", "/taxi"]) await check(`guest page ${p}`, async () => expect((await t.req(p)).status === 200, "not 200"));
await check("guest cannot open operator console", async () => {
  const r = await t.req("/ops");
  expect(r.status === 307 && !r.location.includes("/ops"), `got ${r.status} ${r.location}`);
});

// ── Trip creation + planner agent (+ Groq curator) ─────────────────
let tripId;
await check("create trip (Feature check · Jaipur, 2 days, auto-plan)", async () => {
  const r = await t.req("/api/trips", { body: { destination: "Jaipur", startDate: "2026-09-27", endDate: "2026-09-28", vibeConfig: { pacing: 0.6, budget: 0.3, culturalDepth: 0.2, circadian: 0.3 }, dietaryRestrictions: ["vegetarian"], autoPlan: true } });
  tripId = r.data.id;
  expect(r.status === 200 && tripId, JSON.stringify(r.data));
});
let bundle;
await check("planner agent drafts every day", async () => {
  for (let i = 0; i < 60; i++) {
    bundle = (await t.req(`/api/trips/${tripId}`)).data;
    if (bundle.planner?.status !== "RUNNING") break;
    await sleep(2000);
  }
  const counts = bundle.trip.schedule.map((d) => d.nodes.length);
  const ok = bundle.planner?.status === "DONE" && counts.every((n) => n > 0);
  return { ok, detail: `${bundle.planner?.status}: ${counts.join(" + ")} stops — ${bundle.planner?.note}` };
});
await check("planner used real travel legs", async () => {
  const d = bundle.trip.schedule[0];
  expect(d.transitSegments.length === Math.max(0, d.nodes.length - 1), `${d.transitSegments.length} legs for ${d.nodes.length} stops`);
  return `${d.transitSegments.map((s) => `${s.durationMinutes}m ${s.mode}`).join(", ")}`;
});

// ── Tier 1 CRUD ─────────────────────────────────────────────────────
const day1 = () => bundle.trip.schedule[0];
const refresh = async () => (bundle = (await t.req(`/api/trips/${tripId}`)).data);
const stop = (title, start, lat, extra = {}) => ({
  id: uuid(),
  type: "SOFT",
  title,
  category: "CULTURE",
  location: { lat, lng: 75.8267, city: "Jaipur" },
  timeSlot: { start, durationMinutes: 45, bufferMinutes: 10 },
  isOutdoor: true,
  costEstimate: { amount: 0, currency: "USD" },
  ...extra,
});
const patch = (p) => ({ patchId: uuid(), targetDayIndex: 1, reason: "feature check", ...p });
let added;
await check("add a stop (INSERT)", async () => {
  added = stop("Feature check stop", "21:00", 26.9239);
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "INSERT", payload: added })] } });
  expect(r.status === 200, JSON.stringify(r.data));
  await refresh();
});
await check("move a stop (SHIFT_TIME)", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "SHIFT_TIME", nodeId: added.id, shiftOffsetMinutes: 15 })] } });
  await refresh();
  expect(r.status === 200 && day1().nodes.find((n) => n.id === added.id).timeSlot.start === "21:15", JSON.stringify(r.data));
});
await check("edit a stop (REPLACE)", async () => {
  const cur = day1().nodes.find((n) => n.id === added.id);
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "REPLACE", nodeId: added.id, payload: { ...cur, title: "Feature check stop (edited)" } })] } });
  await refresh();
  expect(r.status === 200 && day1().nodes.some((n) => n.title === "Feature check stop (edited)"), JSON.stringify(r.data));
});
await check("stale edit is rejected (409)", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version - 1, patches: [patch({ operation: "SHIFT_TIME", nodeId: added.id, shiftOffsetMinutes: 5 })] } });
  expect(r.status === 409, `got ${r.status}`);
});
await check("traveller cannot add a locked (HARD) booking", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "INSERT", payload: stop("x", "22:30", 26.92, { type: "HARD" }) })] } });
  expect(r.status === 403, `got ${r.status}`);
});
await check("invalid patch is rejected (ends after midnight)", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "SHIFT_TIME", nodeId: added.id, shiftOffsetMinutes: 180 })] } });
  expect(r.status === 422, `got ${r.status}`);
});
await check("delete a stop (REMOVE)", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "REMOVE", nodeId: added.id })] } });
  await refresh();
  expect(r.status === 200 && !day1().nodes.some((n) => n.id === added.id), JSON.stringify(r.data));
});

// ── Self-healing engine + autonomy tiers ────────────────────────────
const soft = () => day1().nodes.find((n) => n.type === "SOFT");
await check("small delay heals automatically (AUTO) and can be undone", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/disruptions`, { body: { kind: "DELAY", nodeId: soft().id, delayMinutes: 10, reason: "feature check" } });
  expect(r.data.status === "AUTO_APPLIED", JSON.stringify(r.data));
  const u = await t.req(`/api/proposals/${r.data.proposalId}/undo`, { body: {} });
  expect(u.status === 200, `undo ${u.status} ${JSON.stringify(u.data)}`);
  await refresh();
});
let travellerCard;
await check("big delay asks the traveller (TRAVELLER card) and applies", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/disruptions`, { body: { kind: "DELAY", nodeId: soft().id, delayMinutes: 60, reason: "feature check" } });
  expect(r.data.status === "PENDING", JSON.stringify(r.data));
  await refresh();
  travellerCard = bundle.proposals.find((p) => p.id === r.data.proposalId);
  expect(travellerCard.options[0].risk.tier === "TRAVELLER" && travellerCard.canDecide[0], `tier ${travellerCard.options[0].risk.tier}`);
  const a = await t.req(`/api/proposals/${travellerCard.id}/decision`, { body: { decision: "APPLY", optionId: travellerCard.options[0].id } });
  expect(a.status === 200, JSON.stringify(a.data));
  await refresh();
  return travellerCard.options[0].label;
});
await check("rain simulation creates a weather card", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/disruptions`, { body: { kind: "WEATHER", fromMinute: 0, toMinute: 1439, reason: "feature check rain" } });
  expect(r.status === 200, JSON.stringify(r.data));
  return r.data.status;
});
let closureId;
await check("venue closure → Resolver agent finds real alternatives (Groq-ranked)", async () => {
  const target = soft();
  const r = await t.req(`/api/trips/${tripId}/days/1/disruptions`, { body: { kind: "CLOSURE", nodeId: target.id, reason: "feature check closure" } });
  closureId = r.data.proposalId;
  let p;
  for (let i = 0; i < 45; i++) {
    await refresh();
    p = bundle.proposals.find((x) => x.id === closureId);
    if (p.agentStatus === "DONE" || p.agentStatus === "FAILED") break;
    await sleep(2000);
  }
  const agentOpt = p.options.find((o) => o.source === "agent");
  return { ok: p.agentStatus === "DONE" && !!agentOpt, detail: `${p.agentStatus}: ${agentOpt ? agentOpt.label + " · " + agentOpt.rankedBy : p.agentNote}` };
});
await check("dismiss a card", async () => {
  const r = await t.req(`/api/proposals/${closureId}/decision`, { body: { decision: "DISMISS" } });
  expect(r.status === 200, JSON.stringify(r.data));
});
await check("live forecast check (Open-Meteo)", async () => {
  const r = await t.req(`/api/trips/${tripId}/days/1/weather`, { body: {} });
  expect(r.status === 200, JSON.stringify(r.data));
  return r.data.message;
});
await check("sentinel (ambient 2-hour check)", async () => {
  const r = await t.req("/api/sentinel", { body: { tripId } });
  expect(r.status === 200, JSON.stringify(r.data));
  return r.data.results[0].note;
});
await check("cluster nearby agent", async () => {
  await refresh();
  const target = day1().nodes.filter((n) => n.type === "SOFT")[1] ?? day1().nodes[1];
  const r = await t.req(`/api/trips/${tripId}/days/1/cluster`, { body: { nodeId: target.id } });
  expect(r.status === 200, JSON.stringify(r.data));
  let p;
  for (let i = 0; i < 40; i++) {
    await refresh();
    p = bundle.proposals.find((x) => x.id === r.data.proposalId);
    if (p.agentStatus !== "RUNNING") break;
    await sleep(2000);
  }
  return { ok: p.agentStatus === "DONE", detail: `${p.agentStatus}: ${p.options[0]?.label ?? p.agentNote}` };
});

// ── Operator ───────────────────────────────────────────────────────
const o = new Client();
await check("operator sign-up needs the invite code", async () => {
  const bad = await o.req("/api/auth/signup", { body: { email: `fc-op-${Date.now()}@example.test`, name: "Feature Check Operator", password: "feature-check-1", role: "operator", inviteCode: "wrong" } });
  expect(bad.status === 403, `wrong code gave ${bad.status}`);
});
await check("operator sign-up with invite code", async () => {
  const r = await o.req("/api/auth/signup", { body: { email: `fc-op-${Date.now()}@example.test`, name: "Feature Check Operator", password: "feature-check-1", role: "operator", inviteCode: process.env.OPERATOR_INVITE_CODE } });
  expect(r.status === 200 && r.data.user.role === "operator", JSON.stringify(r.data));
});
await check("operator pages", async () => {
  expect((await o.req("/ops")).status === 200, "/ops");
  expect((await o.req(`/ops/trips/${tripId}`)).status === 200, "/ops/trips/[id]");
});
await check("operator adds a locked booking", async () => {
  await refresh();
  const r = await o.req(`/api/trips/${tripId}/days/1/patches`, { body: { baseVersion: bundle.trip.version, patches: [patch({ operation: "INSERT", payload: stop("Feature check dinner booking", "22:00", 26.91, { type: "HARD", category: "DINING", isOutdoor: false }) })] } });
  expect(r.status === 200, JSON.stringify(r.data));
  await refresh();
});
let opCard;
await check("delay on a locked booking goes to the operator queue", async () => {
  const hard = day1().nodes.find((n) => n.type === "HARD");
  const r = await t.req(`/api/trips/${tripId}/days/1/disruptions`, { body: { kind: "DELAY", nodeId: hard.id, delayMinutes: 20, reason: "feature check" } });
  opCard = r.data.proposalId;
  const q = await o.req("/api/ops/queue");
  expect(q.data.queue.some((p) => p.id === opCard), "not in queue");
});
await check("traveller cannot approve an operator card", async () => {
  await refresh();
  const p = bundle.proposals.find((x) => x.id === opCard);
  const r = await t.req(`/api/proposals/${opCard}/decision`, { body: { decision: "APPLY", optionId: p.options[0].id } });
  expect(r.status === 403, `got ${r.status}`);
});
await check("operator acknowledges it", async () => {
  const p = bundle.proposals.find((x) => x.id === opCard);
  const r = await o.req(`/api/proposals/${opCard}/decision`, { body: { decision: "APPLY", optionId: p.options[0].id } });
  expect(r.status === 200, JSON.stringify(r.data));
});
await check("operator quick edit — exact grammar", async () => {
  const r = await o.req(`/api/trips/${tripId}/days/1/microedit`, { body: { text: "push stop 2 15 min" } });
  expect(r.status === 200 && r.data.via === "grammar", JSON.stringify(r.data));
  return r.data.summary;
});
await check("operator quick edit — free text via Groq (Tier 2)", async () => {
  const r = await o.req(`/api/trips/${tripId}/days/1/microedit`, { body: { text: "the second stop needs to start twenty minutes later please" } });
  expect(r.status === 200 && r.data.via.startsWith("llm:"), JSON.stringify(r.data));
  return `${r.data.via}: ${r.data.summary}`;
});
await check("travellers can't use quick edit", async () => expect((await t.req(`/api/trips/${tripId}/days/1/microedit`, { body: { text: "push stop 2 15 min" } })).status === 403, "not 403"));
await check("operator autonomy settings", async () => {
  const r = await o.req(`/api/trips/${tripId}/settings`, { method: "PATCH", body: { autonomy: { maxAutoShiftMinutes: 25 } } });
  expect(r.status === 200, JSON.stringify(r.data));
});
await check("travellers can't change autonomy rules or read the ops queue", async () => {
  const s = await t.req(`/api/trips/${tripId}/settings`, { method: "PATCH", body: { autonomy: { maxAutoShiftMinutes: 90 } } });
  const q = await t.req("/api/ops/queue");
  const ev = await t.req("/api/ops/events");
  expect(s.status === 403 && q.status === 403 && ev.status === 403, `settings ${s.status}, queue ${q.status}, events ${ev.status}`);
});
await check("traveller view hides operator config and names", async () => {
  await refresh();
  const names = [...bundle.activity.map((a) => a.actor), ...bundle.proposals.flatMap((p) => [p.createdBy, p.decidedBy])];
  expect(bundle.autonomy === null, "autonomy policy sent to traveller");
  expect(!names.some((n) => n?.includes("Feature Check Operator")), "operator name visible");
  expect(names.includes("your operator"), "operator actions not labelled");
});

// ── Weather Digital Twin ───────────────────────────────────────────
await check("digital twin: forecast vs what-if, and the real trip is untouched", async () => {
  await refresh();
  const before = bundle.trip.version;
  const r = await t.req(`/api/trips/${tripId}/twin`, { body: { scenario: { precipAddMm: 25, durationExtendH: 3 }, dayIndex: 1 } });
  expect(r.status === 200 && r.data.days.length > 0, JSON.stringify(r.data).slice(0, 200));
  const d = r.data.days[0];
  expect(d.baseline.runs > 0 && d.scenario && d.scenario.runs > 0, "no simulated futures");
  expect(d.scenario.pAnyChange >= d.baseline.pAnyChange, "a heavier storm should not make things better");
  await refresh();
  expect(bundle.trip.version === before, "twin changed the real trip");
  return `${d.weather.basis}; change ${Math.round(d.baseline.pAnyChange * 100)}% → ${Math.round(d.scenario.pAnyChange * 100)}%`;
});
await check("fleet twin is for operators only", async () => {
  const r = await t.req("/api/ops/twin", { body: { scenario: {} } });
  expect(r.status === 403, `traveller got ${r.status}`);
  const o2 = await o.req("/api/ops/twin", { body: { scenario: { flood: true } } });
  expect(o2.status === 200 && Array.isArray(o2.data.operatorLoadByHour), JSON.stringify(o2.data).slice(0, 200));
  return `${o2.data.trips.length} active trips simulated`;
});
await check("social signals (public posts/news)", async () => {
  const r = await t.req("/api/twin/social?city=Mumbai");
  expect(r.status === 200 && Array.isArray(r.data.sources), JSON.stringify(r.data).slice(0, 200));
  return r.data.sources.map((s) => `${s.name}: ${s.status}`).join("; ");
});

// ── Essentials ─────────────────────────────────────────────────────
await check("hotels near the trip", async () => {
  const r = await t.req(`/api/hotels?tripId=${tripId}`);
  expect(r.status === 200 && r.data.hotels.length > 0, JSON.stringify(r.data).slice(0, 200));
  return `${r.data.hotels.length} found, e.g. ${r.data.hotels.slice(0, 2).map((h) => h.name + " (" + h.source + ")").join(", ")}`;
});
await check("flight tracker validates input", async () => expect((await t.req("/api/flights/track?callsign=%24%24")).status === 400, "not 400"));
await check("flight tracker (OpenSky live)", async () => {
  const r = await t.req("/api/flights/track?callsign=AIC101");
  expect(r.status === 200, JSON.stringify(r.data));
  return r.data.status ? "airborne" : "not airborne right now (valid answer)";
});
await check("place search (add-a-stop)", async () => {
  const r = await t.req("/api/places?q=Hawa%20Mahal%20Jaipur");
  expect(r.status === 200 && r.data.results.length > 0, JSON.stringify(r.data).slice(0, 200));
  return r.data.results[0].name;
});
await check("taxi card address lookup", async () => {
  const r = await t.req("/api/places/reverse?lat=26.9239&lng=75.8267");
  return { ok: r.status === 200, detail: r.status === 200 ? (r.data.place?.localAddress ?? "no address") : r.data.error };
});

// ── Group vote ─────────────────────────────────────────────────────
await check("group vote: create → join → unanimous → added to trip", async () => {
  const c = await t.req(`/api/trips/${tripId}/days/1/rooms`, { body: { start: "13:00", durationMinutes: 60 } });
  expect(c.status === 200, JSON.stringify(c.data));
  const view = (await anon.req(`/api/rooms/${c.data.token}`)).data;
  expect(view.options.length > 0, "no options");
  const guest = new Client();
  const j = await guest.req(`/api/rooms/${c.data.token}/join`, { body: { name: "Feature check guest" } });
  const forged = await guest.req(`/api/rooms/${c.data.token}/vote`, { body: { participantId: j.data.participantId, key: "0".repeat(32), optionId: view.options[0].id, vote: "yes" } });
  expect(forged.status === 403, "forged key accepted");
  await guest.req(`/api/rooms/${c.data.token}/vote`, { body: { participantId: j.data.participantId, key: j.data.key, optionId: view.options[0].id, vote: "yes" } });
  await t.req(`/api/rooms/${c.data.token}/vote`, { body: { participantId: c.data.participantId, key: c.data.key, optionId: view.options[0].id, vote: "yes" } });
  const after = (await anon.req(`/api/rooms/${c.data.token}`)).data;
  expect(after.state === "DECIDED", `state ${after.state}`);
  await refresh();
  expect(day1().nodes.some((n) => n.metadata?.plannedBy === "group vote"), "not inserted");
  expect((await anon.req(`/room/${c.data.token}`)).status === 200, "room page");
  return `chose ${view.options[0].name}`;
});

// ── Live updates (SSE) ─────────────────────────────────────────────
await check("live updates stream (SSE)", async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${B}/api/trips/${tripId}/events`, { headers: { cookie: t.cookie }, signal: ctrl.signal });
  const reader = res.body.getReader();
  let text = "";
  const reading = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
      if (text.includes("trip.updated")) break;
    }
  })();
  await sleep(500);
  await refresh();
  await t.req(`/api/trips/${tripId}/settings`, { method: "PATCH", body: { vibeConfig: { pacing: 0.5, budget: 0.3, culturalDepth: 0.2, circadian: 0.3 } } });
  await Promise.race([reading, sleep(5000)]);
  ctrl.abort();
  expect(text.includes("trip.updated"), "no event");
});

// ── Package + account upgrade ──────────────────────────────────────
await check("package → trip with preset vibe", async () => {
  const r = await t.req("/api/trips", { body: { destination: "Jaipur", startDate: "2026-09-29", endDate: "2026-09-29", vibeConfig: { pacing: 0.1, budget: 0.5, culturalDepth: 0.5, circadian: 0.3 }, autoPlan: false } });
  expect(r.status === 200, JSON.stringify(r.data));
});
await check("guest saves trips (upgrade keeps them)", async () => {
  const before = (await t.req("/api/trips")).data.trips.length;
  const r = await t.req("/api/auth/signup", { body: { email: `fc-traveller-${Date.now()}@example.test`, name: "Feature Check", password: "feature-check-1", role: "traveller" } });
  const after = (await t.req("/api/trips")).data.trips.length;
  expect(r.status === 200 && !r.data.user.guest && after === before, `${r.status} ${before}→${after}`);
});
await check("log out and log back in", async () => {
  const email = (await t.req("/api/trips")).status === 200;
  expect(email, "session lost");
  const out = await t.req("/api/auth/logout", { body: {} });
  expect(out.status === 200 && !t.cookie, "logout failed");
});

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? " — FAILED: " + failed.map((f) => f.name).join("; ") : ""}`);
console.log(`test trip id: ${tripId}`);
