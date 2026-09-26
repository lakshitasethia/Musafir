"""Live weather from Open-Meteo (free, no key)."""

import httpx
from pydantic import BaseModel, Field

from app.tools.geo import resolve_point
from app.tools.registry import Tool, ToolContext, ToolError, register

# WMO weather interpretation codes, as documented by Open-Meteo
WMO = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
    45: "fog", 48: "depositing rime fog",
    51: "light drizzle", 53: "drizzle", 55: "dense drizzle",
    56: "light freezing drizzle", 57: "freezing drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain",
    66: "light freezing rain", 67: "freezing rain",
    71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
    80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
    85: "snow showers", 86: "heavy snow showers",
    95: "thunderstorm", 96: "thunderstorm with hail", 99: "thunderstorm with heavy hail",
}  # fmt: skip
WET_CODES = {51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99}
RAIN_PROBABILITY_THRESHOLD = 50  # %
RAIN_AMOUNT_THRESHOLD = 0.5  # mm per hour


class WeatherArgs(BaseModel):
    place: str | None = Field(
        default=None,
        description="City, area or landmark. Omit to use the user's shared location.",
    )
    hours: int = Field(default=12, ge=1, le=24, description="How many hours ahead to include")


def _at(values: list, i: int):
    return values[i] if isinstance(values, list) and i < len(values) else None


async def get_weather(ctx: ToolContext, args: WeatherArgs) -> dict:
    point = await resolve_point(ctx, args.place)
    params = {
        "latitude": point.lat,
        "longitude": point.lng,
        "current": "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,"
        "weather_code,wind_speed_10m",
        "hourly": "temperature_2m,precipitation_probability,precipitation,weather_code,uv_index",
        "forecast_hours": args.hours,
        "timezone": "auto",
    }
    try:
        r = await ctx.http.get(ctx.settings.open_meteo_url, params=params, timeout=10)
        r.raise_for_status()
        data = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise ToolError(f"weather service unavailable ({e.__class__.__name__})") from e

    cur = data.get("current") or {}
    hourly = data.get("hourly") or {}
    times = hourly.get("time") or []
    hours = []
    for i, t in enumerate(times):
        code = _at(hourly.get("weather_code"), i)
        prob = _at(hourly.get("precipitation_probability"), i)
        mm = _at(hourly.get("precipitation"), i)
        wet = (
            (code in WET_CODES)
            or (prob or 0) >= RAIN_PROBABILITY_THRESHOLD
            or (mm or 0) >= RAIN_AMOUNT_THRESHOLD
        )
        hours.append(
            {
                "local_time": t,
                "temp_c": _at(hourly.get("temperature_2m"), i),
                "rain_probability_pct": prob,
                "rain_mm": mm,
                "conditions": WMO.get(code, "unknown"),
                "uv_index": _at(hourly.get("uv_index"), i),
                "wet": wet,
            }
        )

    wet_hours = [h["local_time"] for h in hours if h["wet"]]
    return {
        "place": point.label,
        "timezone": data.get("timezone"),
        "now": {
            "local_time": cur.get("time"),
            "temp_c": cur.get("temperature_2m"),
            "feels_like_c": cur.get("apparent_temperature"),
            "humidity_pct": cur.get("relative_humidity_2m"),
            "rain_mm": cur.get("precipitation"),
            "wind_kmh": cur.get("wind_speed_10m"),
            "conditions": WMO.get(cur.get("weather_code"), "unknown"),
        },
        "hourly": hours,
        "wet_hours": wet_hours,
        "summary": (
            f"rain likely in {len(wet_hours)} of the next {len(hours)} hours, "
            f"first at {wet_hours[0]}"
            if wet_hours
            else f"no rain expected in the next {len(hours)} hours"
        ),
    }


register(
    Tool(
        name="get_weather",
        description="Current conditions and hourly forecast (temperature, rain chance, UV) for a "
        "place or the user's shared location. `wet_hours` lists hours where rain is likely.",
        args=WeatherArgs,
        run=get_weather,
    )
)
