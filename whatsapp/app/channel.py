"""WhatsApp Cloud API: webhook parsing, signature check, outbound senders, text formatting."""

import hashlib
import hmac
import logging
import re
from dataclasses import dataclass
from typing import Any, Literal, Protocol

import httpx

log = logging.getLogger(__name__)

TEXT_LIMIT = 4096
INTERACTIVE_BODY_LIMIT = 1024
BUTTON_TITLE_LIMIT = 20
MAX_BUTTONS = 3


# ---------------------------------------------------------------- inbound


@dataclass(frozen=True)
class Location:
    lat: float
    lng: float
    name: str | None = None
    address: str | None = None


@dataclass(frozen=True)
class Inbound:
    message_id: str
    phone: str  # sender's wa_id, also the address we reply to
    kind: Literal["text", "location", "button", "unsupported"]
    profile_name: str | None = None
    text: str | None = None
    button_id: str | None = None
    location: Location | None = None
    raw_type: str | None = None


def verify_signature(app_secret: str, body: bytes, header: str | None) -> bool:
    """Checks Meta's X-Hub-Signature-256 (`sha256=<hex hmac of raw body>`)."""
    if not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))


def _as_float(value: Any) -> float | None:
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if f == f else None  # drop NaN


def _parse_message(msg: dict[str, Any], names: dict[str, str]) -> Inbound | None:
    message_id, phone, mtype = msg.get("id"), msg.get("from"), msg.get("type")
    if not isinstance(message_id, str) or not isinstance(phone, str) or not phone:
        return None
    base = {"message_id": message_id, "phone": phone, "profile_name": names.get(phone)}

    if mtype == "text":
        body = (msg.get("text") or {}).get("body")
        if isinstance(body, str) and body.strip():
            return Inbound(kind="text", text=body.strip(), **base)
    elif mtype == "location":
        loc = msg.get("location") or {}
        lat, lng = _as_float(loc.get("latitude")), _as_float(loc.get("longitude"))
        if lat is not None and lng is not None and -90 <= lat <= 90 and -180 <= lng <= 180:
            location = Location(lat, lng, loc.get("name"), loc.get("address"))
            return Inbound(kind="location", location=location, **base)
    elif mtype == "interactive":
        inter = msg.get("interactive") or {}
        reply = inter.get("button_reply") or inter.get("list_reply") or {}
        if reply.get("id"):
            return Inbound(kind="button", button_id=reply["id"], text=reply.get("title"), **base)
    elif mtype == "button":  # quick-reply on a template message
        btn = msg.get("button") or {}
        if btn.get("payload") or btn.get("text"):
            return Inbound(
                kind="button", button_id=btn.get("payload") or "", text=btn.get("text"), **base
            )
    return Inbound(kind="unsupported", raw_type=str(mtype), **base)


def parse_webhook(payload: Any) -> list[Inbound]:
    """Every user message in a webhook body. Status callbacks and junk are ignored."""
    out: list[Inbound] = []
    if not isinstance(payload, dict):
        return out
    for entry in payload.get("entry") or []:
        for change in (entry or {}).get("changes") or []:
            if (change or {}).get("field") != "messages":
                continue
            value = change.get("value") or {}
            names = {
                c.get("wa_id"): (c.get("profile") or {}).get("name")
                for c in value.get("contacts") or []
                if isinstance(c, dict)
            }
            for msg in value.get("messages") or []:
                if isinstance(msg, dict) and (parsed := _parse_message(msg, names)):
                    out.append(parsed)
    return out


# ---------------------------------------------------------------- formatting


def to_whatsapp_markup(text: str) -> str:
    """LLMs write Markdown; WhatsApp uses *bold* _italic_ and has no headings or links."""
    text = re.sub(r"\*\*(.+?)\*\*", r"*\1*", text)
    text = re.sub(r"__(.+?)__", r"_\1_", text)
    text = re.sub(r"^#{1,6}\s*(.+)$", r"*\1*", text, flags=re.MULTILINE)
    text = re.sub(r"\[([^\]]+)\]\((https?://[^)\s]+)\)", r"\1: \2", text)
    return text.strip()


def split_text(text: str, limit: int = TEXT_LIMIT) -> list[str]:
    """Split on paragraph, then line, then word boundaries so no chunk exceeds `limit`."""
    chunks: list[str] = []
    rest = text.strip()
    while len(rest) > limit:
        window = rest[:limit]
        cut = max(window.rfind("\n\n"), window.rfind("\n"), window.rfind(" "))
        if cut <= 0:
            cut = limit
        chunks.append(rest[:cut].rstrip())
        rest = rest[cut:].lstrip()
    if rest:
        chunks.append(rest)
    return chunks


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# ---------------------------------------------------------------- outbound


class SendError(Exception):
    pass


class Sender(Protocol):
    async def send_text(self, to: str, body: str) -> None: ...
    async def send_buttons(self, to: str, body: str, buttons: list[tuple[str, str]]) -> None: ...
    async def send_location(
        self, to: str, lat: float, lng: float, name: str, address: str
    ) -> None: ...
    async def request_location(self, to: str, body: str) -> None: ...
    async def mark_read(self, message_id: str) -> None: ...


class WhatsAppClient:
    def __init__(
        self, http: httpx.AsyncClient, token: str, phone_number_id: str, api_version: str
    ) -> None:
        self._http = http
        self._url = f"https://graph.facebook.com/{api_version}/{phone_number_id}/messages"
        self._headers = {"Authorization": f"Bearer {token}"}

    async def _post(self, payload: dict[str, Any]) -> None:
        for attempt in range(2):
            try:
                r = await self._http.post(
                    self._url, json=payload, headers=self._headers, timeout=15
                )
            except httpx.HTTPError as e:
                if attempt == 0:
                    continue
                raise SendError(f"WhatsApp API unreachable: {e}") from e
            if r.status_code < 400:
                return
            if (r.status_code == 429 or r.status_code >= 500) and attempt == 0:
                continue
            raise SendError(f"WhatsApp API {r.status_code}: {r.text[:500]}")

    async def _message(self, to: str, mtype: str, body: dict[str, Any]) -> None:
        await self._post(
            {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": to,
                "type": mtype,
                mtype: body,
            }
        )

    async def send_text(self, to: str, body: str) -> None:
        for chunk in split_text(body):
            await self._message(to, "text", {"preview_url": True, "body": chunk})

    async def send_buttons(self, to: str, body: str, buttons: list[tuple[str, str]]) -> None:
        await self._message(
            to,
            "interactive",
            {
                "type": "button",
                "body": {"text": _clip(body, INTERACTIVE_BODY_LIMIT)},
                "action": {
                    "buttons": [
                        {
                            "type": "reply",
                            "reply": {"id": bid, "title": _clip(t, BUTTON_TITLE_LIMIT)},
                        }
                        for bid, t in buttons[:MAX_BUTTONS]
                    ]
                },
            },
        )

    async def send_location(self, to: str, lat: float, lng: float, name: str, address: str) -> None:
        await self._message(
            to, "location", {"latitude": lat, "longitude": lng, "name": name, "address": address}
        )

    async def request_location(self, to: str, body: str) -> None:
        await self._message(
            to,
            "interactive",
            {
                "type": "location_request_message",
                "body": {"text": _clip(body, INTERACTIVE_BODY_LIMIT)},
                "action": {"name": "send_location"},
            },
        )

    async def mark_read(self, message_id: str) -> None:
        """Blue ticks + typing indicator while the agent works. Cosmetic, so never raises."""
        try:
            await self._post(
                {
                    "messaging_product": "whatsapp",
                    "status": "read",
                    "message_id": message_id,
                    "typing_indicator": {"type": "text"},
                }
            )
        except SendError as e:
            log.info("mark_read failed: %s", e)


@dataclass
class Outgoing:
    to: str
    kind: str
    body: str
    extra: dict[str, Any]


class RecordingSender:
    """Keeps outbound messages in memory. Used when Meta isn't configured, by tests and the CLI."""

    def __init__(self, echo: bool = False) -> None:
        self.sent: list[Outgoing] = []
        self.echo = echo

    def _add(self, out: Outgoing) -> None:
        self.sent.append(out)
        if self.echo:
            extra = f"  {out.extra}" if out.extra else ""
            print(f"\n[{out.kind} → {out.to}]\n{out.body}{extra}\n")
        else:
            log.info("outbound (WhatsApp not configured) %s → %s: %s", out.kind, out.to, out.body)

    async def send_text(self, to: str, body: str) -> None:
        for chunk in split_text(body):
            self._add(Outgoing(to, "text", chunk, {}))

    async def send_buttons(self, to: str, body: str, buttons: list[tuple[str, str]]) -> None:
        self._add(Outgoing(to, "buttons", body, {"buttons": buttons[:MAX_BUTTONS]}))

    async def send_location(self, to: str, lat: float, lng: float, name: str, address: str) -> None:
        self._add(Outgoing(to, "location", name, {"lat": lat, "lng": lng, "address": address}))

    async def request_location(self, to: str, body: str) -> None:
        self._add(Outgoing(to, "location_request", body, {}))

    async def mark_read(self, message_id: str) -> None:
        pass
