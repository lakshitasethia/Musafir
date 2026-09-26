# Musafir demo script

A 6-minute judge demo of what is **built on `main` today**. Two browsers side by side: the **traveller** on a phone (or a narrow window) and the **operator** on a laptop. Every button name below is the label in the current UI. If a label changes, update this file.

## Before the demo (T − 15 min)

1. Run `npm run dev` on the demo machine (or open the Vercel preview), and open it on the phone over the same Wi-Fi.
2. Create two accounts at `/signup`:
   - **Traveller:** "I'm travelling"
   - **Operator:** "I'm an operator". Needs `OPERATOR_INVITE_CODE` if it's set; sign-up is open in dev.
3. As the traveller, create the demo trip (see below) **the day before**. The planner calls OpenStreetMap live, so warm it up once.
4. Open `/ops` as the operator and leave it on screen.
5. Check the network:
   - Place search is serialized at 1 request/second (Nominatim policy), and **Overpass may be blocked** on venue Wi-Fi. If it is, venues come from Nominatim, which is slower and has fewer tags.
   - Have a phone hotspot ready.
6. **No LLM key?** Ranking falls back to distance, and the card says so ("AI ranking unavailable: …"). That's honest, so it's fine to show.

**Demo trip:** destination *Jaipur*, dates = 3 days starting within the next 16 days (so the live forecast works), dietary needs *vegetarian*.

## 0:00 — The problem (20 s)
"Itineraries break on day one: a late train, a closed venue, rain. Chat assistants make you type paragraphs in the rain. Musafir fixes the day for you and asks for one tap only when it has to."

## 0:20 — Plan with faders, not prompts (60 s)
1. Traveller → **New trip** → *Where to?* "Jaipur", the dates, dietary "vegetarian".
2. Drag the **Vibe equalizer** faders: *Pacing* (Café loiterer ↔ marathon), *Budget* (Street food & transit ↔ Tasting menus & cabs), *Atmosphere* (Iconic landmarks ↔ Underground & local), *Rhythm* (Early dawn ↔ Night owl).
3. **Plan my trip.** Say: "the planner pulls real places from OpenStreetMap; code clusters, orders and times them; the AI may only re-rank what code fetched."
4. Show the journey graph:
   - real venues, numbered markers
   - legs coloured by commute band: sage < 15 min, amber 15–35, red > 35
   - "tight" warnings

## 1:20 — Direct edits (30 s)
1. Drag a flexible stop later. Tap a stop and edit it.
2. Point at a **Reserved** stop: "locked bookings never move; only the operator can touch them."

## 1:50 — Small delay heals itself (45 s)
1. Scroll to **Disruption simulator**. Pick the first stop, choose **+15**, press **Delay 15 min**.
2. The card says **"Handled automatically — undo from the card"**.
3. Say: "within the trip's automatic limits (30 min by default, no extra cost) it just happens, and it's undoable."
4. Tap undo to show it.

## 2:35 — Bigger disruption needs one tap (60 s)
1. Pick a flexible stop and press **Venue closed**.
2. A **Traveller's call** card appears:
   - the engine's fix (skip or shift), with **Preview** showing the diff
   - a few seconds later, an **agent** option: a real venue within 800 m, with the rationale and how it was ranked
3. **Apply** the agent option. The graph updates live on both screens (SSE).

## 3:35 — Locked booking → operator (60 s)
1. Pick a **locked** stop (it shows *(locked)* in the Stop list) and press **Delay 60 min**.
2. The traveller sees **Needs your operator**. The operator console shows it in the queue with a reply-by deadline.
3. The operator presses **Approve** (or **Acknowledge** for notice-only cards).
4. Mention **escalation**: if the operator misses the deadline, escalatable items fall back to the traveller ("Operator didn't respond — your call").

## 4:35 — Real weather (45 s)
1. Press **Check live forecast**. It calls Open-Meteo for the day's stops.
   - Rain over outdoor stops raises a card.
   - Otherwise: "No rain in the forecast for this day."
2. If the sky is clear, use the simulator: **Rain from** 14:00 **until** 16:00 → **Rain**. Outdoor stops move after the rain window, and the agent offers an indoor venue.

## 5:20 — Trust and safety (40 s)
- "Every card is re-checked on the server: feasibility, locked bookings, risk tier. Hiding a button is never authorization."
- "Stale cards are never forced. If the plan changed, the card is marked **Out of date — the plan changed**."
- "Nothing is invented: unknown prices say *unknown*, and unmatched dietary tags say *unverified*."

## 6:00 — Close
"Musafir heals the day and taps you only when it must."

---

## If something breaks

| Symptom | Say / do |
|---|---|
| Planner slow / "Planner starting…" for long | Nominatim is rate-limited to 1 request per second. Keep talking; it's the honest free tier. Use the pre-made trip. |
| Agent option never appears | The OSM services may be blocked. The engine option still works; point out the agent note on the card. |
| Forecast says unavailable | The day is more than 16 days away or Open-Meteo is down. Use the **Rain** simulator. |
| Phone shows "Reconnecting" | Wi-Fi dropped. The page refetches on reconnect; switch to the hotspot. |
| `409` toast after an edit | Someone else changed the trip. It refreshes automatically; that's optimistic concurrency working. |
