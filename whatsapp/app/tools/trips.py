"""The traveller's real Musafir trips, via the Next.js API (never a copy of trip state).

Everything that changes a trip goes through the same endpoints as the web app, so the
self-healing engine, risk tiers and operator approvals apply unchanged. Trips, stops and
action cards are numbered in the session; the model refers to numbers, never to ids.
"""

import re
from datetime import UTC, date, datetime
from typing import Any

from pydantic import BaseModel, Field, field_validator

from app.backend_client import BackendError, BackendUnavailable
from app.tools.registry import Tool, ToolContext, ToolError, register

HHMM = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
REPORTED = "Reported on WhatsApp"


async def _call(ctx: ToolContext, method: str, path: str, json: Any = None) -> dict[str, Any]:
    link = await ctx.store.get_link(ctx.phone)
    if link is None:
        raise ToolError("this WhatsApp number is not linked; offer link_musafir_account")
    try:
        return await ctx.backend.request(method, path, token=link.access_token, json=json)
    except BackendError as e:
        if e.status == 401:
            await ctx.store.delete_link(ctx.phone)
            raise ToolError("the saved sign-in expired; offer link_musafir_account again") from e
        raise ToolError(e.message) from e
    except BackendUnavailable as e:
        raise ToolError("Musafir servers are unreachable right now") from e


def _minutes(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def _clock(minutes: int) -> str:
    minutes = min(minutes, 24 * 60 - 1)
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


async def _load_trips(ctx: ToolContext) -> list[dict[str, Any]]:
    trips = (await _call(ctx, "GET", "/trips"))["trips"]
    ctx.session.trips = [
        {
            "number": i + 1,
            "id": t["id"],
            "destination": t["destination"],
            "start": t["dateRange"]["start"],
            "end": t["dateRange"]["end"],
        }
        for i, t in enumerate(trips[:10])
    ]
    return ctx.session.trips


async def _pick_trip(ctx: ToolContext, number: int | None) -> dict[str, Any]:
    trips = ctx.session.trips or await _load_trips(ctx)
    if not trips:
        raise ToolError("the user has no trips yet; offer plan_trip")
    if number is None:
        if ctx.session.trip:
            return next((t for t in trips if t["id"] == ctx.session.trip["id"]), trips[0])
        return trips[0]
    match = next((t for t in trips if t["number"] == number), None)
    if match is None:
        raise ToolError(f"there is no trip {number}; call my_trips to list them")
    return match


def _current(ctx: ToolContext) -> dict[str, Any]:
    if not ctx.session.trip:
        raise ToolError("no day is open; call show_day first")
    return ctx.session.trip


def _stop(ctx: ToolContext, number: int) -> dict[str, Any]:
    _current(ctx)
    match = next((s for s in ctx.session.stops if s["number"] == number), None)
    if match is None:
        raise ToolError(f"there is no stop {number} in the open day; call show_day again")
    return match


def _remember_day(ctx: ToolContext, trip: dict[str, Any], day: dict[str, Any]) -> list[dict]:
    stops = [
        {
            "number": i + 1,
            "id": n["id"],
            "title": n["title"],
            "start": n["timeSlot"]["start"],
            "end": _clock(_minutes(n["timeSlot"]["start"]) + n["timeSlot"]["durationMinutes"]),
            "locked_booking": n["type"] == "HARD",
        }
        for i, n in enumerate(day["nodes"])
    ]
    ctx.session.trip = {
        "id": trip["id"],
        "destination": trip["destination"],
        "day": day["dayIndex"],
        "date": day["date"],
    }
    ctx.session.stops = stops
    return stops


def _public(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{k: v for k, v in r.items() if k != "id"} for r in rows]


# ------------------------------------------------------------ reading


class NoArgs(BaseModel):
    pass


async def my_trips(ctx: ToolContext, _: NoArgs) -> dict:
    trips = await _load_trips(ctx)
    return {"trips": _public(trips)} if trips else {"trips": [], "note": "no trips yet"}


class ShowDayArgs(BaseModel):
    trip: int | None = Field(
        None, ge=1, description="Trip number from my_trips; omit for the current one"
    )
    when: date | None = Field(None, description="YYYY-MM-DD; omit for today (or the first day)")


async def show_day(ctx: ToolContext, args: ShowDayArgs) -> dict:
    trip = await _pick_trip(ctx, args.trip)
    bundle = await _call(ctx, "GET", f"/trips/{trip['id']}")
    schedule = bundle["trip"]["schedule"]
    wanted = (args.when or datetime.now(UTC).date()).isoformat()
    day = next((d for d in schedule if d["date"] == wanted), None)
    if day is None and args.when is not None:
        raise ToolError(f"{wanted} is outside this trip ({trip['start']} to {trip['end']})")
    day = day or schedule[0]
    stops = _remember_day(ctx, trip, day)
    planner = bundle.get("planner") or {}
    pending = [p for p in bundle["proposals"] if p["status"] == "PENDING"]
    return {
        "trip": trip["destination"],
        "day": day["dayIndex"],
        "date": day["date"],
        "stops": _public(stops),
        "planner": planner.get("note") if planner.get("status") == "RUNNING" else None,
        "open_action_cards": len(pending),
    }


async def show_cards(ctx: ToolContext, _: NoArgs) -> dict:
    trip = await _pick_trip(ctx, None)
    bundle = await _call(ctx, "GET", f"/trips/{trip['id']}")
    pending = [p for p in bundle["proposals"] if p["status"] == "PENDING"][:5]
    ctx.session.cards = [
        {
            "number": i + 1,
            "id": p["id"],
            "headline": p["headline"],
            "options": [
                {"number": j + 1, "id": o["id"], "label": o["label"], "you_can_apply": allowed}
                for j, (o, allowed) in enumerate(zip(p["options"], p["canDecide"], strict=False))
            ],
        }
        for i, p in enumerate(pending)
    ]
    return {
        "cards": [
            {
                "number": c["number"],
                "headline": c["headline"],
                "options": _public(c["options"]),
            }
            for c in ctx.session.cards
        ],
        "note": "options with you_can_apply=false are waiting on the traveller's operator",
    }


# ------------------------------------------------------------ changing (all need a Confirm tap)


async def _report(ctx: ToolContext, body: dict[str, Any]) -> dict:
    trip = _current(ctx)
    out = await _call(ctx, "POST", f"/trips/{trip['id']}/days/{trip['day']}/disruptions", body)
    bundle = await _call(ctx, "GET", f"/trips/{trip['id']}")
    prop = next((p for p in bundle["proposals"] if p["id"] == out["proposalId"]), None)
    day = next((d for d in bundle["trip"]["schedule"] if d["dayIndex"] == trip["day"]), None)
    if day:
        _remember_day(ctx, trip, day)
    headline = prop["headline"] if prop else "Reported"
    if out["status"] == "AUTO_APPLIED":
        outcome = f"Fixed automatically: {headline}. You can undo it in the app."
    elif prop and not any(prop["canDecide"]):
        outcome = f"{headline}. This touches a locked booking, so your operator has been asked."
    else:
        outcome = f'{headline}. I\'ve prepared options: say "show cards" to pick one.'
    return {"outcome": outcome}


class LateArgs(BaseModel):
    stop: int = Field(ge=1, description="Stop number from show_day")
    minutes: int = Field(ge=1, le=600)


async def report_late(ctx: ToolContext, args: LateArgs) -> dict:
    s = _stop(ctx, args.stop)
    return await _report(
        ctx, {"kind": "DELAY", "nodeId": s["id"], "delayMinutes": args.minutes, "reason": REPORTED}
    )


class StopArgs(BaseModel):
    stop: int = Field(ge=1, description="Stop number from show_day")


async def report_closed(ctx: ToolContext, args: StopArgs) -> dict:
    s = _stop(ctx, args.stop)
    return await _report(ctx, {"kind": "CLOSURE", "nodeId": s["id"], "reason": REPORTED})


class RainArgs(BaseModel):
    from_time: str = Field(description="HH:MM, 24-hour")
    to_time: str = Field(description="HH:MM, 24-hour")

    @field_validator("from_time", "to_time")
    @classmethod
    def _hhmm(cls, v: str) -> str:
        if not HHMM.match(v):
            raise ValueError("use HH:MM, 24-hour")
        return v


async def report_rain(ctx: ToolContext, args: RainArgs) -> dict:
    start, end = _minutes(args.from_time), _minutes(args.to_time)
    if end <= start:
        raise ToolError("the rain window must end after it starts, on the same day")
    return await _report(
        ctx, {"kind": "WEATHER", "fromMinute": start, "toMinute": end, "reason": REPORTED}
    )


class CardArgs(BaseModel):
    card: int = Field(ge=1, description="Card number from show_cards")
    option: int = Field(1, ge=1, description="Option number on that card")


def _card(ctx: ToolContext, number: int) -> dict[str, Any]:
    match = next((c for c in ctx.session.cards if c["number"] == number), None)
    if match is None:
        raise ToolError(f"there is no card {number}; call show_cards again")
    return match


async def apply_card(ctx: ToolContext, args: CardArgs) -> dict:
    card = _card(ctx, args.card)
    option = next((o for o in card["options"] if o["number"] == args.option), None)
    if option is None:
        raise ToolError(f"card {args.card} has no option {args.option}")
    if not option["you_can_apply"]:
        raise ToolError("that option needs the operator's approval; the traveller can't apply it")
    await _call(
        ctx,
        "POST",
        f"/proposals/{card['id']}/decision",
        {"decision": "APPLY", "optionId": option["id"]},
    )
    ctx.session.cards = []
    return {"applied": option["label"]}


class CardOnlyArgs(BaseModel):
    card: int = Field(ge=1, description="Card number from show_cards")


async def dismiss_card(ctx: ToolContext, args: CardOnlyArgs) -> dict:
    card = _card(ctx, args.card)
    await _call(ctx, "POST", f"/proposals/{card['id']}/decision", {"decision": "DISMISS"})
    ctx.session.cards = []
    return {"dismissed": card["headline"]}


class PlanArgs(BaseModel):
    destination: str = Field(min_length=1, max_length=120)
    start_date: date
    end_date: date


async def plan_trip(ctx: ToolContext, args: PlanArgs) -> dict:
    if args.end_date < args.start_date:
        raise ToolError("the end date must be on or after the start date")
    out = await _call(
        ctx,
        "POST",
        "/trips",
        {
            "destination": args.destination,
            "startDate": args.start_date.isoformat(),
            "endDate": args.end_date.isoformat(),
            "autoPlan": True,
        },
    )
    ctx.session.trips = []
    ctx.session.trip = None
    ctx.session.stops = []
    return {"created": bool(out.get("id")), "destination": args.destination}


# ------------------------------------------------------------ registry

register(Tool("my_trips", "List the traveller's Musafir trips, numbered.", NoArgs, my_trips))
register(
    Tool(
        "show_day",
        "Open one day of a trip: numbered stops with times, and how many action cards are open. "
        "Call this before reporting a delay, closure or rain.",
        ShowDayArgs,
        show_day,
    )
)
register(
    Tool(
        "show_cards",
        "Open action cards (fixes Musafir prepared after a disruption), numbered with options.",
        NoArgs,
        show_cards,
    )
)
register(
    Tool(
        "report_late",
        "The traveller is running late for a stop in the open day. Musafir re-plans the rest of "
        "the day (small shifts are applied automatically).",
        LateArgs,
        report_late,
        confirm="Tell Musafir you're {minutes} min late for stop {stop}?",
        confirmed_message="{outcome}",
    )
)
register(
    Tool(
        "report_closed",
        "A stop in the open day is closed. Musafir re-plans and looks for a real open "
        "alternative nearby.",
        StopArgs,
        report_closed,
        confirm="Mark stop {stop} as closed and re-plan?",
        confirmed_message="{outcome}",
    )
)
register(
    Tool(
        "report_rain",
        "It is (or will be) raining during a time window of the open day; outdoor stops are moved.",
        RainArgs,
        report_rain,
        confirm="Re-plan for rain from {from_time} to {to_time}?",
        confirmed_message="{outcome}",
    )
)
register(
    Tool(
        "apply_card",
        "Apply one option of an action card.",
        CardArgs,
        apply_card,
        confirm="Apply option {option} of card {card}?",
        confirmed_message="Done: {applied}.",
    )
)
register(
    Tool(
        "dismiss_card",
        "Dismiss an action card without changing the trip.",
        CardOnlyArgs,
        dismiss_card,
        confirm="Dismiss card {card}?",
        confirmed_message="Dismissed: {dismissed}.",
    )
)
register(
    Tool(
        "plan_trip",
        "Create a new trip; Musafir's planner drafts every day from real places.",
        PlanArgs,
        plan_trip,
        confirm="Plan a trip to {destination}, {start_date} to {end_date}?",
        confirmed_message="Planning your {destination} trip now. Ask me for day 1 in a minute.",
    )
)
