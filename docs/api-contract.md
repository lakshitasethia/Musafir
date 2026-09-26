# Musafir API contract

The Next.js route handlers in `src/app/api/**`, as built on `main` at commit `bd3fe05` (2026-09-26). Types come from `src/lib/musafir/schemas.ts` and `src/server/store.ts`. When a route changes, update this file in the same PR.

## Conventions

- **Base URL:** same origin as the app. Every route is under `/api`.
- **Auth:** a signed, HTTP-only session cookie `mz_session` (7-day lifetime, `SameSite=Lax`, `Secure` in production). It is set by `/api/auth/signup` and `/api/auth/login`. There are no bearer tokens.
- **Roles:** `traveller` or `operator`. Operators can view every trip; travellers can view only their own.
- **Request bodies:** JSON. Routes that take a body answer `400 {"error": "Expected a JSON body"}` when it isn't valid JSON.
- **Success:** the JSON shown per route. Routes with nothing to return send `{"ok": true}`.
- **Errors:** always `{"error": "<human-readable message>"}` with one of these statuses:

| Status | When |
|---|---|
| 400 | Not JSON, bad day index, missing option, trip longer than 30 days |
| 401 | `Please log in`: no or invalid session |
| 403 | Wrong role or not your trip, a locked booking, operator approval needed |
| 404 | Trip, day or proposal not found. Other people's trips also return 404, so they can't be discovered |
| 409 | Stale `baseVersion`, planner already running, proposal already decided, nothing to undo |
| 422 | Validation failed: `"<path>: <message>; …"` (zod), or an infeasible patch (`ScheduleError`) |
| 502 | Place search upstream (Nominatim) unavailable |
| 500 | `Something went wrong on our side` |

- **Optimistic concurrency:** every trip has an integer `version` that goes up with each change. Direct edits send `baseVersion`, and a mismatch returns `409`. A proposal applies only if `trip.version === proposal.baseVersion`; otherwise it becomes `STALE` and is never forced.
- **Times:** `HH:MM` inside a day (`00:00`–`23:59`). Minute offsets are `0`–`1440`. Dates are `YYYY-MM-DD`. Timestamps are ISO 8601 UTC.

---

## Auth

### `POST /api/auth/signup`
```jsonc
{ "email": "a@b.com", "name": "Asha", "password": "8-200 chars", "role": "traveller" | "operator", "inviteCode": "optional" }
```
→ `{ "user": { "id", "email", "name", "role" } }` and sets the session cookie.
- **Operator sign-up** depends on `operatorSignupMode()`:
  - if `OPERATOR_INVITE_CODE` is set, it requires that code (wrong code → `403 Invalid operator invite code`)
  - otherwise it's open in development and disabled in production (`403`)
- **Duplicate email** → `409`.

### `POST /api/auth/login`
```jsonc
{ "email": "a@b.com", "password": "…" }
```
→ `{ "user": {…} }` and sets the cookie. Wrong credentials → `401 Wrong email or password`.

### `POST /api/auth/logout`
Body `{}` → `{ "ok": true }` and clears the cookie.

---

## Trips

### `GET /api/trips`
Any signed-in user. → `{ "trips": TripSummary[] }`, newest `updatedAt` first.
```ts
TripSummary = { id, destination, dateRange: { start, end }, stops: number, owner: string, pending: number, updatedAt }
```

### `POST /api/trips`
**Travellers only** (`403` otherwise).
```jsonc
{
  "destination": "Jaipur",               // 1-120 chars
  "startDate": "2026-10-05",             // YYYY-MM-DD
  "endDate": "2026-10-07",               // >= startDate, at most 30 days
  "vibeConfig": { "pacing": 0.5, "budget": 0.5, "culturalDepth": 0.5, "circadian": 0.5 }, // optional, each 0..1
  "dietaryRestrictions": ["vegetarian"], // optional, <= 20 items of 1-40 chars
  "autoPlan": true                       // default true
}
```
→ `{ "id": "<trip uuid>" }`. When `autoPlan` is true, the planner agent runs after the response (see `/plan`).

### `GET /api/trips/{id}`
→ `TripBundle`:
```ts
{
  trip: TripState,                       // schemas.ts
  autonomy: AutonomyPolicy,              // risk.ts
  planner: { status: "RUNNING" | "DONE" | "FAILED", note, at } | null,
  owner: string,
  proposals: Array<ProposalRecord /* minus undoSnapshot */ & {
    undoable: boolean,                   // applied, has a snapshot, and nothing changed since
    escalated: boolean,                  // operator deadline passed while still PENDING
    canDecide: boolean[],                // per option, for the current user (server-computed)
  }>,                                    // latest 40, newest first
  activity: ActivityRecord[],            // latest 60, newest first: { id, tripId, at, actor, message }
}
```

### `PATCH /api/trips/{id}/settings`
```jsonc
{ "vibeConfig"?: {…}, "dietaryRestrictions"?: ["…"], "autonomy"?: Partial<AutonomyPolicy> }
```
- `vibeConfig` and `dietaryRestrictions` may only be changed by the owning traveller.
- `autonomy` may only be changed by an operator.
- Bumps `version`. → `{ "ok": true }`.

`AutonomyPolicy` (defaults): `{ autoApply: true, maxAutoShiftMinutes: 30, maxAutoCostIncrease: 0, operatorTimeoutMinutes: 30, fallbackToTraveller: true }`.

### `POST /api/trips/{id}/plan`
Body `{}`. Starts the planner agent for **empty days only**. The planner runs after the response. → `{ "ok": true }`.
- `409` if the planner is already running (and started less than 3 minutes ago), or if every day already has stops.
- Progress is reported through `planner` in the bundle and through SSE `activity` / `trip.updated` events.

---

## Days

`{dayIndex}` is 1-based. A non-integer or `< 1` value → `400 Invalid day`; a missing day → `404`.

### `POST /api/trips/{id}/days/{dayIndex}/patches`
Tier-1 direct edits (drag, edit, add, delete).
```jsonc
{ "baseVersion": 7, "patches": TripPatch[] /* 1-50 */ }
```
```ts
TripPatch = { patchId: uuid, targetDayIndex: int, operation: "REPLACE" | "INSERT" | "REMOVE" | "SHIFT_TIME",
              nodeId?: uuid, payload?: ItineraryNode, shiftOffsetMinutes?: int, reason: string }
```
→ `{ "version": 8 }`.
- `409` if `baseVersion` is stale.
- `403` if a traveller touches a `HARD` node (locked booking).
- `422` if the result is infeasible (for example, it would run past midnight).

### `POST /api/trips/{id}/days/{dayIndex}/disruptions`
Report a disruption; the self-healing engine builds a proposal.
```jsonc
{ "kind": "DELAY",   "nodeId": "<uuid>", "delayMinutes": 1-1440, "reason": "1-160 chars" }
{ "kind": "CLOSURE", "nodeId": "<uuid>", "reason": "…" }
{ "kind": "WEATHER", "fromMinute": 0-1439, "toMinute": 1-1440, "reason": "…" }
```
→ `{ "proposalId": "<uuid>", "status": "PENDING" | "AUTO_APPLIED" }`.
- **Auto-apply:** if the server classifies the fix as `AUTO`, it is applied immediately and can be undone.
- **Alternative venues:** for `CLOSURE` and `WEATHER`, the Disruption Resolver agent then searches for real venues within 800 m and adds an `agent` option to the proposal.

### `POST /api/trips/{id}/days/{dayIndex}/weather`
Body `{}`. Checks the real Open-Meteo forecast at the day's stops (the centroid of their locations). For each rain window that overlaps an **outdoor** stop, it raises one WEATHER proposal.
```jsonc
// checked
{ "checked": true, "windows": [{ "fromMinute": 840, "toMinute": 960, "peakProbability": 80 }], "message": "…", "proposals": ["<uuid>"] }
// not checked: no stops, day in the past, beyond the ~16-day horizon, or Open-Meteo down
{ "checked": false, "message": "Forecast unavailable: <reason>" }
```
The rain threshold is ≥ 60 % probability or ≥ 0.5 mm in the hour (`src/server/weather.ts`).

---

## Proposals

### `POST /api/proposals/{id}/decision`
```jsonc
{ "decision": "APPLY", "optionId": "<option uuid>" }
{ "decision": "DISMISS" }
```
→ `{ "tripId", "version", "stale"?: true }`.
- **Re-checked every time:** the server recomputes risk and authorization with `classifyRisk` + `canDecide` and never trusts the stored tier.
- **Already decided:** `409 Already <status>`.
- **Operator approval needed:** a traveller applying an `OPERATOR`-tier option gets `403`, unless the proposal has escalated (the operator missed the deadline), the option is `escalatable`, and `fallbackToTraveller` is on.
- **Stale trip:** if the trip changed since the proposal was computed, the response is `200` with `stale: true`, the proposal becomes `STALE`, and nothing is applied.
- **Notice-only options** (no patches) are acknowledged without changing the trip or its `version`.

### `POST /api/proposals/{id}/undo`
Body `{}`. Restores the day as it was before an `APPLIED` or `AUTO_APPLIED` proposal. → `{ "ok": true }`.
- `409` if later changes were made on top of it.
- `403` if a traveller tries to undo an operator-tier change.

`ProposalRecord` (in `store.ts`):
```ts
{ id, tripId, dayIndex, baseVersion, createdAt, createdBy, disruption, urgency: "INFO" | "RECOMMENDATION" | "CRITICAL",
  headline, context, options: ProposalOption[],
  status: "PENDING" | "AUTO_APPLIED" | "APPLIED" | "DISMISSED" | "STALE" | "UNDONE",
  operatorDeadline?, decidedBy?, decidedAt?, appliedOptionId?, appliedVersion?,
  agentStatus: "IDLE" | "RUNNING" | "DONE" | "FAILED", agentNote?, affectedNodeIds: string[] }
ProposalOption = { id, label, source: "engine" | "agent", patches: TripPatch[], conflicts: Conflict[],
  risk: { tier: "AUTO" | "TRAVELLER" | "OPERATOR", reasons: string[], costDelta, maxShiftMinutes, escalatable },
  rankedBy?: string /* e.g. "llm:groq/…" or "distance — AI ranking unavailable: …" */, rationale? }
```

---

## Operators

### `GET /api/ops/queue`
**Operators only.** → `{ "queue": QueueItem[], "trips": TripSummary[] }`.
- The queue holds `PENDING` proposals that have at least one `OPERATOR`-tier option, each with added `destination` and `escalated` fields.
- It is sorted by deadline, soonest first.

---

## Places

### `GET /api/places?q=<text>&lat=<num>&lng=<num>`
Any signed-in user. Nominatim search.
- `q` is trimmed and capped at 200 characters; fewer than 2 characters returns an empty list.
- `lat` and `lng` are optional: they bias results towards about 50 km around that point but don't restrict them.
- Requests are serialized at 1 per second and cached.

→ `{ "results": PlaceResult[] }`:
```ts
PlaceResult = { displayName, name, nativeName?, lat, lng, city, neighborhood?, category: NodeCategory, isOutdoor }
```
If Nominatim fails → `502 Place search is unavailable right now (…)`.

---

## Real-time (Server-Sent Events)

| Stream | Who | Channel |
|---|---|---|
| `GET /api/trips/{id}/events` | anyone who can view the trip | `trip:<id>` |
| `GET /api/ops/events` | operators only | `ops`: every trip's events |

- **Format:** `text/event-stream`. The server first sends `retry: 3000` and a `: connected` comment, then a `: ping` comment every 20 s. Each event is a JSON line `data: <MusafirEvent>`.
- **Events:**
  ```ts
  MusafirEvent =
    | { type: "trip.updated";     tripId; version }     // refetch the bundle
    | { type: "proposal.changed"; tripId; proposalId }  // a card appeared or changed status
    | { type: "activity";         tripId; message }     // e.g. "planner started"
  ```
- **Client pattern** (`_components/useLive.ts`): load the bundle, open an `EventSource`, refetch on any event, and refetch whenever the connection re-opens.
- **Single instance only:** the bus is in-process, so multiple server instances need a shared channel (planned: Supabase Realtime).

---

## Planned, not built yet

### `POST /api/sentinel` (owner: Aryan)
The zero-LLM watchdog. It is called by `.github/workflows/sentinel.yml` hourly, and also when a trip page opens and by the manual forecast check. The workflow already sends:
```http
POST /api/sentinel
Authorization: Bearer <SENTINEL_TOKEN>
Content-Type: application/json

{ "source": "github-actions" }
```
Expected behaviour so the workflow reports correctly:
- `2xx` when done.
- `401`/`403` for a missing or wrong token (the workflow fails loudly).
- Never run unauthenticated.

Until the route exists, the workflow treats `404` as a warning, not a failure.

### Auditors (`src/lib/musafir/auditors/`, wiring owner: Aryan)
These are pure functions, to be wired into healing, the planner and the UI. They don't expose any routes of their own.

| Function | Input | Output |
|---|---|---|
| `checkVisit(openingHours, date, start, durationMinutes)` | an OSM `opening_hours` value | `OPEN` / `CLOSED` / `PARTIAL` / `UNKNOWN` plus reason, hours and holiday caveat |
| `auditDiet(osmTags, dietaryRestrictions)` | venue tags + the trip's restrictions | `VERIFIED` / `CONFLICT` / `UNVERIFIED` per need, a label, and a disclaimer. Never "safe" |
| `auditBudget(schedule, limit?)` | days + optional `{ amount, currency }` | per-currency known totals, unknown count, `isLowerBound`, and findings |
| `auditPacing({ day, vibe?, weather?, elevationsM? })` | a day + optional Open-Meteo hourly / elevation data | fatigue, rest, stop-count, heat, UV and altitude findings, plus `restBreaks` |

### Verified datasets (`src/data/*.json`)
- `emergency-numbers.json`, `plug-types.json` and `tipping.json`, typed by `src/data/schema.ts`.
- Every fact has `sources[]` (URL, `verification`, quote) and `checkedOn`. Facts that couldn't be verified are listed under `gaps`.
- The UI must show the source, and should flag `verification: "search-index"` entries as "verify locally".
