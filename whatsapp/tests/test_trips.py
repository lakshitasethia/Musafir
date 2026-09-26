import json

import httpx
import pytest

from app.store import Session
from app.tools import ToolContext, ToolError, get_tool
from tests.conftest import FakeLLM, button_msg, call, say, text_msg

PHONE = "919800000001"
TRIP = "11111111-1111-4111-8111-111111111111"
STOP_A = "22222222-2222-4222-8222-222222222222"
STOP_B = "33333333-3333-4333-8333-333333333333"
PROP = "44444444-4444-4444-8444-444444444444"


def bundle(proposals=None):
    return {
        "trip": {
            "id": TRIP,
            "destination": "Jaipur",
            "schedule": [
                {
                    "dayIndex": 1,
                    "date": "2026-09-27",
                    "nodes": [
                        {
                            "id": STOP_A,
                            "title": "Hawa Mahal",
                            "type": "SOFT",
                            "timeSlot": {"start": "09:00", "durationMinutes": 60},
                        },
                        {
                            "id": STOP_B,
                            "title": "Hotel check-in",
                            "type": "HARD",
                            "timeSlot": {"start": "11:00", "durationMinutes": 30},
                        },
                    ],
                },
                {"dayIndex": 2, "date": "2026-09-28", "nodes": []},
            ],
        },
        "planner": {"status": "DONE", "note": "done"},
        "proposals": proposals or [],
    }


def trips_api(net, *, proposals=None, disruption_status="AUTO_APPLIED"):
    sent = []
    net.on(
        "/api/trips",
        {
            "trips": [
                {
                    "id": TRIP,
                    "destination": "Jaipur",
                    "dateRange": {"start": "2026-09-27", "end": "2026-09-28"},
                }
            ]
        },
    )
    net.on(f"/api/trips/{TRIP}", lambda r: httpx.Response(200, json=bundle(proposals)))

    def disrupt(r):
        sent.append(json.loads(r.content))
        return httpx.Response(200, json={"proposalId": PROP, "status": disruption_status})

    net.on("/disruptions", disrupt)
    net.on(
        "/decision",
        lambda r: (sent.append(json.loads(r.content)), httpx.Response(200, json={"ok": True}))[1],
    )
    return sent


@pytest.fixture
async def ctx(settings, store, sender, http):
    from app.backend_client import BackendClient

    await store.save_link(PHONE, "sess-1", "asha@x.dev", "Asha")
    return ToolContext(
        session=Session(phone=PHONE),
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


async def test_trip_tools_need_a_linked_account(ctx, net, store):
    await store.delete_link(PHONE)
    with pytest.raises(ToolError, match="not linked"):
        await run(ctx, "my_trips")


async def test_session_cookie_is_sent(ctx, net):
    trips_api(net)
    await run(ctx, "my_trips")
    assert net.requests[-1].headers["cookie"] == "mz_session=sess-1"


async def test_show_day_numbers_stops_and_hides_ids(ctx, net):
    trips_api(net)
    out = await run(ctx, "show_day", when="2026-09-27")
    assert [s["number"] for s in out["stops"]] == [1, 2]
    assert out["stops"][0] == {
        "number": 1,
        "title": "Hawa Mahal",
        "start": "09:00",
        "end": "10:00",
        "locked_booking": False,
    }
    assert out["stops"][1]["locked_booking"] is True
    assert TRIP not in json.dumps(out) and STOP_A not in json.dumps(out)
    assert ctx.session.trip["day"] == 1


async def test_show_day_outside_trip_is_an_error(ctx, net):
    trips_api(net)
    with pytest.raises(ToolError, match="outside this trip"):
        await run(ctx, "show_day", when="2027-01-01")


async def test_report_late_uses_the_real_stop_id(ctx, net):
    sent = trips_api(net)
    await run(ctx, "show_day", when="2026-09-27")
    out = await run(ctx, "report_late", stop=1, minutes=20)
    assert sent[-1] == {
        "kind": "DELAY",
        "nodeId": STOP_A,
        "delayMinutes": 20,
        "reason": "Reported on WhatsApp",
    }
    assert out["outcome"].startswith("Fixed automatically")


async def test_report_before_opening_a_day(ctx, net):
    trips_api(net)
    with pytest.raises(ToolError, match="show_day"):
        await run(ctx, "report_closed", stop=1)


async def test_rain_window_validation(ctx, net):
    trips_api(net)
    await run(ctx, "show_day", when="2026-09-27")
    with pytest.raises(ToolError, match="end after"):
        await run(ctx, "report_rain", from_time="15:00", to_time="14:00")
    tool = get_tool("report_rain")
    with pytest.raises(ToolError):
        tool.parse({"from_time": "3pm", "to_time": "16:00"})


async def test_operator_only_option_cannot_be_applied(ctx, net):
    proposal = {
        "id": PROP,
        "status": "PENDING",
        "headline": "Hotel check-in moved",
        "options": [{"id": "o1", "label": "Shift check-in"}, {"id": "o2", "label": "Skip museum"}],
        "canDecide": [False, True],
    }
    sent = trips_api(net, proposals=[proposal])
    cards = await run(ctx, "show_cards")
    assert cards["cards"][0]["options"][0]["you_can_apply"] is False
    with pytest.raises(ToolError, match="operator"):
        await run(ctx, "apply_card", card=1, option=1)
    await run(ctx, "apply_card", card=1, option=2)
    assert sent[-1] == {"decision": "APPLY", "optionId": "o2"}


async def test_trip_change_needs_a_confirm_tap(make_agent, net, sender, store):
    await store.save_link(PHONE, "sess-1", "asha@x.dev", "Asha")
    sent = trips_api(net)
    agent = make_agent(
        FakeLLM(
            call("show_day", when="2026-09-27"),
            call("report_late", 1, stop=2, minutes=15),
            say("Tap confirm."),
        )
    )
    await agent.handle(text_msg("I'm 15 min late for the hotel"))
    assert sent == []  # nothing changed yet
    ask = next(m for m in sender.sent if m.kind == "buttons")
    assert ask.body == "Tell Musafir you're 15 min late for stop 2?"
    token = ask.extra["buttons"][0][0]
    await make_agent().handle(button_msg(token))
    assert sent[-1]["nodeId"] == STOP_B
    assert "Fixed automatically" in sender.sent[-1].body
