# Musafir on WhatsApp

A standalone service that lets travellers use Musafir from WhatsApp. Messages arrive via the
**WhatsApp Cloud API** webhook, a **Groq** tool-calling agent (default `openai/gpt-oss-120b`, with automatic fallback to other models) works out what to do,
and replies go back as WhatsApp text, map pins, "send location" buttons and one-tap Confirm/Cancel
buttons.

It is self-contained: its own dependencies, its own SQLite file, and it only talks to the Musafir
backend (`../backend`) over its public HTTP API. Nothing outside this folder is touched.

Everything it uses is free: WhatsApp replies to user-initiated chats, Groq's free tier, Open-Meteo,
OpenStreetMap (Overpass + Nominatim) and the FOSSGIS OSRM routers.

## What the agent can do

| Tool | Source | Notes |
|---|---|---|
| `get_weather` | Open-Meteo | Current conditions + hourly rain chance; flags `wet_hours` |
| `find_nearby_places` | Overpass (OSM), Nominatim fallback | 22 categories (incl. `food`, `medical`, `indoor_options`) plus everyday words like "medicine" or "washroom"; auto-widens an empty search once, then tries related places (pharmacy → clinics/hospitals); numbered, nearest first |
| `get_travel_time` | OSRM | Real routed walk/drive/bike time. If routing fails it reports only straight-line distance, never a guessed duration |
| `send_place_pin` | — | Native WhatsApp map pin for result *n* |
| `request_user_location` | — | One-tap "Send location" button |
| `set_current_location` | Nominatim | "I'm at Hawa Mahal" without GPS |
| `link_musafir_account` | backend `/auth/*` | Sends a one-time private link; password is typed on a web page, never in chat |
| `get_my_account` | backend `/auth/me` | Detects expired tokens and unlinks |
| `unlink_musafir_account` | — | Requires a Confirm tap before it runs |

Adding a tool: write a module in `app/tools/` that calls `register(Tool(...))` with a Pydantic args
model, and import it in `app/tools/__init__.py`. Set `confirm="..."` for anything that changes
state, and the agent will ask for a Confirm tap first. Trip and booking tools can be added the same
way once the backend has those endpoints. Until then the agent tells users trips can't be changed
over WhatsApp yet.

### How a message flows
1. `POST /webhook` checks the `X-Hub-Signature-256` signature, returns 200 straight away, and
   handles the message in the background.
2. Redelivered message ids are ignored, and each phone's messages are handled one at a time.
3. Commands (`help`, `reset`), shared locations, button taps and unsupported media are handled
   without calling the LLM, and each phone is rate-limited.
4. Free text goes to a tool-calling loop capped at `MAX_TOOL_ROUNDS` rounds. Bad arguments,
   unknown tools and crashing tools come back to the model as errors, so one bad call doesn't end
   the turn.
5. Only user and assistant text is kept as history. The shared location and numbered search
   results are stored with the session and added to each prompt in a short state block.

## Run it

```bash
cd whatsapp
uv sync
cp .env.example .env          # fill in GROQ_API_KEY at minimum
uv run uvicorn app.main:app --port 8100 --reload
```

With no WhatsApp credentials, outbound messages are written to the log, so the service still works.

### Try the agent in your terminal (no Meta setup needed)

```bash
uv run python -m scripts.chat
you> /loc 26.9239,75.8267 Hawa Mahal
you> it's starting to pour, what can I do indoors nearby?
you> how long to walk to 1?
```

### Connect real WhatsApp (Meta Cloud API, free test number)

1. <https://developers.facebook.com> → **Create app** → Business → add the **WhatsApp** product.
2. **WhatsApp → API Setup**: copy the *temporary access token* (valid 24 h) and the *Phone number
   ID* into `.env`. Add your own phone under "To" as a test recipient.
3. **App settings → Basic**: copy the *App secret* into `WHATSAPP_APP_SECRET`.
4. Expose the service over HTTPS (either works, both free):
   `cloudflared tunnel --url http://localhost:8100` or `ngrok http 8100`.
   Put that URL in `PUBLIC_BASE_URL` (used for account-link pages) and restart.
5. **WhatsApp → Configuration → Webhook**: callback `https://<tunnel>/webhook`, verify token
   = your `WHATSAPP_VERIFY_TOKEN`, then **subscribe to the `messages` field**.
6. Message the test number from your phone.

For account linking, run the backend too (`cd ../backend && make up && make migrate`) and make sure
`MUSAFIR_API_URL` points at it.

For more than a demo, create a permanent System User token in Business Settings. The temporary
token expires every 24 hours.

## Tests

```bash
uv run pytest        # offline: Meta, Groq, OSM and the backend are all mocked
uv run ruff check . && uv run ruff format --check .
```
