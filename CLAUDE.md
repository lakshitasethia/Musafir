@AGENTS.md

# MUSAFIR — Project Directive for Claude

Musafir is an autonomous, self-healing, **zero-chat** travel companion. Travellers set a destination, dates and a few tactile faders. A planner agent drafts every day from real places. When reality breaks the plan (a delay, a closure, rain), a deterministic engine heals the day and asks for a tap only when it must. Operators approve anything that touches locked bookings or money.

> Status snapshot: 2026-09-26. Keep §9 (status) current when you finish work.

---

## 1. Operating mandate

- **Push back.** If asked for a generic chatbot, an unconstrained agent swarm, slow sequential LLM chains, bloated packages or unvalidated state mutations, refuse and propose the better engineering solution. Be a technical partner, not a yes-machine.
- **Anti-chatbot.** A traveller in the rain won't type paragraphs. Deliver faders, graph interactions, one-tap action cards and background resolution. No free-text chat for travellers.
- **Deterministic first, AI second.** Distances, clustering, timing, cost sums, feasibility and risk are **TypeScript**. LLMs may only rank or choose among things code fetched, classify intent, or write short text.
- **Nothing hardcoded or hallucinated.** Behaviour comes from data, config and named constants. Unknown facts stay unknown and are labelled (e.g. cost "unknown", diet "unverified"). Never fake LLM output: when there's no key, use the deterministic fallback and say so in the UI.
- **Edge cases are features.** Reject invalid input with clear errors. Never wrap times across midnight silently, and never mutate inputs. Write tests for every rule.
- **Zero-cost production.** Everything must run on free tiers (see §6). Verify free-tier limits from the provider's docs, not from memory.
- **TypeScript only.** One language, one deploy. No Python service. No LangGraph and no Vercel AI SDK (decided, see §5).

---

## 2. Repo map & commands

| Path | What |
|---|---|
| `src/lib/musafir/` | **Pure core** (no Next, no I/O): `schemas.ts` (zod contracts), `time.ts`, `geo.ts` (Haversine, OSRM client, commute bands, fatigue), `reducer.ts` (self-healing engine + `applyPatches`), `risk.ts` (autonomy tiers), `planner.ts` (deterministic day planner), `ids.ts`, `*.test.ts` |
| `src/server/` | **Server-only**: `store.ts` (JSON file store), `auth.ts`, `trips.ts` (the only place trip state changes), `events.ts` (SSE bus), `llm.ts` (LLM gateway), `osm.ts` (Nominatim + Overpass), `weather.ts` (Open-Meteo), `agents.ts` (Disruption Resolver), `planner.ts` (planner agent), `http.ts` |
| `src/app/api/**` | Route handlers (auth, trips, days/patches, disruptions, weather, plan, proposals, ops queue, SSE, places) |
| `src/app/(app)/` | App screens: `/login`, `/signup`, `/trip`, `/trip/[id]`, `/ops`, `/ops/trips/[id]`. Behaviour in `_components/`, visuals in `app.css`, layout-critical CSS in `app.functional.css`, presentational components in `_ui/` |
| `src/app/page.tsx`, `globals.css`, `components/` | Landing page (Flyward-inspired) |
| `musafir-*.md` | **Historical** research/plan for a Python backend. Superseded by this file; don't implement from it. |

```bash
npm run dev     # next dev --webpack (only one dev server per checkout)
npm test        # node --test with type stripping (Node >= 22.6), ~1 s, no build needed
npx tsc --noEmit
npm run lint
npm run build   # run before every merge to main
npm run check:e2e   # 52 end-to-end feature checks against a running server (npm start first); writes labelled test data
```

**Conventions**
- **Relative imports inside `src/lib` and `src/server` use explicit `.ts` extensions** (`allowImportingTsExtensions` is on). This lets the Node test runner execute them directly.
- `src/lib/musafir` must stay pure: no `next/*`, `fs`, or `fetch`, except the injectable `fetchImpl` in `geo.ts`.
- `"use client"` files must never import from `src/server`. Type-only imports (`import type`) are fine.
- Next 16: `params` and `cookies()` are async, `middleware` is now `proxy`, and background work after a response uses `after()`. Read `node_modules/next/dist/docs/` before using an unfamiliar API (see AGENTS.md).
- Env vars go in `.env.local` (template: `.env.example`). **Never put real values in `.env.example`** — it is committed; `.env.local` is git-ignored. Share keys with teammates privately, not through git. All are optional in dev. `AUTH_SECRET` is required in production. Use `||`, not `??`, for env defaults, so empty strings fall back.
- Local data lives in `.data/` (gitignored): users, trips, dev secret.
- **Storage is an adapter** (`src/server/store.ts`): the JSON file store by default; **Neo4j graph database** when `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` are set (`src/server/store-neo4j.ts`, mapping in `src/lib/musafir/graph-mapping.ts`). Callers only use `read`/`write`; `write` callbacks must be side-effect free (they may re-run on a cross-instance conflict). Import existing data once with `npm run db:import-neo4j`.
- **No login needed for travellers**: traveller pages start a guest session automatically (`/api/auth/guest`); "Save my trips" upgrades the guest in place. Operator pages require a real operator login.

---

## 3. Architecture (as built)

```
 Triggers ─────────────────────────────────────────────────────────────────────
   UI edits (Tier 1) · Disruption simulator · Open-Meteo check · Planner request
                                   │ typed events (no LLM routing needed)
                                   ▼
 Trip service  src/server/trips.ts   ← the ONLY writer of trip state
   authorize (role + ownership) → check baseVersion (409 if stale)
                                   │
          ┌────────────────────────┼─────────────────────────────┐
          ▼                        ▼                             ▼
 Self-healing engine       Leaf workers (agents)           Planner agent
 lib/musafir/reducer.ts    server/agents.ts                server/planner.ts
 heal(): DELAY | CLOSURE   Disruption Resolver:            geocode → OSM places →
  | WEATHER, min-cost      OSM venues ≤ 800 m → LLM        LLM curator (index-only) →
  recovery, HARD locked    picks 1 of 3 → REMOVE+INSERT    lib planner (cluster/order/time)
          │                        │                             │
          └──────────── TripPatch[] (typed, zod) ────────────────┘
                                   ▼
 Critics (code): applyPatches (feasibility, HARD lock, midnight) → classifyRisk
   AUTO → apply now, undoable │ TRAVELLER → one-tap card │ OPERATOR → ops queue + deadline
                                   ▼
 Persist (store.ts, atomic) → activity log → SSE publish (trip:<id>, ops)
                                   ▼
 UI: JourneyGraph (live) · Action cards (preview diff / apply / dismiss / undo) · Ops console
```

**Self-healing engine rules** (`reducer.ts`):
- HARD nodes never move and are never dropped.
- A delayed traveller sets an **availability floor**. Skipping the delayed stop does not erase the delay.
- Recovery is a **min-cost search** per segment between locked anchors: `dropWeight × priority + trimWeight × compressed minutes + shiftWeight × moved minutes`.
- Subsets are enumerated up to `maxEnumerateItems`; larger segments use greedy dropping by priority. Tie-breaks are deterministic.
- `bufferMinutes` means **how much a visit may be compressed** (never below `minVisitMinutes`).
- Weights come from `policyFromVibe(vibe)`: fast pacing protects the number of stops.
- Transit between stops that were adjacent in the original plan is `min(estimate, original gap)`, so estimates never amplify a delay.

**Autonomy tiers** (`risk.ts`, re-checked server-side on every decision):
- **AUTO:** SOFT shifts or compression within `maxAutoShiftMinutes` / buffer, no added cost.
- **TRAVELLER:** drops, inserts, swaps, or bigger shifts.
- **OPERATOR:** touches a HARD booking, adds cost above `maxAutoCostIncrease`, mixed currencies, or a locked-booking conflict.
- If the operator misses `operatorTimeoutMinutes`, **escalatable** items (conflict notices only) fall back to the traveller when `fallbackToTraveller` is set.
- Hiding a button is never authorization. Routes enforce role, ownership and tier.

---

## 4. Design system (the codebase is the truth)

The shipped look is the **light, editorial, Flyward-inspired** landing page. When older notes mention a dark palette or `font-apris` classes, they're wrong; follow `globals.css` and `app.css`.

- **Type:** `Apris` (serif, uppercase, generous tracking) for headings, destinations and stop titles; `Founders Grotesk Text` for body, labels, times and meta. Both are loaded in `globals.css`. Never use Inter, Roboto or Arial.
- **Colour:**
  - base: ivory `#fbf8f3`, dark umber `#3d2d20`, silver hairlines `#c2c6ca`, obsidian `#1c2124` for dark sections
  - states: sage `#5e8b72` (healthy / auto), amber `#e5a96a` (`#c98a45` on paper) (moderate / traveller's call), Venetian red `#b8534f` (spike / operator), slate `#4b6b94` (proposed / agent)
- **Language:**
  - hairline grids and nautical line-art (`GridSvg`, `journey-map.svg`)
  - a winding route through numbered umber markers, drawn on scroll with GSAP
  - torn-paper transitions (`torn-edge-down`, `remove1-1`)
  - huge uppercase serif headings
  - **no generic SaaS cards or dashboards**
- **App CSS:**
  - Every class is prefixed `mz-`.
  - Don't reuse the landing's global `.grid`, `.button`, `.heading-style-h2/h4` or `.text-size-large`; they're redefined elsewhere.
  - App pages pin `html { font-size: 16px }` because the landing scales rem with the viewport.
- **Mobile-first:** 44 px hit targets, inputs ≥ 16 px (no iOS zoom), sheets as bottom sheets, `touch-action: none` only on draggable stops.
- **Planned restyle** (owner: Lakshita, §10): paper hero → journey route → dark torn-edge "When plans break" section (simulator, cards, log) → paper vibe panel → bottom ribbon for pending cards, with Lenis smooth scroll (Aryan adds motion).

---

## 5. Agents — what we build, what we reject

LLM calls go only through `src/server/llm.ts`:
- A fetch + zod gateway with JSON mode: **Groq** first, **Gemini** (OpenAI-compatible endpoint) as fallback.
- Model ids come from env (`GROQ_MODEL_FAST`, `GROQ_MODEL_DEEP`, `GEMINI_MODEL`). Provider catalogs change, so **verify ids against the provider's models endpoint** when a key is added.
- No LangGraph: approvals span devices and hours, so they're a DB-backed queue, not an in-process graph interrupt. No Vercel AI SDK: two OpenAI-compatible calls don't justify the dependency.

**Hard rules for every agent**
1. **The supervisor is TypeScript.** Workers never call each other. They return typed candidates or `TripPatch[]` to the trip service, and every patch passes `applyPatches` → `classifyRisk`.
2. **LLMs choose, rank or describe only what code fetched.** They return ids or indices. They never invent venues, coordinates, times, prices, opening hours, dietary safety or emergency facts.
3. **Context slice under 600 tokens.** Send the slot, neighbouring stops' coordinates, constraints and ≤ 3–24 candidates. Never the whole trip.
4. **Critics are code.** An LLM "critic" is not a safety layer.
5. **Parallel spawning:** use `Promise.allSettled` with per-worker timeouts; one failure never fails a proposal. Nominatim stays serialized (1 req/s policy).

| Role / worker | Verdict | Implementation |
|---|---|---|
| Router / Classifier | Code for typed events; LLM only for operator free-text micro-edits (Tier 2 → `TripPatch`) | **Built**: `lib/musafir/microedit.ts` grammar first, LLM fallback returns {op, stop index, minutes} only; operator previews, then applies (`server/microedit.ts`) |
| Worker / Executor | Keep | `agents.ts`, `planner.ts` |
| Critic / Auditor | Keep, **as code** | `applyPatches`, `classifyRisk`, `heal`. Contract `lib/musafir/auditor-contract.ts`, registry `server/auditors.ts` (empty until Parth's `auditors/*` land); findings shown per day |
| Synthesizer | Words only (headline/rationale), template fallback | Rationale in Resolver; headlines are templates |
| Sentinel / Watchdog | Keep, **zero-LLM**. **Vercel Hobby cron = once/day** (verified 2026-09-26), so trigger it on trip-page open (every 10 min), from a GitHub Actions schedule → `/api/sentinel`, and from the manual forecast check | **Built**: `lib/musafir/sentinel.ts` + `server/sentinel.ts`, destination-local clock, dedupe, per-trip rate limit; `/api/sentinel` (session or `SENTINEL_SECRET`); trip page polls every 10 min. GitHub Actions schedule = Parth |
| Discovery & Venue Specialist | Keep | **Built**: OSM within 3 km, vibe score, LLM curator (index-only), dedupe of OSM duplicates; never schedules a place in a slot its `opening_hours` exclude (`lib/musafir/opening-hours.ts`); days inside the forecast horizon are pre-healed for rain with the same `heal()` |
| Disruption Resolver | Keep | **Built**: runs only when a stop was actually lost (`lib/musafir/resolver.ts` gate: CLOSURE, or WEATHER stops the engine REMOVEd). Real venues ≤ 800 m ranked by code (open then per OSM hours, purpose, distance); LLM only breaks a genuine tie (score gap < 0.1). Targets in parallel, REMOVE+INSERT |
| Dining & Dietary Matcher | Keep, narrowed | **Built**: `lib/musafir/dining.ts` + planner meals + group-room options; OSM `diet:*` tags captured; injectable checker defaults to "unverified" until Parth's `diet.ts` |
| Pacing & Fatigue Auditor | Keep, pure code | Leg/day fatigue **built** in `geo.ts`; auditor with rest buffers + Open-Meteo heat/UV/elevation **not built** |
| Logistics & Transit | Keep, narrowed | **Built**: OSRM table (≤1 req/s, cached) warmed before every write and used by engine + planner (`server/routing.ts`), Haversine fallback. Transitland needs a key. **Rejected:** hardcoded rail-pass rules |
| Budget & Expense Auditor | Keep, pure code | Sums **known** costs only; open data has no prices (**not built**) |
| Concierge & Cultural Guide | **Rejected as a chatbot** | Replace with tap-to-read "Know before you go" cards. Emergency numbers, visas and plugs come from a **verified static dataset** (`src/data/`), never an LLM |

---

## 6. Free-tier infrastructure (verified facts)

| Need | Provider | Notes |
|---|---|---|
| LLM | Groq (JSON mode on all models; `openai/gpt-oss-20b` / `-120b` listed 2026-09), Gemini via OpenAI-compatible endpoint | Optional; deterministic fallback everywhere |
| Geocoding / place search | Nominatim | ≤ 1 req/s, identifying User-Agent, cache, no autocomplete-per-keystroke (search on submit) |
| POIs / search | Overpass (mirrors via `OVERPASS_URLS`) → Nominatim → Photon (photon.komoot.io) | Tried in that order. Some networks block Overpass and Photon (Aryan's does). On HTTP 429 Nominatim is left alone for 10 min. Results are cached in `.data/osm-cache.json` for 7 days and served stale if every source fails, so a place looked up once keeps working |
| Routing | OSRM public demo | **Car profile only** (a `foot` request returns car results) |
| Weather | Open-Meteo | No key; forecast horizon ~16 days (outside it, say so) |
| Hosting | Vercel Hobby | Cron **once per day** max. File store and in-process SSE are **single-instance only** → Supabase (Postgres + Realtime) for multi-instance |
| Graph database | Neo4j AuraDB Free (chosen by the team) | 50k nodes / 175k relationships; **pauses after 3 days idle** (resume in the Aura console). Trips are native graphs: `(User)-[:OWNS]->(Trip)-[:HAS_DAY]->(Day)-[:HAS_STOP]->(Stop)-[:NEXT]->(Stop)` |
| Live flights | OpenSky Network (anonymous) | 400 credits/day, global snapshot costs 4 → cached 60 s. Current positions only |
| Flights/hotel booking | none free | Hand-off links (Google Flights, Booking.com) with trip details prefilled; **no prices shown** |

---

## 7. Data contracts

`src/lib/musafir/schemas.ts` is the **source of truth**. Its zod schemas include `ItineraryNode`, `DaySchedule`, `TripState`, `TripPatch` and `ActionCardPayload`.

Zod v4 needed two changes from the original spec:
- `z.record(z.string(), z.unknown())`
- `z.uuid()`, which enforces RFC 9562 variant bits

Node metadata conventions:
- `priority` (0–1; drop order), `plannedBy`, `source`, `sourceId`/`osmId`, `kind` (OSM `key=value`)
- `costSource` (e.g. "unknown (no price in open data)"), `openingHours`, `replacedNodeId`

Proposals (`store.ts` `ProposalRecord`) carry `baseVersion`, options with a server-computed `risk`, `operatorDeadline`, `undoSnapshot` and agent status. **Patches apply only if `trip.version === baseVersion`; otherwise the proposal is marked STALE, never forced.**

---

## 8. Pushback checklist (halt and correct if any is true)

- [ ] The UI clashes with the light Flyward look, or introduces generic SaaS components → rebuild with Apris/Founders, hairlines and the `mz-` classes.
- [ ] Someone adds a free-text chatbot for travellers → replace with an action card, fader, or tap card.
- [ ] An LLM computes distance, duration, time, cost or feasibility → write the TypeScript function.
- [ ] Agents talk to each other, or mutate state directly → typed results back to `trips.ts` only.
- [ ] A whole trip is serialized into a prompt → context slicer.
- [ ] A value is invented because data is missing (price, diet safety, emergency number, opening hours) → mark it unknown or unverified.
- [ ] A paid API is introduced, or a free-tier limit is assumed without checking → use an open equivalent and verify the limit.
- [ ] A disruption card sounds alarmist → calm, solution-first, with the fix already computed.
- [ ] A client-side check is treated as authorization → enforce in the route or service.

---

## 9. Status

**Built and verified** (67 unit tests; 54/54 end-to-end checks on Neo4j + Groq on 2026-09-26, incl. role-isolation checks; API smoke tests; browser pass incl. WebGL map, server-down offline test, guest flow):
- **No-login use**: guest traveller sessions on first visit; upgrade on sign-up keeps trips. Operators log in.
- **Role isolation**: every mutation re-checks role + ownership server-side (`trips.ts`, `microedit.ts`, `requireUser(role)`); travellers never receive the autonomy policy or operators' names (shown as "your operator"); operator sign-up needs `OPERATOR_INVITE_CODE` (constant-time compare), disabled in production without it.
- **Opening hours** respected by planner, Resolver, Cluster Nearby and group-vote options (unknown hours allowed, labelled).
- Landing nav: PLAN · FLIGHTS · HOTELS · PACKAGES; app top bar: HOME · TRIPS · FLIGHTS · HOTELS · PACKAGES (operators: HOME · OPERATIONS)
- Trip creation with Vibe faders + diet → **planner agent** drafts every empty day (OSM places, OSRM travel times, diet-aware meals)
- **Packages**: preset travel styles → one tap creates and plans a trip
- **Flights**: Google Flights hand-off prefilled from the trip; **live flight tracking** (OpenSky)
- **Hotels**: real OSM accommodation near the trip's stops (stars only if OSM has them), Booking.com hand-off, "Add to my trip" (+ Taxi card)
- Journey graph (route drawn on scroll, drag with optimistic UI), CRUD, operator rebooking of HARD stops
- Self-healing simulator (delay / closure / rain) → min-cost recovery → AUTO / TRAVELLER / OPERATOR tiers, live escalation timer
- Sentinel (next 2 h rain, destination-local), Cluster Nearby, Dining Matcher, Resolver, planner curator — all with labelled deterministic fallbacks
- MapLibre commute map; Tier 2 operator quick edits; offline IndexedDB + service worker + Taxi Rescue card (Lakshita's `TaxiCard`); Group Vibe Check rooms
- Lakshita's UI integrated: `ActionRibbon`, `TaxiCard`, dark torn-edge simulator band (`.mz-simulator`), `SectionHeader`
- App-wide motion (`_components/SmoothScroll.tsx`): Lenis + GSAP ScrollTrigger reveals/parallax on every app page, like the landing
- Neo4j storage adapter + import script — **verified 2026-09-26 against Aura** (import of local data identical field-for-field; create/edit/heal persisted across a server restart). Honours `NEO4J_DATABASE`.
- LLM path **verified live**: Groq `openai/gpt-oss-20b` / `-120b` available; gateway call ~0.5–0.8 s. Gemini key valid (`gemini-3.8-flash` listed) but returned a temporary 503 "high demand" during testing.

**Not built / limits:**
- Parth: `auditors/*`, `src/data/*` verified datasets (KnowCard facts, translated "take me here" phrase), GitHub Actions sentinel workflow
- Realtime across instances: SSE is in-process; multiple servers need a shared channel (e.g. Supabase Realtime / Redis) even with Neo4j
- Transitland (needs a key); phonetic romanization on the Taxi card
- Flight/hotel **booking and prices** are out of scope (no free API) — hand-offs only

**Caveats:** Overpass blocked on Aryan's network; Nominatim IP-rate-limited there too (Photon / Wikidata fallbacks, 7-day disk cache). Don't loop `check:e2e` against live providers. Sentinel's rain path unit-tested (no rain during testing).

---

## 10. Team split — Aryan × Lakshita × Parth (conflict-free ownership)

**This machine is Aryan's.** Priority: **UX and working features first, UI polish second.** Lakshita is fixing the website UI now; Aryan pulls and merges her work. Ownership is by **directory / file**, so two people never edit the same file.

### Aryan — core features, UX flows, agents, heavy work, merges (this PC)
- `src/lib/musafir/*.ts` (core) + tests, `src/server/**`, `src/app/api/**`
- Behaviour of `src/app/(app)/**/*.tsx` (pages, `_components/*` state, data flow, UX), plus `app.functional.css` (layout-critical rules only)
- **Anything GPU- or CPU-heavy:** MapLibre (WebGL), GSAP/Lenis motion, production builds, full test runs, asset optimization
- **Wiring:** plugs Parth's auditors and data into the server and UI, and renders Lakshita's `_ui` components
- Shared config, **Aryan only**: `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `.env.example`, `.gitignore`, `CLAUDE.md`. Others ask Aryan to add dependencies (lockfile merges are the #1 conflict source).

### Lakshita — UI / visual layer
- `src/app/page.tsx`, `src/app/layout.tsx`, `src/app/globals.css`, `src/app/components/**`, `public/**`
- `src/app/(app)/app.css` — restyle every app screen through the existing **`mz-*` class contract**
- `src/app/(app)/_ui/**` — **presentational-only** components (no fetch, no server imports; props in, JSX out): `TaxiCard`, torn-edge dividers, section headers, action-card ribbon layout, group-room layouts
- The restyle plan in §4

### Parth — light logic, verified data, QA and docs (low-power PC: no GPU, weak CPU)
Everything here runs with `npm test` or needs no running app. **Parth never needs `npm run build`** or a GPU.
- `src/lib/musafir/auditors/**` — new pure-TS files + `*.test.ts`:
  - `pacing.ts`
  - `budget.ts` (known costs only)
  - `diet.ts` (OSM `diet:*` → verified / unverified / conflicts)
  - ~~`openingHours.ts`~~ — core parser now lives in `src/lib/musafir/opening-hours.ts` (Aryan). Parth may extend it (PH, week numbers, month ranges) with tests; unknown formats must stay "unknown"
- `src/data/**` — verified JSON datasets, each entry with `source` URL + `checkedOn` date (emergency numbers, plug types, tipping norms for demo countries). Never LLM-generated.
- `.github/workflows/**` — the scheduled sentinel ping
- `docs/**` — API contract (routes, payloads, SSE events), demo script, test scenarios
- Real-phone QA of `/trip` and `/ops` against a dev server or Vercel preview; issues with screenshots

### Contracts
1. **Class names** (Aryan ↔ Lakshita). Aryan keeps `mz-*` classes stable, and Lakshita styles them freely.
   - Lakshita needs new markup? She asks Aryan for a class or `data-*` hook, or builds a `_ui` component.
   - Aryan needs a new visual? He adds a semantic class and a minimal rule in `app.functional.css`.
2. **Types** (everyone). `_ui` components and auditors take plain values typed from `schemas.ts` and never import `src/server`.
3. **Known shared edits in Lakshita's files** (keep them when restyling):
   - `src/app/page.tsx` nav: `LOG IN` pill (→ `/login`); left links PLAN (`/trip`) · FLIGHTS · HOTELS · PACKAGES. The PLAN link is a plain `<a>` on purpose (full load so the guest session cookie is set).
   - `src/app/page.tsx` brand link switched to `<Link>` (lint error fix).
4. **Branches:** `ui/*` (Lakshita), `data/*` (Parth), `feat/*` (Aryan).
   - Aryan merges: `git fetch` → `git merge origin/<branch>` → resolve → `npm test && npx tsc --noEmit && npm run build` → push.
   - Never force-push `main`.

### Backlog by owner
| Aryan (core + heavy) | Lakshita (UI) | Parth (light logic/data/QA) |
|---|---|---|
| `/api/sentinel` + on-open polling | Flyward restyle of app screens via `app.css` | `auditors/pacing.ts` + tests |
| Wire auditors into healing/planner + UI warnings | `_ui/TaxiCard` (boarding-pass look, huge native script) | `auditors/budget.ts` + tests |
| Dining Matcher agent (uses `diet.ts`) | Action-card ribbon layout | `auditors/diet.ts` + tests |
| Tier 2 operator micro-edit router (Groq → `TripPatch`) | Group-room screen layouts | `auditors/openingHours.ts` + tests |
| OSRM in scheduling; Transitland once keyed | Know-before-you-go card design | `src/data/*.json` with sources |
| MapLibre commute map + `[Cluster Nearby]` | Mobile layout polish (≤ 390 px) | `.github/workflows/sentinel.yml` |
| Motion: route draw, Lenis, card springs | Landing page (ongoing) | `docs/api-contract.md`, `docs/demo-script.md` |
| Offline (IndexedDB + SW), Supabase adapter + Realtime | — | Real-phone QA passes |
| Live escalation timer, optimistic UI, builds/merges | — | — |

**Aryan column status (2026-09-26):** all done except the Supabase adapter + Realtime and Transitland, which need keys or accounts. Wiring of Parth's auditors is ready: add them to `src/server/auditors.ts`.
