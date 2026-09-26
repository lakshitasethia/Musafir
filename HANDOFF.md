# Musafir — handoff (2026-09-27, 03:40 IST)

Read `CLAUDE.md` first (rules, ownership, §9 status, §10 task split). This file is the short "where are we, what's next".

## For Lakshita (UI) — new screens that need your styling
All behaviour is done and tested; layout-only rules live in `app.functional.css`. Style them in `app.css` through the `mz-*` classes below — please keep class names and `data-*` hooks stable.

| Screen / component | File (behaviour — don't edit) | Classes to style |
|---|---|---|
| **Weather digital twin** panel (trip page, below the itinerary) | `_components/WeatherTwin.tsx` | `.mz-twin`, `.mz-twin-sliders`, `.mz-twin-metrics`, `.mz-twin-metric`, `.mz-twin-stop`, `.mz-twin-bar`, preset chips use `.mz-chip[aria-pressed]` |
| Twin **map** pins (MapLibre) | `_components/TwinMap.tsx` | `.mz-twin-map`, `.mz-twin-pin` + `.is-stop / .is-trip / .is-hotspot / .is-social`, `[data-locked]`; pin colour comes in via `--pin` |
| **Operator weather twin** page `/ops/twin` | `_components/FleetTwin.tsx` | `.mz-load-chart`, `.mz-load-col` (24 hourly bars), city/trip lists reuse `.mz-panel`, `.mz-list-item` |
| **New-trip form**: "Describe the trip" box, interest chips (tap = like, tap again = avoid → `data-avoid`), keyword & must-see tag inputs, "Travelling as" | `_components/TripList.tsx` | `.mz-chip[data-avoid]`, textarea uses `.mz-input` |
| **Destination suggestion cards** (blank / "anywhere" / unknown destination) | `_components/TripList.tsx` | `.mz-suggest-grid`, `.mz-suggest-card` |
| Login / sign-up **Traveller / Operator** switch | `_components/AuthForm.tsx` | chips in `.mz-auth-card` |

Design direction stays §4 of CLAUDE.md: light Flyward paper look, Apris headings, sage/amber/red states (risk bars and pins already use `--mz-sage/--mz-amber/--mz-red`). The twin panel is dense: it would benefit most from your typography and spacing, and a torn-edge divider like the simulator band.

## Mandatory hackathon items — status
1. **Live weather** ✅ Open-Meteo current + ICON/GFS ensembles (40/31 members) + archive climatology.
2. **Map visualisation** ✅ `TwinMap` (risk pins, rain field, cascade lines, social pin, fleet hotspots).
3. **Social signals** ✅ Mastodon hashtags + Lemmy + GDELT news, read into hazards by the domain model; Reddit and Bluesky block this network (403).
4. **What-if simulation** ✅ presets + sliders (rain ×, +mm/h at a chosen hour, longer storm, °C, gusts, flood); runs on copies with the real healing engine; e2e proves the trip is untouched.
5. **Nugen alignment** ⚠️ pipeline done (`scripts/nugen-align.mts`), our dataset + benchmark are uploaded and READY, but Nugen returned **HTTP 502 for training and even base-model inference** at 03:20 IST. When https://status.nugen.in is green:
   ```
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts align
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts status   # repeat until READY / early-deployable
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts deploy
   node --experimental-strip-types --env-file=.env.local scripts/nugen-align.mts eval
   ```
   then add `NUGEN_MODEL=<printed id>` to `.env.local` and restart — social-signal reading switches to the aligned model automatically (Groq stays as fallback). The key in `.env.local` is named `NUGEN_API`; both names work.

## Parth (see CLAUDE.md §10)
Weather-classes dataset in `src/data/`, Nugen benchmark review, social-source checks, docs (`docs/digital-twin.md`, `docs/nugen-alignment.md`, demo script).

## Next for Aryan (not started)
- Travel buddies (swipe to match solo travellers / join groups) — needs a new `likes/matches` collection **in the Neo4j adapter + mapping + import**, account-only publishing, 18+ attestation, block/report.
- User & operator dashboards with a Neo4j graph view of active trips (render from API data; never expose Neo4j credentials to the browser).
- Hotel specialist per city segment (multi-city trips) and an automatic morning brief from the sentinel.
- Wire Parth's `weather-impact-classes.json` into `lib/musafir/twin.ts` instead of the constants.

## Run / verify
```
npm run dev                 # dev server (one per checkout)
npm test                    # 140 unit tests, ~2 s
npm run build && npx next start -p 3107
BASE=http://localhost:3107 node --env-file=.env.local scripts/e2e-check.mjs   # 57 checks; don't loop it (OSM/OpenSky quotas)
cd whatsapp && uv run pytest -q                                              # 95 bot tests
```
