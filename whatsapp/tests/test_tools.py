import json

import httpx
import pytest

from app.store import Session
from app.tools import ToolContext, ToolError, get_tool
from app.tools.geo import Point, haversine_m
from app.tools.places import Category, build_query, to_places


@pytest.fixture
def ctx(settings, store, sender, http):
    from app.backend_client import BackendClient

    session = Session(
        phone="1", location={"lat": 26.9239, "lng": 75.8267, "label": "Hawa Mahal", "at": 0}
    )
    return ToolContext(
        session=session,
        store=store,
        sender=sender,
        http=http,
        backend=BackendClient(http, settings.musafir_api_url),
        settings=settings,
    )


async def run(ctx, name, **args):
    tool = get_tool(name)
    out = await tool.run(ctx, tool.parse(args))
    return out.data if hasattr(out, "data") else out


def test_haversine_known_distance():
    # two points ~100 m apart N-S and ~208 m E-W at 27°N: ~231 m
    d = haversine_m(26.9239, 75.8267, 26.9248, 75.8246)
    assert 180 < d < 260
    assert haversine_m(0, 0, 0, 0) == 0


def test_every_tool_schema_is_valid_for_groq():
    from app.tools import all_tools

    names = set()
    for tool in all_tools():
        schema = tool.schema()
        fn = schema["function"]
        assert fn["parameters"]["type"] == "object"
        assert '"title"' not in json.dumps(fn["parameters"])
        names.add(fn["name"])
    assert {
        "get_weather",
        "find_nearby_places",
        "get_travel_time",
        "request_user_location",
        "send_place_pin",
        "link_musafir_account",
        "unlink_musafir_account",
    } <= names


def test_overpass_query_includes_all_selectors_and_diet():
    q = build_query(Category.indoor_options, Point(1.5, 2.5, "x"), 800, vegetarian=False)
    assert (
        '"tourism"="museum"' in q and '"shop"="mall"' in q and "around:800,1.500000,2.500000" in q
    )
    assert "diet" not in q
    veg = build_query(Category.restaurant, Point(1, 2, "x"), 500, vegetarian=True)
    assert "diet:vegetarian" in veg
    assert "diet" not in build_query(Category.museum, Point(1, 2, "x"), 500, vegetarian=True)


def test_to_places_sorts_dedupes_and_skips_unnamed():
    origin = Point(26.9239, 75.8267, "o")
    elements = [
        {
            "type": "node",
            "lat": 26.95,
            "lon": 75.85,
            "tags": {"name": "Far Museum", "tourism": "museum"},
        },
        {
            "type": "way",
            "center": {"lat": 26.9248, "lon": 75.8246},
            "tags": {"name": "Jantar Mantar", "tourism": "museum", "opening_hours": "09:00-16:30"},
        },
        {
            "type": "node",
            "lat": 26.92481,
            "lon": 75.82461,
            "tags": {"name": "Jantar Mantar", "tourism": "museum"},
        },  # same place as the way
        {"type": "node", "lat": 26.924, "lon": 75.827, "tags": {"tourism": "museum"}},  # unnamed
        {"type": "way", "tags": {"name": "No geometry"}},
    ]
    places = to_places(elements, origin)
    assert [p["name"] for p in places] == ["Jantar Mantar", "Far Museum"]
    assert places[0]["opening_hours_osm"] == "09:00-16:30"
    assert places[0]["distance_m"] < places[1]["distance_m"]


async def test_find_nearby_falls_back_to_second_overpass_and_numbers(ctx, net):
    net.on("overpass-a.test", 504)
    net.on(
        "overpass-b.test",
        {
            "elements": [
                {
                    "type": "node",
                    "lat": 26.9248,
                    "lon": 75.8246,
                    "tags": {"name": "Jantar Mantar", "tourism": "museum"},
                },
                {
                    "type": "node",
                    "lat": 26.93,
                    "lon": 75.83,
                    "tags": {"name": "Cafe X", "amenity": "cafe"},
                },
            ]
        },
    )
    data = await run(ctx, "find_nearby_places", category="indoor_options")
    assert [p["number"] for p in data["results"]] == [1, 2]
    assert ctx.session.places[0]["name"] == "Jantar Mantar"


def _nominatim_hit(name, category, type_, lat, lon, **extra):
    return {
        "name": name,
        "category": category,
        "type": type_,
        "lat": str(lat),
        "lon": str(lon),
        "address": {"road": "Johari Bazar", "city": "Jaipur"},
        "extratags": extra,
        "namedetails": {"name": name},
    }


async def test_all_map_services_down(ctx, net):
    net.on("overpass-", 429)
    net.on("nominatim", 503)
    with pytest.raises(ToolError, match="do not retry"):
        await run(ctx, "find_nearby_places", category="cafe")


async def test_falls_back_to_nominatim_and_skips_overpass_afterwards(ctx, net):
    net.on("overpass-", lambda r: (_ for _ in ()).throw(httpx.ConnectError("reset")))

    def nominatim(request):
        phrase = request.url.params["amenity"]
        assert request.url.params["bounded"] == "1"
        if phrase == "museum":
            return httpx.Response(
                200,
                json=[
                    _nominatim_hit("Albert Hall", "tourism", "museum", 26.9116, 75.8195),
                    _nominatim_hit(
                        "City Palace",
                        "tourism",
                        "museum",
                        26.9258,
                        75.8237,
                        opening_hours="09:30-17:00",
                    ),
                ],
            )
        if phrase == "gallery":  # fuzzy phrase match returns a roof: must be dropped
            return httpx.Response(
                200, json=[_nominatim_hit("Roof", "building", "roof", 26.92, 75.82)]
            )
        return httpx.Response(200, json=[])

    net.on("nominatim", nominatim)
    data = await run(ctx, "find_nearby_places", category="indoor_options", radius_m=3000)
    assert data["source"] == "nominatim"
    assert [p["name"] for p in data["results"]] == ["City Palace", "Albert Hall"]
    assert data["results"][0]["opening_hours_osm"] == "09:30-17:00"
    assert data["results"][0]["address"] == "Johari Bazar, Jaipur"
    phrases = [r.url.params["amenity"] for r in net.requests if "nominatim" in str(r.url)]
    assert phrases == ["museum", "gallery", "cinema", "mall"]  # capped selectors

    overpass_calls = sum("overpass-" in str(r.url) for r in net.requests)
    await run(ctx, "find_nearby_places", category="museum", radius_m=3000)
    assert sum("overpass-" in str(r.url) for r in net.requests) == overpass_calls  # cooling down


async def test_nominatim_fallback_drops_results_outside_radius(ctx, net):
    net.on("overpass-", 504)
    net.on(
        "nominatim",
        [
            _nominatim_hit("Near Cafe", "amenity", "cafe", 26.9245, 75.8270),
            # inside the square viewbox corner but beyond the circular radius
            _nominatim_hit("Corner Cafe", "amenity", "cafe", 26.9239 + 0.0085, 75.8267 + 0.0095),
        ],
    )
    data = await run(ctx, "find_nearby_places", category="cafe", radius_m=1000)
    assert [p["name"] for p in data["results"]] == ["Near Cafe"]


async def test_results_are_cached(ctx, net):
    net.on(
        "overpass-a.test",
        {
            "elements": [
                {
                    "type": "node",
                    "lat": 26.9245,
                    "lon": 75.827,
                    "tags": {"name": "A", "amenity": "cafe"},
                }
            ]
        },
    )
    await run(ctx, "find_nearby_places", category="cafe")
    await run(ctx, "find_nearby_places", category="cafe")
    assert sum("overpass" in str(r.url) for r in net.requests) == 1
    assert ctx.session.places[0]["name"] == "A"


def _overpass_by_tag(mapping):
    """Answer each Overpass query with elements for whichever tag it asks about."""

    def handler(request):
        query = dict(httpx.QueryParams(request.content.decode()))["data"]
        radius = int(query.split("around:")[1].split(",")[0])
        elements = []
        for tag, els in mapping.items():
            if tag in query:
                elements += [e for e in els if e.get("_min_radius", 0) <= radius]
        return httpx.Response(200, json={"elements": elements})

    return handler


async def test_find_nearby_empty_everywhere(ctx, net):
    net.on("overpass-a.test", {"elements": []})
    data = await run(ctx, "find_nearby_places", category="atm", radius_m=100)
    assert data["results"] == [] and data["radius_m"] == 2000  # widened once
    assert "not mapped" not in data["note"] and "Say so honestly" in data["note"]
    assert ctx.session.places == []


async def test_empty_search_is_widened(ctx, net):
    far_cafe = {
        "type": "node",
        "lat": 26.9239 + 0.012,
        "lon": 75.8267,
        "tags": {"name": "Far Cafe", "amenity": "cafe"},
        "_min_radius": 2000,
    }
    net.on("overpass-a.test", _overpass_by_tag({'"amenity"="cafe"': [far_cafe]}))
    data = await run(ctx, "find_nearby_places", category="cafe", radius_m=500)
    assert [p["name"] for p in data["results"]] == ["Far Cafe"]
    assert data["radius_m"] == 2000 and "widened to 2000 m" in data["note"]


async def test_missing_pharmacy_falls_back_to_medical(ctx, net):
    hospital = {
        "type": "node",
        "lat": 26.925,
        "lon": 75.827,
        "tags": {"name": "Gandhi Hospital", "amenity": "hospital"},
    }
    net.on("overpass-a.test", _overpass_by_tag({'"amenity"="hospital"': [hospital]}))
    data = await run(ctx, "find_nearby_places", category="medicine")  # alias -> pharmacy
    assert data["requested_category"] == "pharmacy" and data["category"] == "medical"
    assert [p["name"] for p in data["results"]] == ["Gandhi Hospital"]
    assert "No pharmacy is mapped" in data["note"]


async def test_pharmacy_includes_chemist_shops(ctx, net):
    q = build_query(Category.pharmacy, Point(1, 2, "x"), 500, vegetarian=False)
    assert '"shop"="chemist"' in q and '"amenity"="pharmacy"' in q


@pytest.mark.parametrize(
    ("typed", "expected"),
    [
        ("food", "food"),
        ("Food", "food"),
        ("nearby food", None),
        ("medical store", "pharmacy"),
        ("Medicine", "pharmacy"),
        ("chemist", "pharmacy"),
        ("restaurants", "restaurant"),
        ("museums", "museum"),
        ("indoor", "indoor_options"),
        ("washroom", "toilets"),
        ("railway station", "train_station"),
        ("street-food", "street_food"),
    ],
)
def test_category_aliases(typed, expected):
    tool = get_tool("find_nearby_places")
    if expected is None:
        with pytest.raises(ToolError, match="use one of"):
            tool.parse({"category": typed})
    else:
        assert tool.parse({"category": typed}).category.value == expected


def test_category_schema_is_a_plain_string():
    params = get_tool("find_nearby_places").schema()["function"]["parameters"]
    assert params["properties"]["category"]["type"] == "string"
    assert "enum" not in json.dumps(params["properties"]["category"])
    mode = get_tool("get_travel_time").schema()["function"]["parameters"]["properties"]["mode"]
    assert mode["type"] == "string" and "enum" not in json.dumps(mode)


def test_travel_mode_aliases():
    tool = get_tool("get_travel_time")
    assert tool.parse({"to_place": "x", "mode": "cab"}).mode.value == "drive"
    assert tool.parse({"to_place": "x", "mode": None}).mode.value == "walk"
    with pytest.raises(ToolError, match="walk, drive or bike"):
        tool.parse({"to_place": "x", "mode": "teleport"})


async def test_named_place_is_geocoded(ctx, net):
    net.on("nominatim", [{"lat": "19.0760", "lon": "72.8777", "display_name": "Mumbai, India"}])
    net.on("open-meteo", {"current": {}, "hourly": {"time": []}})
    data = await run(ctx, "get_weather", place="Mumbai")
    assert data["place"] == "Mumbai, India"
    req = next(r for r in net.requests if "open-meteo" in str(r.url))
    assert req.url.params["latitude"] == "19.076"


async def test_unknown_place(ctx, net):
    net.on("nominatim", [])
    with pytest.raises(ToolError, match="could not find"):
        await run(ctx, "get_weather", place="Zzzzqqq")


async def test_weather_service_down(ctx, net):
    net.on("open-meteo", 503)
    with pytest.raises(ToolError, match="weather service unavailable"):
        await run(ctx, "get_weather")


async def test_weather_tolerates_short_hourly_arrays(ctx, net):
    net.on(
        "open-meteo",
        {"current": {"weather_code": 999}, "hourly": {"time": ["t1", "t2"], "weather_code": [61]}},
    )
    data = await run(ctx, "get_weather")
    assert data["now"]["conditions"] == "unknown"
    assert data["wet_hours"] == ["t1"]
    assert data["hourly"][1]["conditions"] == "unknown"


async def test_travel_time_uses_router(ctx, net):
    ctx.session.places = [{"number": 1, "name": "Jantar Mantar", "lat": 26.9248, "lng": 75.8246}]
    net.on("routed-foot", {"code": "Ok", "routes": [{"duration": 400, "distance": 540}]})
    data = await run(ctx, "get_travel_time", to_result_number=1)
    assert data["route_available"] and data["duration_min"] == 7 and data["route_distance_m"] == 540
    assert "75.826700,26.923900;75.824600,26.924800" in str(net.requests[-1].url)


async def test_travel_time_never_invents_duration_when_router_fails(ctx, net):
    ctx.session.places = [{"number": 1, "name": "X", "lat": 26.93, "lng": 75.83}]
    net.on("routed-car", lambda r: httpx.Response(200, json={"code": "NoRoute"}))
    data = await run(ctx, "get_travel_time", to_result_number=1, mode="drive")
    assert data["route_available"] is False and "duration_min" not in data
    assert data["straight_line_m"] > 0


async def test_travel_time_argument_rules(ctx):
    tool = get_tool("get_travel_time")
    with pytest.raises(ToolError, match="exactly one"):
        tool.parse({})
    with pytest.raises(ToolError, match="exactly one"):
        tool.parse({"to_result_number": 1, "to_place": "x"})
    ctx.session.places = [{"number": 1, "name": "X", "lat": 1, "lng": 1}]
    with pytest.raises(ToolError, match="valid: 1-1"):
        await run(ctx, "get_travel_time", to_result_number=5)


async def test_pin_and_set_location(ctx, net, sender):
    ctx.session.places = [
        {
            "number": 1,
            "name": "Jantar Mantar",
            "lat": 26.9248,
            "lng": 75.8246,
            "address": "Gangori Bazaar",
        }
    ]
    await run(ctx, "send_place_pin", result_number=1)
    assert sender.sent[-1].kind == "location" and sender.sent[-1].extra["lat"] == 26.9248

    net.on("nominatim", [{"lat": "12.97", "lon": "77.59", "display_name": "Bengaluru"}])
    await run(ctx, "set_current_location", place="Bengaluru")
    assert ctx.session.location["label"] == "Bengaluru"


async def test_no_saved_results_for_pin(ctx):
    with pytest.raises(ToolError, match="find_nearby_places first"):
        await run(ctx, "send_place_pin", result_number=1)


async def test_nominatim_429_is_retried_once(ctx, net, monkeypatch):
    from app.tools import geo

    monkeypatch.setattr(geo, "NOMINATIM_RETRY_AFTER_S", 0.0)
    responses = iter(
        [
            httpx.Response(429),
            httpx.Response(200, json=[{"lat": "1", "lon": "2", "display_name": "X"}]),
        ]
    )
    net.on("nominatim", lambda r: next(responses))
    data = await run(ctx, "set_current_location", place="Somewhere")
    assert data["location_set_to"] == "X"

    net.on("nominatim", 429)
    with pytest.raises(ToolError, match="unavailable"):
        await run(ctx, "set_current_location", place="Elsewhere")
