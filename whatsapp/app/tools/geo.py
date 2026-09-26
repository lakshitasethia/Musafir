"""Deterministic geo helpers: haversine distance, Nominatim geocoding, location resolution."""

import asyncio
import logging
import math
import time
from dataclasses import dataclass

import httpx

from app.tools.registry import ToolContext, ToolError

log = logging.getLogger(__name__)

EARTH_RADIUS_M = 6_371_000
LOCATION_STALE_SECONDS = 3 * 3600


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


@dataclass(frozen=True)
class Point:
    lat: float
    lng: float
    label: str


# Nominatim's usage policy: max 1 request/second and cache results.
_geocode_cache: dict[str, Point | None] = {}
_geocode_lock = asyncio.Lock()
_last_geocode = 0.0
NOMINATIM_MIN_INTERVAL_S = 1.0
NOMINATIM_RETRY_AFTER_S = 2.0


async def nominatim_search(ctx: ToolContext, params: dict) -> list[dict]:
    """GET /search, spaced at least 1s apart across the process as Nominatim requires."""
    global _last_geocode
    async with _geocode_lock:
        wait = NOMINATIM_MIN_INTERVAL_S - (time.monotonic() - _last_geocode)
        if wait > 0:
            await asyncio.sleep(wait)
        try:
            for attempt in range(2):
                r = await ctx.http.get(
                    f"{ctx.settings.nominatim_url}/search",
                    params={"format": "jsonv2", **params},
                    timeout=10,
                )
                # other apps on the same IP share the 1 req/s budget; back off once
                if r.status_code != 429 or attempt == 1:
                    break
                log.info("Nominatim 429, retrying after %.0fs", NOMINATIM_RETRY_AFTER_S)
                await asyncio.sleep(NOMINATIM_RETRY_AFTER_S)
            if r.status_code == 403:
                log.warning("Nominatim refused the request (403): check OSM_CONTACT/User-Agent")
            r.raise_for_status()
            hits = r.json()
        except (httpx.HTTPError, ValueError) as e:
            raise ToolError(f"OpenStreetMap search unavailable ({e.__class__.__name__})") from e
        finally:
            _last_geocode = time.monotonic()
    return hits if isinstance(hits, list) else []


async def geocode(ctx: ToolContext, query: str) -> Point:
    key = " ".join(query.lower().split())
    if not key:
        raise ToolError("empty place name")
    if key not in _geocode_cache:
        hits = await nominatim_search(ctx, {"q": query, "limit": 1})
        if key not in _geocode_cache:
            _geocode_cache[key] = (
                Point(
                    float(hits[0]["lat"]),
                    float(hits[0]["lon"]),
                    hits[0].get("display_name") or query,
                )
                if hits
                else None
            )
    point = _geocode_cache[key]
    if point is None:
        raise ToolError(
            f"could not find a place called {query!r}; ask the user to be more specific"
        )
    return point


def shared_location(ctx: ToolContext) -> Point | None:
    loc = ctx.session.location
    if not loc:
        return None
    return Point(loc["lat"], loc["lng"], loc.get("label") or "your shared location")


def location_age_minutes(ctx: ToolContext) -> int | None:
    loc = ctx.session.location
    if not loc or "at" not in loc:
        return None
    return int((time.time() - loc["at"]) / 60)


async def resolve_point(ctx: ToolContext, place: str | None) -> Point:
    """A named place if given, else the user's shared location."""
    if place and place.strip():
        return await geocode(ctx, place)
    point = shared_location(ctx)
    if point is None:
        raise ToolError(
            "no location known: call request_user_location, or ask which place they mean"
        )
    return point


def round_distance(meters: float) -> int:
    return int(round(meters / 10.0) * 10)
