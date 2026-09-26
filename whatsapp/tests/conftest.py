"""Offline test harness: no Meta, no Groq, no OSM. Every network call goes through MockNet."""

import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest

from app.agent import Agent
from app.backend_client import BackendClient
from app.channel import Inbound, RecordingSender
from app.config import Settings
from app.llm import Completion, LLMError, ToolCall
from app.store import Store
from app.tools import geo, places

Handler = Callable[[httpx.Request], httpx.Response]


class MockNet:
    """Route requests by substring of the URL; unmatched requests fail loudly."""

    def __init__(self) -> None:
        self.routes: list[tuple[str, Handler]] = []
        self.requests: list[httpx.Request] = []

    def on(self, url_part: str, handler: Handler | dict | list | int) -> None:
        if not callable(handler):
            payload = handler
            if isinstance(payload, int):
                handler = lambda r, s=payload: httpx.Response(s)  # noqa: E731
            else:
                handler = lambda r, p=payload: httpx.Response(200, json=p)  # noqa: E731
        self.routes.insert(0, (url_part, handler))

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        for part, handler in self.routes:
            if part in str(request.url):
                return handler(request)
        raise AssertionError(f"unexpected request {request.method} {request.url}")


class FakeLLM:
    """Returns scripted completions in order and records what it was sent."""

    def __init__(self, *script: Completion | LLMError) -> None:
        self.script = list(script)
        self.calls: list[list[dict[str, Any]]] = []

    async def complete(self, messages, tools) -> Completion:
        self.calls.append(json.loads(json.dumps(messages)))
        if not self.script:
            raise AssertionError("FakeLLM ran out of scripted completions")
        step = self.script.pop(0)
        if isinstance(step, LLMError):
            raise step
        return step


def call(name: str, i: int = 0, **args: Any) -> Completion:
    return Completion(None, [ToolCall(f"c{i}", name, json.dumps(args))])


def say(text: str) -> Completion:
    return Completion(text)


@pytest.fixture(autouse=True)
def _reset_module_state(monkeypatch):
    geo._geocode_cache.clear()
    places._cache.clear()
    monkeypatch.setattr(geo, "_last_geocode", 0.0)
    monkeypatch.setattr(geo, "NOMINATIM_MIN_INTERVAL_S", 0.0)
    monkeypatch.setattr(geo, "NOMINATIM_RETRY_AFTER_S", 0.0)
    monkeypatch.setattr(places, "_overpass_down_until", 0.0)
    yield


@pytest.fixture
def settings(tmp_path) -> Settings:
    return Settings(
        _env_file=None,
        database_path=str(tmp_path / "t.db"),
        whatsapp_verify_token="verify-me",
        whatsapp_app_secret="",
        groq_api_key="",
        public_base_url="https://musafir.test",
        musafir_api_url="http://backend.test",
        overpass_urls="https://overpass-a.test/api,https://overpass-b.test/api",
    )


@pytest.fixture
def net() -> MockNet:
    return MockNet()


@pytest.fixture
async def http(net):
    async with httpx.AsyncClient(transport=httpx.MockTransport(net)) as client:
        yield client


@pytest.fixture
def store(settings):
    s = Store(settings.database_path)
    yield s
    s.close()


@pytest.fixture
def sender() -> RecordingSender:
    return RecordingSender()


@pytest.fixture
def make_agent(settings, store, sender, http):
    def _make(llm=None) -> Agent:
        return Agent(
            settings=settings,
            store=store,
            sender=sender,
            llm=llm,
            http=http,
            backend=BackendClient(http, settings.musafir_api_url),
        )

    return _make


_counter = iter(range(10**9))


def text_msg(text: str, phone: str = "919800000001") -> Inbound:
    return Inbound(f"wamid.{next(_counter)}", phone, "text", profile_name="Asha", text=text)


def location_msg(lat: float, lng: float, name: str | None = None, phone: str = "919800000001"):
    from app.channel import Location

    return Inbound(f"wamid.{next(_counter)}", phone, "location", location=Location(lat, lng, name))


def button_msg(button_id: str, phone: str = "919800000001") -> Inbound:
    return Inbound(f"wamid.{next(_counter)}", phone, "button", button_id=button_id, text="Confirm")
