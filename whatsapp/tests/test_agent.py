import json

import httpx

from app.llm import Completion, LLMError, ToolCall
from tests.conftest import FakeLLM, button_msg, call, location_msg, say, text_msg

OPEN_METEO = {
    "timezone": "Asia/Kolkata",
    "current": {
        "time": "2026-09-26T14:00",
        "temperature_2m": 29.1,
        "apparent_temperature": 33,
        "relative_humidity_2m": 80,
        "precipitation": 0.0,
        "weather_code": 3,
        "wind_speed_10m": 9,
    },
    "hourly": {
        "time": ["2026-09-26T14:00", "2026-09-26T15:00"],
        "temperature_2m": [29, 27],
        "precipitation_probability": [20, 85],
        "precipitation": [0, 3.2],
        "weather_code": [3, 63],
        "uv_index": [6, 2],
    },
}


async def test_weather_flow(make_agent, net, sender, store):
    net.on("api.open-meteo.com", OPEN_METEO)
    llm = FakeLLM(call("get_weather"), say("Rain from **3 PM**. Want indoor options?"))
    agent = make_agent(llm)
    session = await store.get_session("919800000001")
    session.location = {"lat": 26.92, "lng": 75.82, "label": "Hawa Mahal", "at": 0}
    await store.save_session(session)

    await agent.handle(text_msg("will it rain?"))

    assert sender.sent[-1].body == "Rain from *3 PM*. Want indoor options?"
    tool_msg = next(m for m in llm.calls[1] if m["role"] == "tool")
    result = json.loads(tool_msg["content"])
    assert result["wet_hours"] == ["2026-09-26T15:00"]
    assert result["now"]["conditions"] == "overcast"
    # durable history keeps only text, not tool traces
    saved = await store.get_session("919800000001")
    assert [m["role"] for m in saved.history] == ["user", "assistant"]


async def test_state_block_carries_location_and_results(make_agent, store):
    llm = FakeLLM(say("ok"))
    agent = make_agent(llm)
    session = await store.get_session("919800000001")
    session.location = {"lat": 1.0, "lng": 2.0, "label": "Somewhere", "at": 0}
    session.places = [{"number": 1, "name": "Albert Hall", "lat": 1, "lng": 2}]
    await store.save_session(session)

    await agent.handle(text_msg("hi"))
    state = llm.calls[0][1]["content"]
    assert "Somewhere" in state and "1. Albert Hall" in state and "may be stale" in state
    assert "not linked" in state


async def test_location_message_is_stored_and_passed_to_llm(make_agent, sender, store):
    llm = FakeLLM(say("Got it, you're near Hawa Mahal."))
    agent = make_agent(llm)
    await agent.handle(location_msg(26.9239, 75.8267, "Hawa Mahal"))
    saved = await store.get_session("919800000001")
    assert saved.location["label"] == "Hawa Mahal"
    assert "26.92390" in llm.calls[0][-1]["content"]
    assert sender.sent[-1].body == "Got it, you're near Hawa Mahal."


async def test_request_location_ends_turn_without_extra_text(make_agent, sender):
    llm = FakeLLM(call("request_user_location", reason="Share your location"))
    agent = make_agent(llm)
    await agent.handle(text_msg("what's near me"))
    assert [o.kind for o in sender.sent] == ["location_request"]
    assert len(llm.calls) == 1


async def test_tool_without_location_returns_actionable_error(make_agent, sender):
    llm = FakeLLM(call("find_nearby_places", category="cafe"), say("Please share your location."))
    agent = make_agent(llm)
    await agent.handle(text_msg("cafes?"))
    err = json.loads(llm.calls[1][-1]["content"])["error"]
    assert "request_user_location" in err


async def test_unknown_tool_and_bad_args_are_reported_to_model(make_agent):
    llm = FakeLLM(
        Completion(
            None,
            [
                ToolCall("a", "book_flight", "{}"),
                ToolCall("b", "get_weather", '{"hours": 999}'),
                ToolCall("c", "get_weather", "not json"),
            ],
        ),
        say("I can't book flights here."),
    )
    agent = make_agent(llm)
    await agent.handle(text_msg("book me a flight"))
    results = [json.loads(m["content"])["error"] for m in llm.calls[1] if m["role"] == "tool"]
    assert "unknown tool" in results[0]
    assert "hours" in results[1]
    assert "not valid JSON" in results[2]


async def test_tool_loop_is_bounded_then_answers_without_tools(make_agent, settings, sender):
    settings.max_tool_rounds = 2
    llm = FakeLLM(
        call("get_my_account"),
        call("get_weather"),
        say("I couldn't check everything, but here's what I know."),
    )
    agent = make_agent(llm)
    await agent.handle(text_msg("loop"))
    assert sender.sent[-1].body == "I couldn't check everything, but here's what I know."
    assert len(llm.calls) == 3
    assert "No more tool calls" in llm.calls[2][-1]["content"]


async def test_tool_loop_limit_fallback_text_when_final_answer_fails(make_agent, settings, sender):
    settings.max_tool_rounds = 1
    llm = FakeLLM(call("get_my_account"), call("get_my_account"))  # ignores the no-tools rule
    await make_agent(llm).handle(text_msg("loop"))
    assert "more steps" in sender.sent[-1].body


async def test_repeated_identical_call_is_not_re_executed(make_agent, net, store, sender):
    hits = []
    net.on("open-meteo", lambda r: hits.append(1) or httpx.Response(200, json=OPEN_METEO))
    session = await store.get_session("919800000001")
    session.location = {"lat": 26.92, "lng": 75.82, "label": "Hawa Mahal", "at": 0}
    await store.save_session(session)
    llm = FakeLLM(
        call("get_weather", hours=6),
        Completion(None, [ToolCall("c9", "get_weather", '{"place": null, "hours": 6}')]),
        say("Dry for now."),
    )
    await make_agent(llm).handle(text_msg("weather?"))
    assert len(hits) == 1
    assert json.loads(llm.calls[2][-1]["content"])["repeated_call"] is True
    assert sender.sent[-1].body == "Dry for now."


async def test_rejected_tool_call_is_shown_to_model_and_retried(make_agent, sender):
    llm = FakeLLM(
        LLMError("Tool call validation failed: category", invalid_tool_call=True),
        say("Here's what I found."),
    )
    await make_agent(llm).handle(text_msg("nearby food plz"))
    assert sender.sent[-1].body == "Here's what I found."
    assert "rejected" in llm.calls[1][-1]["content"]


async def test_llm_errors_become_friendly_replies(make_agent, sender):
    agent = make_agent(FakeLLM(LLMError("boom"), LLMError("429", rate_limited=True)))
    await agent.handle(text_msg("hi"))
    await agent.handle(text_msg("hi again"))
    assert "trouble" in sender.sent[0].body
    assert "a lot of requests" in sender.sent[1].body


async def test_no_llm_configured(make_agent, sender):
    await make_agent(None).handle(text_msg("hi"))
    assert "GROQ_API_KEY" in sender.sent[-1].body


async def test_commands_skip_llm(make_agent, sender, store):
    llm = FakeLLM()
    agent = make_agent(llm)
    session = await store.get_session("919800000001")
    session.history = [{"role": "user", "content": "old"}]
    await store.save_session(session)

    await agent.handle(text_msg("HELP"))
    await agent.handle(text_msg("reset"))
    assert "Musafir on WhatsApp" in sender.sent[0].body
    assert (await store.get_session("919800000001")).history == []
    assert llm.calls == []


async def test_unsupported_media(make_agent, sender):
    from app.channel import Inbound

    await make_agent(FakeLLM()).handle(Inbound("wamid.img", "1", "unsupported", raw_type="image"))
    assert "text messages" in sender.sent[-1].body


async def test_duplicate_delivery_is_processed_once(make_agent, sender):
    llm = FakeLLM(say("hello"))
    agent = make_agent(llm)
    msg = text_msg("hi")
    await agent.handle(msg)
    await agent.handle(msg)
    assert len(sender.sent) == 1


async def test_rate_limit(make_agent, settings, sender):
    settings.rate_limit_per_minute = 2
    agent = make_agent(FakeLLM(say("a"), say("b")))
    for _ in range(3):
        await agent.handle(text_msg("hi"))
    assert "faster than I can keep up" in sender.sent[-1].body


async def test_confirmation_flow_runs_tool_only_after_tap(make_agent, sender, store):
    await store.save_link("919800000001", "tok", "a@b.c", "Asha")
    agent = make_agent(FakeLLM(call("unlink_musafir_account")))
    await agent.handle(text_msg("unlink me"))

    buttons = sender.sent[-1]
    assert buttons.kind == "buttons"
    assert await store.get_link("919800000001") is not None  # nothing happened yet
    yes_id = buttons.extra["buttons"][0][0]

    await agent.handle(button_msg(yes_id))
    assert await store.get_link("919800000001") is None
    assert "no longer linked" in sender.sent[-1].body

    await agent.handle(button_msg(yes_id))  # tapping again
    assert "expired" in sender.sent[-1].body


async def test_confirmation_cancel_and_abandon(make_agent, sender, store):
    await store.save_link("919800000001", "tok", "a@b.c", "Asha")
    agent = make_agent(FakeLLM(call("unlink_musafir_account"), say("sure")))
    await agent.handle(text_msg("unlink me"))
    no_id = sender.sent[-1].extra["buttons"][1][0]
    await agent.handle(text_msg("actually, weather?"))  # new message abandons the pending action
    await agent.handle(button_msg(no_id))
    assert "expired" in sender.sent[-1].body
    assert await store.get_link("919800000001") is not None


async def test_crashing_tool_does_not_kill_turn(make_agent, net, sender, store):
    def boom(request):
        raise RuntimeError("kaboom")

    net.on("backend.test", boom)
    await store.save_link("919800000001", "tok", "a@b.c", "Asha")
    llm = FakeLLM(call("get_my_account"), say("Couldn't load your account."))
    await make_agent(llm).handle(text_msg("who am i"))
    assert sender.sent[-1].body == "Couldn't load your account."
    assert "failed unexpectedly" in llm.calls[1][-1]["content"]


async def test_expired_backend_token_unlinks(make_agent, net, store):
    net.on(
        "backend.test/api/v1/auth/me",
        lambda r: httpx.Response(
            401, json={"error": {"code": "unauthorized", "message": "bad", "details": None}}
        ),
    )
    await store.save_link("919800000001", "tok", "a@b.c", "Asha")
    llm = FakeLLM(call("get_my_account"), say("Please relink."))
    await make_agent(llm).handle(text_msg("who am i"))
    assert "expired" in llm.calls[1][-1]["content"]
    assert await store.get_link("919800000001") is None


async def test_link_tool_sends_one_time_link(make_agent, sender, store):
    await make_agent(FakeLLM(call("link_musafir_account"))).handle(text_msg("link my account"))
    body = sender.sent[-1].body
    assert "https://musafir.test/link/" in body
    code = body.split("/link/")[1].split()[0]
    assert (await store.get_link_code(code))["phone"] == "919800000001"
