"""Travel time via the public FOSSGIS OSRM servers (free, no key)."""

from enum import StrEnum
from typing import Annotated, Any

import httpx
from pydantic import BaseModel, BeforeValidator, Field, WithJsonSchema, model_validator

from app.tools.geo import Point, geocode, haversine_m, resolve_point, round_distance
from app.tools.places import place_by_number
from app.tools.registry import Tool, ToolContext, register


class Mode(StrEnum):
    walk = "walk"
    drive = "drive"
    bike = "bike"


OSRM_PROFILE = {Mode.walk: "routed-foot", Mode.drive: "routed-car", Mode.bike: "routed-bike"}
MODE_ALIASES = {
    **{a: Mode.walk for a in ("walking", "foot", "on foot", "stroll")},
    **{a: Mode.drive for a in (
        "driving", "car", "cab", "taxi", "auto", "rickshaw", "auto rickshaw", "uber", "ola",
        "bus", "road",
    )},
    **{a: Mode.bike for a in ("cycle", "cycling", "bicycle", "bike ride", "scooter")},
}  # fmt: skip


def parse_mode(value: Any) -> Mode:
    if value is None:
        return Mode.walk
    if isinstance(value, Mode):
        return value
    text = " ".join(str(value).lower().split())
    if text in Mode.__members__:
        return Mode(text)
    if text in MODE_ALIASES:
        return MODE_ALIASES[text]
    raise ValueError(f"unknown mode {value!r}; use walk, drive or bike")


ModeArg = Annotated[
    Mode,
    BeforeValidator(parse_mode),
    WithJsonSchema({"type": "string", "description": "walk, drive or bike (default walk)"}),
]


class TravelArgs(BaseModel):
    to_result_number: int | None = Field(
        default=None, ge=1, description="Destination as a number from the last place search"
    )
    to_place: str | None = Field(default=None, description="Destination as a place name")
    from_place: str | None = Field(
        default=None, description="Start place name. Omit to start from the user's location."
    )
    mode: ModeArg = Mode.walk

    @model_validator(mode="after")
    def one_destination(self) -> "TravelArgs":
        if (self.to_result_number is None) == (not self.to_place):
            raise ValueError("give exactly one of to_result_number or to_place")
        return self


async def get_travel_time(ctx: ToolContext, args: TravelArgs) -> dict:
    origin = await resolve_point(ctx, args.from_place)
    if args.to_result_number is not None:
        p = place_by_number(ctx, args.to_result_number)
        dest = Point(p["lat"], p["lng"], p["name"])
    else:
        dest = await geocode(ctx, args.to_place or "")

    straight = round_distance(haversine_m(origin.lat, origin.lng, dest.lat, dest.lng))
    base = {
        "from": origin.label,
        "to": dest.label,
        "mode": args.mode.value,
        "straight_line_m": straight,
    }
    url = (
        f"{ctx.settings.osrm_url}/{OSRM_PROFILE[args.mode]}/route/v1/driving/"
        f"{origin.lng:.6f},{origin.lat:.6f};{dest.lng:.6f},{dest.lat:.6f}"
    )
    try:
        r = await ctx.http.get(url, params={"overview": "false"}, timeout=12)
        data = r.json()
        route = data["routes"][0] if data.get("code") == "Ok" else None
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        route = None
    if route is None:
        # never estimate a duration we didn't get from the router
        return base | {
            "route_available": False,
            "note": "routing service gave no route; only the straight-line distance is known",
        }
    return base | {
        "route_available": True,
        "duration_min": max(1, round(route["duration"] / 60)),
        "route_distance_m": round_distance(route["distance"]),
    }


register(
    Tool(
        name="get_travel_time",
        description="Real routed travel time and distance (walk, drive or bike) from the user's "
        "location or a named place to a numbered result or a named place.",
        args=TravelArgs,
        run=get_travel_time,
    )
)
