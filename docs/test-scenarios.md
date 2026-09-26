# Musafir test scenarios

Manual and real-phone QA passes (owner: Parth). Automated unit tests live next to the code (`npm test`); these scenarios cover what they can't: real browsers, real phones, real network conditions and two personas at once.

**How to report:**
- File one issue per failure: the scenario ID, device + browser, what you expected, what happened, and a screenshot or screen recording.
- Record the commit hash you tested.

**Devices, minimum pass:**
- one Android phone (Chrome)
- one iPhone (Safari)
- one laptop (Chrome)

Test at about 390 px wide.

---

## A. Auth & gates

| ID | Steps | Expected |
|---|---|---|
| A1 | Sign up as traveller with a fresh email | Lands on `/trip`; the session survives a reload |
| A2 | Sign up again with the same email | "An account with this email already exists" |
| A3 | Log in with a wrong password | "Wrong email or password"; no hint about which part was wrong |
| A4 | While logged out, open `/trip`, `/ops` and `/trip/<id>` directly | Redirected to log in; no trip data flashes on screen |
| A5 | As a traveller, open `/ops` | Blocked (not an empty console) |
| A6 | As traveller B, open traveller A's `/trip/<id>` | "Trip not found" (existence isn't revealed) |
| A7 | Operator sign-up with a wrong invite code (when `OPERATOR_INVITE_CODE` is set) | "Invalid operator invite code" |

## B. Trip creation & planner

| ID | Steps | Expected |
|---|---|---|
| B1 | New trip: Jaipur, 3 days, default faders, **Plan my trip** | Planner status shows live, then each day fills with real venues |
| B2 | End date before start date | Clear validation error; nothing is created |
| B3 | A 31-day trip | "Trips can be at most 30 days" |
| B4 | Press **Plan my trip** twice quickly | The second press gets "The planner is already working on this trip" |
| B5 | Plan when every day already has stops | "Every day already has stops — clear a day to re-plan it" |
| B6 | Pacing at minimum vs maximum on two new trips | Fewer stops/day at minimum (≈2) than at maximum (≈6) |
| B7 | A nonsense destination ("zzqqxx") | A calm "no places found" note; no crash, no invented stops |

## C. Journey graph & direct edits

| ID | Steps | Expected |
|---|---|---|
| C1 | Drag a flexible stop 30 min later | It moves; later stops don't overlap; the version bumps |
| C2 | Try to drag a **Reserved** (locked) stop as a traveller | It doesn't move (touch-action only on flexible stops) |
| C3 | Keyboard: focus a stop and use arrow keys | It shifts in steps; focus stays visible |
| C4 | Edit a stop to end after 23:59 | Rejected with a clear message, not wrapped to the next day |
| C5 | Two tabs: edit in tab 1, then edit in tab 2 without reloading | Tab 2 gets a "trip changed" message and refreshes; nothing is silently overwritten |
| C6 | **Add a stop** → search "Hawa Mahal" | Results appear after submit (not on every keystroke); adding works |
| C7 | Phone: every tap target | At least 44 px; inputs don't zoom on iOS |

## D. Self-healing & cards

| ID | Steps | Expected |
|---|---|---|
| D1 | Delay the first flexible stop +15 | Auto-applied ("Handled automatically — undo from the card"); Undo restores it |
| D2 | Delay +90 | A traveller card with a preview diff; nothing changes until **Apply** |
| D3 | **Venue closed** on a flexible stop | Engine option first; an agent option (real venue ≤ 800 m) appears within seconds, with its rationale |
| D4 | Delay a **locked** stop +60 | "Needs your operator" for the traveller; appears in `/ops` with a deadline |
| D5 | Leave D4 unanswered past the deadline (set **Reply within** to 1 min) | Shows "Operator didn't respond — your call"; the traveller can decide if escalatable |
| D6 | Apply an old card after editing the day | "Out of date — the plan changed"; the plan is not changed |
| D7 | Undo a card after a later change | "Later changes were made on top of this; undo those first" |
| D8 | Rain simulator 14:00–16:00 on a day with outdoor stops | Outdoor stops move out of the window; locked outdoor stops go to the operator |
| D9 | Rain with `until` earlier than `from` | The Rain button is disabled or the input is rejected |

## E. Live updates (two devices)

| ID | Steps | Expected |
|---|---|---|
| E1 | Traveller phone + operator laptop; apply a card on the laptop | The phone updates within ~2 s without a reload |
| E2 | Put the phone in airplane mode for 30 s, then back online | Shows "Reconnecting", then "Live"; the data is current |
| E3 | Leave the page open for 5 min | Still live (heartbeats keep the stream open) |

## F. Weather (real Open-Meteo)

| ID | Steps | Expected |
|---|---|---|
| F1 | **Check live forecast** on a day within 16 days | "No rain…", or cards for rain over outdoor stops |
| F2 | Same on a day more than 16 days away | "Forecast unavailable: forecasts only reach 16 days ahead…" |
| F3 | Same on an empty day | "Add stops first…" |

## G. Honesty checks (anywhere)

| ID | Check | Expected |
|---|---|---|
| G1 | Any stop's cost | Unknown prices say unknown, never "₹0 / free" |
| G2 | Any dietary info | "unverified" when OSM has no tag; never "safe" |
| G3 | Any opening hours | Raw or "unknown", never guessed |
| G4 | Run without `GROQ_API_KEY` | Agent options say they were ranked by distance, and why |

## H. Auditors and datasets (automated)

Covered by `npm test`: `src/lib/musafir/auditors/*.test.ts` and `src/data/datasets.test.ts`. Once auditor warnings are wired into the UI, add manual checks here:
- **Heat or UV findings:** on a hot-day trip, the finding sits on the outdoor stop.
- **Diet label:** shown for a vegetarian traveller.
- **Budget:** the total says "minimum" while prices are unknown.
