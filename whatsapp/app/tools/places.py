"""Nearby places from OpenStreetMap (free, no key). Distances are haversine.

Overpass is the primary source. Public Overpass instances are often overloaded or unreachable
from some networks, so after a failure we fall back to Nominatim's category search and stop
trying Overpass for a few minutes.
"""

import logging
import math
import time
from enum import StrEnum
from typing import Annotated, Any

import httpx
from pydantic import BaseModel, BeforeValidator, Field, WithJsonSchema

from app.tools.geo import (
    Point,
    geocode,
    haversine_m,
    nominatim_search,
    resolve_point,
    round_distance,
)
from app.tools.registry import Tool, ToolContext, ToolError, ToolResult, register

log = logging.getLogger(__name__)

MAX_RESULTS = 8
OVERPASS_TIMEOUT_S = 8
OVERPASS_COOLDOWN_S = 300
CACHE_TTL_S = 600
NOMINATIM_MAX_SELECTORS = 4  # each costs a rate-limited 1s request
AUTO_WIDEN_BELOW_M = 3000  # an empty search smaller than this is retried wider once

_overpass_down_until = 0.0
_cache: dict[tuple, tuple[float, list[dict[str, Any]], str]] = {}


class Category(StrEnum):
    food = "food"  # restaurants, street food and cafes together
    cafe = "cafe"
    restaurant = "restaurant"
    street_food = "street_food"
    museum = "museum"
    art_gallery = "art_gallery"
    attraction = "attraction"
    viewpoint = "viewpoint"
    park = "park"
    mall = "mall"
    cinema = "cinema"
    library = "library"
    indoor_options = "indoor_options"  # things to do when it's raining
    hotel = "hotel"
    pharmacy = "pharmacy"
    hospital = "hospital"
    medical = "medical"  # pharmacies/chemists plus hospitals and clinics
    atm = "atm"
    toilets = "toilets"
    police = "police"
    train_station = "train_station"
    bus_station = "bus_station"


# OSM tag selectors per category
SELECTORS: dict[Category, list[tuple[str, str]]] = {
    Category.food: [
        ("amenity", "restaurant"),
        ("amenity", "fast_food"),
        ("amenity", "cafe"),
        ("amenity", "food_court"),
    ],
    Category.cafe: [("amenity", "cafe")],
    Category.restaurant: [("amenity", "restaurant")],
    Category.street_food: [("amenity", "fast_food"), ("amenity", "food_court")],
    Category.museum: [("tourism", "museum")],
    Category.art_gallery: [("tourism", "gallery")],
    Category.attraction: [("tourism", "attraction")],
    Category.viewpoint: [("tourism", "viewpoint")],
    Category.park: [("leisure", "park"), ("leisure", "garden")],
    Category.mall: [("shop", "mall")],
    Category.cinema: [("amenity", "cinema")],
    Category.library: [("amenity", "library")],
    Category.indoor_options: [
        ("tourism", "museum"),
        ("tourism", "gallery"),
        ("amenity", "cinema"),
        ("shop", "mall"),
        ("amenity", "library"),
        ("amenity", "arts_centre"),
        ("tourism", "aquarium"),
    ],
    Category.hotel: [("tourism", "hotel"), ("tourism", "guest_house"), ("tourism", "hostel")],
    # many Indian medical stores are mapped as shop=chemist
    Category.pharmacy: [("amenity", "pharmacy"), ("shop", "chemist"), ("healthcare", "pharmacy")],
    Category.hospital: [("amenity", "hospital"), ("amenity", "clinic"), ("amenity", "doctors")],
    Category.medical: [
        ("amenity", "pharmacy"),
        ("shop", "chemist"),
        ("amenity", "hospital"),
        ("amenity", "clinic"),
        ("amenity", "doctors"),
        ("healthcare", "pharmacy"),
    ],
    Category.atm: [("amenity", "atm"), ("amenity", "bank")],
    Category.toilets: [("amenity", "toilets")],
    Category.police: [("amenity", "police")],
    Category.train_station: [("railway", "station")],
    Category.bus_station: [("amenity", "bus_station")],
}
FOOD = {Category.food, Category.cafe, Category.restaurant, Category.street_food}

# when a search finds nothing even after widening, try the closest broader need
RELATED: dict[Category, Category] = {
    Category.pharmacy: Category.medical,
    Category.hospital: Category.medical,
    Category.cafe: Category.food,
    Category.restaurant: Category.food,
    Category.street_food: Category.food,
    Category.museum: Category.indoor_options,
    Category.art_gallery: Category.indoor_options,
    Category.cinema: Category.indoor_options,
    Category.library: Category.indoor_options,
}

# what people actually type -> category; matched after lowercasing and trimming plurals
ALIASES: dict[str, Category] = {
    **{a: Category.food for a in (
        "eat", "eating", "dining", "dinner", "lunch", "breakfast", "meal", "snack", "snacks",
        "food place", "places to eat", "dhaba", "thali", "veg food",
    )},
    **{a: Category.restaurant for a in ("restaurant", "restaurants", "restro", "fine dining")},
    **{a: Category.street_food for a in (
        "fast food", "fast_food", "chaat", "food court", "food stall", "stall",
    )},
    **{a: Category.cafe for a in ("coffee", "coffee shop", "tea", "chai", "cafes", "café")},
    **{a: Category.pharmacy for a in (
        "medicine", "medicines", "medical store", "medical shop", "chemist", "drugstore",
        "drug store", "pharmacist",
    )},
    **{a: Category.medical for a in ("health", "healthcare", "first aid")},
    **{a: Category.hospital for a in (
        "clinic", "doctor", "doctors", "emergency", "er", "nursing home",
    )},
    **{a: Category.atm for a in ("bank", "cash", "money")},
    **{a: Category.toilets for a in (
        "toilet", "restroom", "washroom", "bathroom", "loo", "wc",
    )},
    **{a: Category.hotel for a in (
        "stay", "lodging", "accommodation", "hostel", "guest house", "guesthouse", "lodge",
    )},
    **{a: Category.train_station for a in (
        "railway", "railway station", "train", "station", "metro", "metro station",
    )},
    **{a: Category.bus_station for a in ("bus", "bus stand", "bus stop", "bus depot")},
    **{a: Category.mall for a in ("shopping", "shopping mall", "shopping centre")},
    **{a: Category.cinema for a in ("movie", "movies", "theatre", "theater", "multiplex")},
    **{a: Category.attraction for a in (
        "sightseeing", "sights", "tourist spot", "tourist place", "things to do", "landmark",
    )},
    **{a: Category.indoor_options for a in ("indoor", "indoors", "rain", "rainy day")},
    **{a: Category.park for a in ("garden", "gardens", "green space")},
    **{a: Category.art_gallery for a in ("gallery", "art", "art gallery")},
    **{a: Category.police for a in ("police station", "cops")},
    **{a: Category.viewpoint for a in ("view", "sunset point", "scenic")},
}  # fmt: skip


def parse_category(value: Any) -> Category:
    if isinstance(value, Category):
        return value
    text = " ".join(str(value).lower().replace("-", " ").split())
    for candidate in (text, text.replace(" ", "_"), text.rstrip("s"), text.removesuffix("es")):
        if candidate in Category.__members__:
            return Category(candidate)
        if candidate in ALIASES:
            return ALIASES[candidate]
    options = ", ".join(c.value for c in Category)
    raise ValueError(f"unknown category {value!r}; use one of: {options}")


CategoryArg = Annotated[
    Category,
    BeforeValidator(parse_category),
    # a plain string for the model: strict enums make Groq reject slightly-off guesses
    # before we can map them, so validation happens here instead
    WithJsonSchema(
        {
            "type": "string",
            "description": "What to look for. One of: "
            + ", ".join(c.value for c in Category)
            + ". 'food' covers restaurants, street food and cafes; 'medical' covers "
            "pharmacies, chemists, hospitals and clinics.",
        }
    ),
]


class NearbyArgs(BaseModel):
    category: CategoryArg
    place: str | None = Field(
        default=None,
        description="Search around this named place. Omit to search around the user's shared "
        "location.",
    )
    radius_m: int = Field(default=1000, ge=100, le=5000, description="Search radius in metres")
    vegetarian_only: bool = Field(
        default=False,
        description="Only food places tagged vegetarian in OpenStreetMap (tags can be missing)",
    )


def build_query(category: Category, point: Point, radius_m: int, vegetarian: bool) -> str:
    diet = '["diet:vegetarian"~"^(yes|only)$"]' if vegetarian and category in FOOD else ""
    around = f"(around:{radius_m},{point.lat:.6f},{point.lng:.6f})"
    parts = "".join(f'nwr["{k}"="{v}"]["name"]{diet}{around};' for k, v in SELECTORS[category])
    return f"[out:json][timeout:20];({parts});out center tags 80;"


async def _overpass(ctx: ToolContext, query: str) -> list[dict[str, Any]] | None:
    """Elements, or None when every endpoint failed (then Overpass is skipped for a while)."""
    global _overpass_down_until
    if time.monotonic() < _overpass_down_until:
        return None
    for url in ctx.settings.overpass_url_list:
        try:
            r = await ctx.http.post(url, data={"data": query}, timeout=OVERPASS_TIMEOUT_S)
            if r.status_code == 200:
                return r.json().get("elements") or []
            error = f"HTTP {r.status_code}"
        except (httpx.HTTPError, ValueError) as e:
            error = e.__class__.__name__
        log.info("overpass %s failed: %s", url, error)
    _overpass_down_until = time.monotonic() + OVERPASS_COOLDOWN_S
    return None


def _nominatim_phrase(key: str, value: str) -> str:
    return "railway_station" if (key, value) == ("railway", "station") else value


def _nominatim_element(hit: dict[str, Any]) -> dict[str, Any] | None:
    """A Nominatim result reshaped like an Overpass element so to_places handles both."""
    try:
        lat, lon = float(hit["lat"]), float(hit["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    names = hit.get("namedetails") or {}
    addr = hit.get("address") or {}
    tags = {k: v for k, v in (hit.get("extratags") or {}).items() if isinstance(v, str)}
    tags[hit.get("category", "")] = hit.get("type", "")
    tags["name"] = names.get("name") or hit.get("name") or ""
    if names.get("name:en"):
        tags["name:en"] = names["name:en"]
    for src, dst in (
        ("house_number", "addr:housenumber"),
        ("road", "addr:street"),
        ("suburb", "addr:suburb"),
        ("neighbourhood", "addr:neighbourhood"),
    ):
        if addr.get(src):
            tags[dst] = addr[src]
    city = addr.get("city") or addr.get("town") or addr.get("village")
    if city:
        tags["addr:city"] = city
    return {"lat": lat, "lon": lon, "tags": tags}


async def _nominatim_places(
    ctx: ToolContext, category: Category, origin: Point, radius_m: int, vegetarian: bool
) -> list[dict[str, Any]]:
    dlat = radius_m / 111_320
    dlng = radius_m / (111_320 * max(0.01, math.cos(math.radians(origin.lat))))
    viewbox = f"{origin.lng - dlng},{origin.lat + dlat},{origin.lng + dlng},{origin.lat - dlat}"
    allowed = set(SELECTORS[category])
    elements = []
    for key, value in SELECTORS[category][:NOMINATIM_MAX_SELECTORS]:
        hits = await nominatim_search(
            ctx,
            {
                "amenity": _nominatim_phrase(key, value),
                "viewbox": viewbox,
                "bounded": 1,
                "limit": 40,
                "addressdetails": 1,
                "extratags": 1,
                "namedetails": 1,
            },
        )
        for hit in hits:
            # the phrase search is fuzzy; keep only exact tag matches
            if (hit.get("category"), hit.get("type")) not in allowed:
                continue
            el = _nominatim_element(hit)
            if el is None:
                continue
            diet = el["tags"].get("diet:vegetarian")
            if vegetarian and category in FOOD and diet not in ("yes", "only"):
                continue
            elements.append(el)
    return elements


def _address(tags: dict[str, str]) -> str:
    street = " ".join(p for p in (tags.get("addr:housenumber"), tags.get("addr:street")) if p)
    parts = [
        street,
        tags.get("addr:suburb") or tags.get("addr:neighbourhood"),
        tags.get("addr:city"),
    ]
    return ", ".join(p for p in parts if p)


def _kind(tags: dict[str, str]) -> str:
    for key in ("tourism", "amenity", "leisure", "shop", "railway"):
        if key in tags:
            return tags[key].replace("_", " ")
    return "place"


def to_places(
    elements: list[dict[str, Any]], origin: Point, limit: int | None = MAX_RESULTS
) -> list[dict[str, Any]]:
    seen: set[tuple[str, int, int]] = set()
    places = []
    for el in elements:
        tags = el.get("tags") or {}
        name = tags.get("name:en") or tags.get("name")
        center = el if "lat" in el else el.get("center") or {}
        lat, lng = center.get("lat"), center.get("lon")
        if not name or lat is None or lng is None:
            continue
        key = (name.lower(), round(lat * 1000), round(lng * 1000))  # same place as node + way
        if key in seen:
            continue
        seen.add(key)
        place = {
            "name": name,
            "kind": _kind(tags),
            "lat": lat,
            "lng": lng,
            "distance_m": round_distance(haversine_m(origin.lat, origin.lng, lat, lng)),
            "address": _address(tags),
        }
        for tag, out in (
            ("opening_hours", "opening_hours_osm"),
            ("cuisine", "cuisine"),
            ("wheelchair", "wheelchair"),
            ("phone", "phone"),
            ("website", "website"),
            ("name", "local_name"),
        ):
            if tags.get(tag) and not (out == "local_name" and tags[tag] == name):
                place[out] = tags[tag]
        places.append(place)
    places.sort(key=lambda p: p["distance_m"])
    return places[:limit] if limit else places


async def _search(
    ctx: ToolContext, category: Category, origin: Point, radius_m: int, vegetarian: bool
) -> tuple[list[dict[str, Any]], str]:
    """Places within radius_m, nearest first, from cache, Overpass or Nominatim."""
    key = (category, round(origin.lat, 3), round(origin.lng, 3), radius_m, vegetarian)
    cached = _cache.get(key)
    if cached and cached[0] > time.monotonic():
        return [dict(p) for p in cached[1]], cached[2]

    elements = await _overpass(ctx, build_query(category, origin, radius_m, vegetarian))
    source = "overpass"
    if elements is None:
        source = "nominatim"
        try:
            elements = await _nominatim_places(ctx, category, origin, radius_m, vegetarian)
        except ToolError:
            raise ToolError(
                "map data services are unavailable right now; do not retry this turn"
            ) from None
    places = [p for p in to_places(elements, origin, limit=None) if p["distance_m"] <= radius_m]
    places = places[:MAX_RESULTS]
    _cache[key] = (time.monotonic() + CACHE_TTL_S, [dict(p) for p in places], source)
    return places, source


async def find_nearby_places(ctx: ToolContext, args: NearbyArgs) -> dict:
    origin = await resolve_point(ctx, args.place)
    category, radius = args.category, args.radius_m
    veg = args.vegetarian_only
    notes: list[str] = []

    places, source = await _search(ctx, category, origin, radius, veg)
    if not places and radius < AUTO_WIDEN_BELOW_M:
        wider = min(5000, max(radius * 3, 2000))
        places, source = await _search(ctx, category, origin, wider, veg)
        if places:
            notes.append(f"Nothing within {radius} m, so the search was widened to {wider} m.")
        radius = wider
    if not places and category in RELATED:
        related = RELATED[category]
        places, source = await _search(ctx, related, origin, radius, veg and related in FOOD)
        if places:
            notes.append(
                f"No {category.value.replace('_', ' ')} is mapped in OpenStreetMap within "
                f"{radius} m; these are {related.value.replace('_', ' ')} places instead. "
                "Tell the user this plainly."
            )
            category = related

    for i, p in enumerate(places, start=1):
        p["number"] = i
    ctx.session.places = [
        {k: p.get(k) for k in ("number", "name", "lat", "lng", "address", "kind")} for p in places
    ]
    result: dict[str, Any] = {
        "searched_around": origin.label,
        "radius_m": radius,
        "requested_category": args.category.value,
        "category": category.value,
        "results": places,
        "source": source,
    }
    if places:
        notes.append(
            "Numbered results are saved; the user can reply with a number. "
            "opening_hours_osm is the raw OpenStreetMap value and may be outdated."
        )
    else:
        notes.append(
            f"No named {category.value.replace('_', ' ')} places are mapped in OpenStreetMap "
            f"within {radius} m (small shops are often unmapped). Say so honestly; suggest "
            "another category or asking locals, not a bigger radius than 5000 m."
        )
    result["note"] = " ".join(notes)
    return result


def place_by_number(ctx: ToolContext, number: int) -> dict[str, Any]:
    for p in ctx.session.places:
        if p.get("number") == number:
            return p
    if not ctx.session.places:
        raise ToolError("no saved search results; search with find_nearby_places first")
    raise ToolError(f"there is no result number {number}; valid: 1-{len(ctx.session.places)}")


class PinArgs(BaseModel):
    result_number: int = Field(ge=1, description="Number from the last find_nearby_places results")


async def send_place_pin(ctx: ToolContext, args: PinArgs) -> ToolResult:
    p = place_by_number(ctx, args.result_number)
    await ctx.sender.send_location(ctx.phone, p["lat"], p["lng"], p["name"], p.get("address") or "")
    return ToolResult({"sent_pin_for": p["name"]})


class SetLocationArgs(BaseModel):
    place: str = Field(min_length=2, description="Where the user says they are")


async def set_current_location(ctx: ToolContext, args: SetLocationArgs) -> dict:
    point = await geocode(ctx, args.place)
    ctx.session.location = {
        "lat": point.lat,
        "lng": point.lng,
        "label": point.label,
        "at": time.time(),
    }
    return {"location_set_to": point.label, "lat": point.lat, "lng": point.lng}


class RequestLocationArgs(BaseModel):
    reason: str = Field(
        default="Share your location and I'll find what's around you.",
        max_length=300,
        description="Short sentence shown above the 'Send location' button",
    )


async def request_user_location(ctx: ToolContext, args: RequestLocationArgs) -> ToolResult:
    await ctx.sender.request_location(ctx.phone, args.reason)
    return ToolResult(
        {"sent": True, "note": "waiting for the user to share location"}, ends_turn=True
    )


register(
    Tool(
        name="find_nearby_places",
        description="Real places near the user's shared location or a named place, from "
        "OpenStreetMap, sorted by straight-line distance and numbered. Use indoor_options for "
        "rain backups.",
        args=NearbyArgs,
        run=find_nearby_places,
    )
)
register(
    Tool(
        name="send_place_pin",
        description="Send a tappable WhatsApp map pin for one of the numbered search results.",
        args=PinArgs,
        run=send_place_pin,
    )
)
register(
    Tool(
        name="set_current_location",
        description="Set where the user is from a place name they typed (instead of sharing "
        "GPS location).",
        args=SetLocationArgs,
        run=set_current_location,
    )
)
register(
    Tool(
        name="request_user_location",
        description="Ask the user to share their live location with a one-tap button. Use when "
        "a request needs their position and none is known.",
        args=RequestLocationArgs,
        run=request_user_location,
    )
)
