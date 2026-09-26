# Musafir — handoff (2026-09-27, ~05:30 IST)

Read `CLAUDE.md` first (rules, ownership, §9 status, §10 task split). This file is the short "where are we, what's next".

## For Lakshita (UI) — screens to style
Behaviour is done and tested; layout-only rules live in `app.functional.css`. Style in `app.css` through the `mz-*` classes — keep class names and `data-*` hooks stable. Screens marked **NEW** appeared after your last styling pass.

| Screen / component | File (behaviour — don't edit) | Classes to style |
|---|---|---|
| **NEW · My dashboard** `/dashboard` (traveller) and **Fleet dashboard** `/ops/dashboard` (operator): stat tiles + live Neo4j graph + side panel | `_components/Dashboard.tsx`, `_components/GraphView.tsx` | `.mz-dash-tiles`, `.mz-dash-tile`, `.mz-dash`, `.mz-dash-graph`, `.mz-dash-side`, `.mz-dash-legend`, `.mz-cypher`; SVG: `.mz-graph`, `.mz-graph-edge` (+ `.t-NEXT`, `.t-FOR`), `.mz-graph-label`, `.mz-graph-edge-label`. Node colours are set in `GraphView.tsx` (`STYLE`) from our palette — tell Aryan if you want them changed |
| **NEW · "Something changed?"** box (traveller trip page, replaces the delay/closure/rain buttons) | `_components/Workspace.tsx` → `ReportBox` | `.mz-report` (also has `.mz-simulator`, so it inherits the dark band — decide if it should stay dark) |
| **NEW · Weather advisory card** in the operator queue (`/ops`): chance of rain, note field, "Send to traveller" / "Keep internal" | `_components/OpsConsole.tsx` → `AdvisoryCard` | `.mz-card.u-RECOMMENDATION`, `.mz-tier.t-TRAVELLER`, input `.mz-input` |
| Weather digital twin panel — **now operator-only** (operator trip view) | `_components/WeatherTwin.tsx` | styled by you already (`.mz-twin*`) |
| Twin map, `/ops/twin`, new-trip form chips, suggestion cards, login switch | see previous pass | already styled |

Nav changed: traveller top bar = HOME · **DASHBOARD** · TRIPS · FLIGHTS · HOTELS · PACKAGES; operator = HOME · **DASHBOARD** · OPERATIONS · WEATHER TWIN.

## Product rules decided today (so the UI copy matches)
- **Travellers say what changed in their own words** ("20 min late", "the fort is closed", "it's pouring") → they get the healed plan as a card. No delay/closure/rain buttons for travellers.
- **Weather the system detects itself** (sentinel / forecast) goes to the **operator first** as an advisory; the operator sends it (with the chance of rain + a note) or keeps it internal. Travellers never see unsent advisories.
- The **Digital Twin** and forecast tools are **operator** views. Travellers see the dashboard graph of their own trips only.
- Operators can **verify** a trip from the fleet dashboard (dashed green ring on the trip node).
- Keep traveller screens light — few buttons, short copy.

## Mandatory hackathon items — status
1. Live weather ✅ · 2. Map ✅ · 3. Social signals ✅ (Mastodon, Lemmy, GDELT) · 4. What-if simulation ✅ (operator twin; the real trip is never touched).
5. **Nugen alignment** ⚠️ Our pipeline works up to Nugen; the account has credits and READY documents, but **every alignment fails instantly on Nugen's side** (`Nugen job creation failed: HTTP 502 Bad Gateway`) and their inference returns 502 for every model. Evidence for the organisers: `alignment_01m3fyp5cqtdq9q6` (latest), `alignment_01m3fv8kmqq4kyz1` (first), 11 projects 21:52–22:52 UTC 26 Sep. When Nugen works:
   ```
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts align
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts status   # repeat until READY / early-deployable
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts deploy
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts eval
   ```
   then `NUGEN_MODEL=<printed id>` in `.env.local` (key is named `NUGEN_API`; both names work). A test proves the app then routes the twin's social reading to the aligned model.

## Next (not started)
- Travel buddies (swipe to match solo travellers / join groups) — new collection must go into the Neo4j adapter + mapping + import; account-only, 18+ attestation, block/report.
- Hotel specialist per city segment; automatic morning brief from the sentinel.

## Run / verify
```
npm run dev                 # one dev server per checkout (two servers on one Neo4j now retry safely)
npm test                    # 149 unit tests, ~2 s
npm run build && npx next start -p 3107
BASE=http://localhost:3107 node --env-file=.env.local scripts/e2e-check.mjs   # 67 checks; don't loop it (OSM/OpenSky quotas)
cd whatsapp && uv run pytest -q                                              # 95 bot tests
```
Last run (05:25 IST): 66/67 — only OpenSky's free daily quota failed.
