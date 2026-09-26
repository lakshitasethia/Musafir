"""The WhatsApp agent: one inbound message in, tool-grounded replies out.

Deterministic paths (commands, button taps, shared locations, rate limits) never touch the LLM.
Free text goes through a bounded Groq tool-calling loop. Only user/assistant text is kept as
history; tool traces live for one turn, and durable facts (location, numbered search results)
live in the session and are re-injected as a compact state block.
"""

import asyncio
import json
import logging
import secrets
import time
from collections import defaultdict, deque
from datetime import UTC, datetime
from typing import Any

import httpx

from app.backend_client import BackendClient
from app.channel import Inbound, Sender, to_whatsapp_markup
from app.config import Settings
from app.llm import ChatModel, LLMError
from app.store import Session, Store
from app.tools import Tool, ToolContext, ToolError, ToolResult, all_tools, get_tool

log = logging.getLogger(__name__)

TOOL_RESULT_CHARS = 6000
USER_TEXT_CHARS = 2000

SYSTEM_PROMPT = """\
You are Musafir, a travel companion that lives in WhatsApp. Travellers message you mid-trip, \
often on the move, so solve the situation instead of chatting about it.

Rules:
- Facts about weather, places, distances, travel times and the user's account come ONLY from \
tool results in this conversation. Never invent venues, opening hours, prices, times or weather. \
If a tool fails or returns nothing, say so plainly and offer the next best step.
- If you need the user's position and none is known, call request_user_location (it sends a \
one-tap button) rather than asking them to type an address.
- Handle disruptions end to end: e.g. rain -> check get_weather, then find_nearby_places with \
indoor_options, then recommend 2-3 concrete options with distance. Offer a map pin (send_place_pin) \
or travel time (get_travel_time) for the one they pick.
- Search results are numbered and remembered; refer to them by number. Users pick one by typing \
its number (they cannot tap list items).
- If a tool returns an error saying a service is unavailable, do not call it again this turn; tell the user and suggest what they can do meanwhile.
- Use place names exactly as tools and the session state spell them; never translate or rename them.
- opening_hours_osm is raw OpenStreetMap data and can be outdated: say "listed hours".
- Distances from find_nearby_places are straight-line. Only get_travel_time gives real routes.
- The traveller's Musafir trips are real: use my_trips / show_day / show_cards to read them. \
When plans break (running late, a place is closed, rain), call show_day if no day is open, then \
report_late / report_closed / report_rain. Musafir's engine re-plans the day; relay its outcome \
exactly. Never describe a change to a trip unless a tool result confirms it happened.
- Anything that changes a trip asks the user for a Confirm tap: call the tool, don't ask in text.
- Trip tools need a linked account; if it isn't linked, offer link_musafir_account.
- Bookings and payments are not available over WhatsApp: say so plainly.
- Replies are WhatsApp messages: short (under ~120 words), plain sentences, *bold* for names, \
no tables, no headings. Always reply in English, whatever language the user writes in.
"""

HELP_TEXT = (
    "*Musafir on WhatsApp*\n"
    "• Share your location (📎 → Location) and ask what's nearby\n"
    '• "Will it rain here this afternoon?"\n'
    '• "It\'s pouring, find something indoors"\n'
    '• "How long to walk to 2?" after a search\n'
    '• "Link my account" to connect your Musafir login\n'
    '• "Show today" · "I\'m 30 min late for 2" · "Stop 3 is closed" · "Show cards"\n'
    "• Send *reset* to start a fresh conversation"
)
RESET_WORDS = {"reset", "/reset", "restart", "start over", "clear"}
HELP_WORDS = {"help", "/help", "menu", "?"}
UNSUPPORTED_TEXT = (
    "I can read text messages, shared locations and button taps for now. "
    "Could you type it out or share your location instead?"
)


def _canonical_args(raw: str) -> str:
    """Same arguments in any key order or with null defaults compare equal."""
    try:
        data = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        return raw
    if not isinstance(data, dict):
        return raw
    return json.dumps({k: v for k, v in data.items() if v is not None}, sort_keys=True)


class Agent:
    def __init__(
        self,
        *,
        settings: Settings,
        store: Store,
        sender: Sender,
        llm: ChatModel | None,
        http: httpx.AsyncClient,
        backend: BackendClient,
    ) -> None:
        self.settings = settings
        self.store = store
        self.sender = sender
        self.llm = llm
        self.http = http
        self.backend = backend
        self._locks: defaultdict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._recent: defaultdict[str, deque[float]] = defaultdict(deque)

    # ------------------------------------------------------------ entry point

    async def handle(self, msg: Inbound) -> None:
        """Never raises: a failure for one message must not break the webhook or other users."""
        try:
            if not await self.store.mark_processed(msg.message_id):
                return  # Meta redelivered a message we already handled
            async with self._locks[msg.phone]:  # one message at a time per user, in order
                await self.sender.mark_read(msg.message_id)
                await self._dispatch(msg)
        except Exception:
            log.exception("failed handling message %s", msg.message_id)
            try:
                await self.sender.send_text(
                    msg.phone, "Sorry, something went wrong on my side. Please try again."
                )
            except Exception:
                log.exception("could not send failure notice")

    def _rate_limited(self, phone: str) -> bool:
        now = time.monotonic()
        window = self._recent[phone]
        while window and now - window[0] > 60:
            window.popleft()
        if len(window) >= self.settings.rate_limit_per_minute:
            return True
        window.append(now)
        return False

    async def _dispatch(self, msg: Inbound) -> None:
        session = await self.store.get_session(msg.phone)

        if msg.kind == "unsupported":
            await self.sender.send_text(msg.phone, UNSUPPORTED_TEXT)
            return

        if msg.kind == "button" and msg.button_id and msg.button_id.startswith("pa:"):
            await self._handle_confirmation(session, msg.button_id)
            await self.store.save_session(session)
            return

        if msg.kind == "text" and (msg.text or "").strip().lower() in RESET_WORDS:
            await self.store.clear_session(msg.phone)
            await self.sender.send_text(msg.phone, "Fresh start. What do you need?")
            return
        if msg.kind == "text" and (msg.text or "").strip().lower() in HELP_WORDS:
            await self.sender.send_text(msg.phone, HELP_TEXT)
            return

        if self._rate_limited(msg.phone):
            await self.sender.send_text(
                msg.phone, "You're sending messages faster than I can keep up. Give me a minute."
            )
            return

        if msg.kind == "location" and msg.location:
            loc = msg.location
            label = loc.name or loc.address or "your shared location"
            session.location = {"lat": loc.lat, "lng": loc.lng, "label": label, "at": time.time()}
            user_text = (
                f'[I shared my location, named exactly "{label}" ({loc.lat:.5f}, {loc.lng:.5f})]'
                + (f" {loc.address}" if loc.address and loc.address != label else "")
            )
        else:
            user_text = (msg.text or "").strip()[:USER_TEXT_CHARS]

        # a new message means any unanswered confirmation is abandoned
        session.pending = None
        reply = await self._run_llm(session, user_text, msg.profile_name)
        if reply:
            await self.sender.send_text(msg.phone, reply)
        self._remember(session, user_text, reply)
        await self.store.save_session(session)

    # ------------------------------------------------------------ confirmations

    async def _handle_confirmation(self, session: Session, button_id: str) -> None:
        _, token, choice = (button_id.split(":", 2) + ["", ""])[:3]
        pending = session.pending
        if not pending or pending.get("token") != token:
            await self.sender.send_text(
                session.phone, "That button has expired. Tell me again what you'd like to do."
            )
            return
        session.pending = None
        if choice != "yes":
            await self.sender.send_text(session.phone, "Okay, cancelled.")
            self._remember(session, f"[Tapped Cancel on: {pending['prompt']}]", "Okay, cancelled.")
            return

        tool = get_tool(pending["tool"])
        if tool is None:
            await self.sender.send_text(session.phone, "That action is no longer available.")
            return
        try:
            result = await self._execute(tool, tool.parse(pending["args"]), session)
        except ToolError as e:
            await self.sender.send_text(session.phone, f"I couldn't do that: {e}")
            return
        text = tool.confirmed_message or "Done."
        try:
            text = text.format(**result.data)
        except (KeyError, IndexError, ValueError):
            pass
        await self.sender.send_text(session.phone, text)
        self._remember(session, f"[Tapped Confirm on: {pending['prompt']}]", text)

    async def _ask_confirmation(self, session: Session, tool: Tool, args: Any) -> dict:
        prompt = tool.confirm or f"Run {tool.name}?"
        try:
            prompt = prompt.format(**args.model_dump())
        except (KeyError, IndexError, ValueError):
            pass
        token = secrets.token_hex(4)
        session.pending = {
            "token": token,
            "tool": tool.name,
            "args": args.model_dump(mode="json"),
            "prompt": prompt,
        }
        await self.sender.send_buttons(
            session.phone, prompt, [(f"pa:{token}:yes", "Confirm"), (f"pa:{token}:no", "Cancel")]
        )
        return {"status": "asked the user to confirm with a button; wait for their tap"}

    # ------------------------------------------------------------ LLM loop

    def _context(self, session: Session) -> ToolContext:
        return ToolContext(
            session=session,
            store=self.store,
            sender=self.sender,
            http=self.http,
            backend=self.backend,
            settings=self.settings,
        )

    async def _execute(self, tool: Tool, args: Any, session: Session) -> ToolResult:
        out = await tool.run(self._context(session), args)
        return out if isinstance(out, ToolResult) else ToolResult(out)

    async def _state_block(self, session: Session, profile_name: str | None) -> str:
        lines = [f"Current UTC time: {datetime.now(UTC).strftime('%Y-%m-%d %H:%M')}"]
        if profile_name:
            lines.append(f"User's WhatsApp name: {profile_name}")
        link = await self.store.get_link(session.phone)
        lines.append(
            f"Musafir account: linked ({link.email})" if link else "Musafir account: not linked"
        )
        if session.location:
            age = int((time.time() - session.location.get("at", time.time())) / 60)
            lines.append(
                f"User location: {session.location.get('label')} "
                f"({session.location['lat']:.5f}, {session.location['lng']:.5f}), "
                f"shared {age} min ago" + (" (may be stale; ask to reshare)" if age > 180 else "")
            )
        else:
            lines.append("User location: unknown")
        if session.trip:
            t = session.trip
            lines.append(
                f"Open trip day: {t['destination']}, day {t['day']} ({t['date']}), "
                f"{len(session.stops)} stops"
            )
        if session.places:
            listed = "; ".join(f"{p['number']}. {p['name']}" for p in session.places)
            lines.append(f"Last numbered results: {listed}")
        return "Session state:\n" + "\n".join(lines)

    async def _run_llm(self, session: Session, user_text: str, profile_name: str | None) -> str:
        if self.llm is None:
            return (
                "My AI brain isn't configured yet (GROQ_API_KEY is missing). "
                "Send *help* to see what I'll be able to do."
            )
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "system", "content": await self._state_block(session, profile_name)},
            *session.history[-self.settings.history_messages :],
            {"role": "user", "content": user_text},
        ]
        schemas = [t.schema() for t in all_tools()]

        seen_calls: dict[tuple[str, str], dict] = {}
        for _ in range(self.settings.max_tool_rounds):
            try:
                completion = await self.llm.complete(messages, schemas)
            except LLMError as e:
                if not e.invalid_tool_call:
                    return self._llm_error_reply(e)
                # show the model why its call was rejected and let it try again (uses a round)
                log.info("invalid tool call, letting the model correct it: %s", e)
                messages.append(
                    {
                        "role": "system",
                        "content": f"Your last tool call was rejected: {e}. Call the tool again "
                        "with valid arguments, or answer without it.",
                    }
                )
                continue

            if not completion.tool_calls:
                return to_whatsapp_markup(completion.content or "")

            messages.append(completion.as_message())
            ends_turn = False
            for call in completion.tool_calls:
                key = (call.name, _canonical_args(call.arguments))
                if key in seen_calls:
                    # models sometimes loop on the same call; the answer won't change this turn
                    data, stop = {"repeated_call": True, "previous_result": seen_calls[key]}, False
                else:
                    data, stop = await self._call_tool(session, call.name, call.arguments)
                    seen_calls[key] = data
                ends_turn = ends_turn or stop
                content = json.dumps(data, ensure_ascii=False, default=str)
                if len(content) > TOOL_RESULT_CHARS:
                    content = json.dumps(
                        {"error": "result too large; narrow the request (smaller radius/hours)"}
                    )
                messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
            if ends_turn:
                # the tool already sent the user a message (button/link); don't pile on
                return ""

        log.warning("tool loop limit hit for %s", session.phone)
        # out of tool rounds: answer with whatever the tool results already show
        messages.append(
            {
                "role": "system",
                "content": "No more tool calls are allowed. Reply to the user now using only "
                "the tool results above; say plainly what you could not find out.",
            }
        )
        try:
            final = await self.llm.complete(messages, [])
        except LLMError as e:
            return self._llm_error_reply(e)
        if final.content and not final.tool_calls:
            return to_whatsapp_markup(final.content)
        return "That took more steps than I expected. Could you ask in a simpler way?"

    @staticmethod
    def _llm_error_reply(e: LLMError) -> str:
        log.warning("llm error: %s", e)
        if e.rate_limited:
            return "I'm getting a lot of requests right now. Please try again in a minute."
        return "I'm having trouble thinking right now. Please try again in a moment."

    async def _call_tool(self, session: Session, name: str, raw_args: str) -> tuple[dict, bool]:
        tool = get_tool(name)
        if tool is None:
            known = ", ".join(t.name for t in all_tools())
            return {"error": f"unknown tool {name!r}; available: {known}"}, False
        try:
            args = tool.parse(raw_args)
            if tool.confirm:
                return await self._ask_confirmation(session, tool, args), True
            result = await self._execute(tool, args, session)
            return result.data, result.ends_turn
        except ToolError as e:
            return {"error": str(e)}, False
        except Exception:
            log.exception("tool %s crashed", name)
            return {"error": f"{name} failed unexpectedly"}, False

    def _remember(self, session: Session, user_text: str, reply: str) -> None:
        session.history.append({"role": "user", "content": user_text})
        # an empty reply means a tool messaged the user directly
        session.history.append(
            {"role": "assistant", "content": reply or "(sent the user an interactive message)"}
        )
        session.history = session.history[-self.settings.history_messages :]
