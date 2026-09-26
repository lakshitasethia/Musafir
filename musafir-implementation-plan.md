# Musafir — Backend Implementation Plan

**Scope:** backend only. The UI is built by a teammate against our API.
**Reference:** `docs/musafir-research-and-architecture.md` (stack, architecture, feature list).
**Rule for every phase:** API-first. Each phase ends with its routes in OpenAPI (`/docs`) and any new WebSocket events in `docs/events.md`, so the UI teammate is never blocked.

---

## Phase overview

| # | Phase | Covers journey stages | Output |
|---|---|---|---|
| 0 | Foundation | — | Running skeleton, auth, roles, event bus, tests |
| 1 | Data model + seed inventory | — | All core tables, mock vendor data, operator vendor APIs |
| 2 | AI client + Discover + Personalize | Discover, Personalize | Gemini wrapper, preference parsing, ranking, trip drafts |
| 3 | Plan + Price | Plan, Price | OR-Tools itinerary solver, pricing and quotes |
| 4 | Book + Prepare | Book, Prepare | Validation, inventory locks, payments, assignment, groups, PDF |
| 5 | Operate + real-time | Operate | Operator/coordinator APIs, alerts, issues + SLA, downgrade detection |
| 6 | Adapt engine | Adapt | Impact graph, partial re-plan, approval flow |
| 7 | Assistant agent | Assist | Gemini function-calling agent with guardrails |
| 8 | Complete + Review | Complete, Review | Trip close, refunds/credits, reviews, vendor reliability |
| 9 | Hardening + demo | All | Demo scenarios, API contract, deploy |

---

## Phase 0: Foundation
**Goal:** a clean, runnable skeleton that every later phase plugs into.
- Repo structure, `uv`, Ruff, pytest, Makefile, `CLAUDE.md`
- Docker Compose: Postgres (pgvector), Redis, API, Celery worker, Celery beat
- Config via `pydantic-settings`, `.env.example`
- Async SQLAlchemy 2.0 + Alembic, with the pgvector extension enabled
- Auth: users, roles (`traveller`, `operator`, `coordinator`), JWT, role dependencies
- Common API conventions: error format, pagination, UUIDs, timestamps
- Event bus: Redis pub/sub + authenticated WebSocket endpoint, and a `docs/events.md` catalog
- Health check (DB + Redis)

**Done when:** `docker compose up` runs everything, `/health` is green, auth tests pass, and `/docs` shows the auth routes.

## Phase 1: Data model + seed inventory
**Goal:** every entity the lifecycle needs, with realistic demo data.
- Entities:
  - traveller profile and constraints (diet, accessibility, age group), vendors, hotels + room types, vehicles, activities, POIs
  - inventory/allotments per date
  - trips, trip components, trip versions, promised specs
  - bookings, payments, groups + members
  - coordinator/vehicle assignments, issues, notifications, reviews
- Trip state enum: `Draft → Planned → Priced → Booked → Prepared → Active → Completed → Reviewed`
- Seed script: 2 Indian destinations (e.g. Jaipur, Goa), INR prices, opening hours, coordinates, star ratings, lift/accessibility flags, capacities
- Operator CRUD APIs for vendors, inventory and coordinators

**Done when:** migrations run clean, the seed is idempotent, and operator CRUD is tested.

## Phase 2: AI client + Discover + Personalize
**Goal:** traveller preferences in, ranked options out, and an editable trip draft.
- Gemini wrapper: model routing (Lite vs Main), structured JSON output, Redis caching, retry/backoff, quota guard, **mock mode** for tests
- Preference parsing: free text + form → a structured `TripPreferences` object (interests, budget, pace, style, constraints)
- Embeddings (pgvector) for activities/POIs; ranking = similarity + rating + price fit + vendor reliability
- Integration adapters with cache + seeded fallback: Google Places, Open-Meteo, Viator Basic, LiteAPI
- Trip draft APIs: create, add/swap/remove components, compare alternatives, **lock** user edits, version every change (history + undo)

**Done when:** a traveller can go from free-text preferences to a draft trip with ranked, swappable components, fully offline in mock mode.

## Phase 3: Plan + Price
**Goal:** a feasible day-by-day itinerary with a transparent price.
- Travel-time matrix: ORS, with a haversine fallback and caching
- OR-Tools solver: time windows (opening hours), service durations, pace → daily limit + buffers, locked items pinned, optional items with drop penalties by preference score, hotel as the daily start/end
- Returns the itinerary plus dropped items and the reason each was dropped
- Pricing engine: per-component breakdown, taxes/markup, budget warnings, versioned quotes, price lock with expiry
- State machine service enforcing allowed transitions

**Done when:** a seeded trip solves in < 5s, respects all hard constraints, and the quote matches the component sum.

## Phase 4: Book + Prepare
**Goal:** safe booking and an operator-ready trip.
- Validation service: visa-days vs itinerary length, permits, ticket inclusions, accessibility (lift, walking load), diet. Returns blocking errors vs warnings.
- Inventory: hard allotment limits with row locking (no overselling)
- Razorpay test mode: create order, verify signature/webhook, idempotent payment handling
- On booking: snapshot **promised specs** (star rating, room type, vehicle type, inclusions)
- Groups: members, individual preferences, cost split, per-member opt-outs
- Assignment: CP-SAT assigns coordinators and vehicles to trips (capacity, availability, language); operator can override
- PDF itinerary export (WeasyPrint) for offline use

**Done when:** double-booking is impossible under concurrent requests, a paid trip reaches `Prepared` with assignments, and the PDF downloads.

## Phase 5: Operate + real-time
**Goal:** operators and coordinators run live tours; travellers get pushed information.
- Operator APIs: active tours dashboard data, filters, per-trip timeline
- Coordinator APIs: status updates (picked up, checked in, activity done), delivery confirmation
- **Downgrade detector:** delivered specs vs promised specs → flag, require traveller consent, log compensation
- Notification service + Celery beat: day-before briefing, pickup/driver details, vouchers
- Issue tracker: owner, SLA deadline, timer, auto-escalation, compensation log
- All state changes publish WebSocket events

**Done when:** a coordinator update reaches the traveller and operator sockets live, a downgrade raises a flag, and an overdue issue escalates.

## Phase 6: Adapt engine
**Goal:** disruptions are detected, contained and re-planned with approval.
- Dependency graph (NetworkX) built from trip components (hotel → transfer → activity, etc.)
- Event sources: vendor cancellation, delay, Celery weather watcher (Open-Meteo), traveller request
- Impact analysis → affected components + affected time window
- Partial re-plan: re-run the solver only on the window; confirmed/locked items stay fixed
- Validate → Gemini explains the diff + cost delta → `ChangeProposal`
- Approval flow: operator approves; downgrades also need traveller consent; then apply as a new trip version, notify all, open/close an issue

**Done when:** the "rain on day 2" scenario produces a valid, explained proposal, and approval updates all dashboards.

## Phase 7: Assistant agent
**Goal:** a conversational in-trip helper that can only propose, never force.
- Gemini function-calling loop with a max-steps limit
- Tools: `get_trip`, `search_places`, `check_availability`, `get_weather`, `replan_day`, `estimate_cost`, `propose_change`, `raise_issue`
- Guardrails: role/trip scoping, no direct booking writes, respect locks, all changes go through the Phase 6 approval flow
- Conversation history per trip, plus a tool-call trace for debugging

**Done when:** "It's raining, move the fort visit and find something indoor near my hotel" ends in a valid `ChangeProposal`.

## Phase 8: Complete + Review
**Goal:** a fair close and a feedback loop.
- Trip completion: per-component refund value / credit for skipped or cancelled items, final statement
- Reviews: vendors, activities, coordinator
- Vendor reliability score from ratings + incidents + downgrades + SLA breaches, fed back into ranking and assignment

**Done when:** completing a disrupted trip produces a correct statement, and new reviews shift the ranking.

## Phase 9: Hardening + demo
**Goal:** a reliable demo and a clean handoff to the UI.
- Demo scripts: seed a trip mid-journey, then trigger the rain disruption, a vendor downgrade and an overdue issue
- `docs/api-contract.md` + `docs/events.md` finalized; Postman/Bruno collection
- End-to-end test covering the full journey
- Gemini quota safeguards (Lite by default, cache, mock fallback)
- Deploy: Docker to Render/Railway, managed Postgres + Redis

**Done when:** the full journey runs end-to-end on the deployed URL.
