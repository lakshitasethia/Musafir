"""HTTP surface: webhook verification/signatures and the account-link page."""

import hashlib
import hmac
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from tests.conftest import FakeLLM, MockNet, say

PHONE = "919800000001"


def _text_payload(mid="wamid.1", body="hi"):
    return {
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "contacts": [{"wa_id": PHONE, "profile": {"name": "Asha"}}],
                            "messages": [
                                {"id": mid, "from": PHONE, "type": "text", "text": {"body": body}}
                            ],
                        },
                    }
                ]
            }
        ]
    }


@pytest.fixture
def mock_net():
    return MockNet()


@pytest.fixture
def app_factory(settings, sender, store, mock_net):
    clients = []

    def make(llm=None, **overrides):
        for k, v in overrides.items():
            setattr(settings, k, v)
        http = httpx.AsyncClient(transport=httpx.MockTransport(mock_net))
        app = create_app(settings, http=http, llm=llm, sender=sender, store=store)
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for c in clients:
        c.__exit__(None, None, None)


def test_webhook_verification(app_factory):
    c = app_factory()
    ok = c.get(
        "/webhook",
        params={"hub.mode": "subscribe", "hub.verify_token": "verify-me", "hub.challenge": "12345"},
    )
    assert ok.status_code == 200 and ok.text == "12345"
    bad = c.get(
        "/webhook",
        params={"hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "1"},
    )
    assert bad.status_code == 403
    assert c.get("/webhook").status_code == 403


def test_webhook_rejects_verify_when_token_unset(app_factory):
    c = app_factory(whatsapp_verify_token="")
    r = c.get(
        "/webhook", params={"hub.mode": "subscribe", "hub.verify_token": "", "hub.challenge": "1"}
    )
    assert r.status_code == 403


def test_webhook_processes_message(app_factory, sender):
    c = app_factory(FakeLLM(say("Hello Asha!")))
    r = c.post("/webhook", json=_text_payload())
    assert r.status_code == 200
    assert sender.sent[-1].body == "Hello Asha!" and sender.sent[-1].to == PHONE


def test_webhook_signature_enforced_when_secret_set(app_factory, sender):
    c = app_factory(FakeLLM(say("signed ok")), whatsapp_app_secret="s3cret")
    body = json.dumps(_text_payload("wamid.sig")).encode()
    r = c.post("/webhook", content=body, headers={"x-hub-signature-256": "sha256=deadbeef"})
    assert r.status_code == 403 and sender.sent == []
    sig = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
    r = c.post(
        "/webhook",
        content=body,
        headers={"x-hub-signature-256": sig, "content-type": "application/json"},
    )
    assert r.status_code == 200 and sender.sent[-1].body == "signed ok"


def test_webhook_bad_json_and_status_only(app_factory, sender):
    c = app_factory()
    assert c.post("/webhook", content=b"{nope").status_code == 400
    status_only = {
        "entry": [
            {
                "changes": [
                    {
                        "field": "messages",
                        "value": {"statuses": [{"id": "x", "status": "delivered"}]},
                    }
                ]
            }
        ]
    }
    assert c.post("/webhook", json=status_only).status_code == 200
    assert sender.sent == []


# ------------------------------------------------------------ link page


def _backend(mock_net, *, login_status=200, register_status=200, role="traveller"):
    """Mimics the Musafir Next.js API: cookie sessions, {"error": "..."} bodies."""

    def login(r):
        if login_status != 200:
            return httpx.Response(login_status, json={"error": "Wrong email or password"})
        return httpx.Response(
            200,
            json={"user": {"email": "asha@x.dev"}},
            headers={"set-cookie": "mz_session=sess-1; Path=/; HttpOnly; SameSite=lax"},
        )

    def register(r):
        if register_status == 409:
            return httpx.Response(409, json={"error": "An account with this email already exists"})
        body = json.loads(r.content)
        assert body["role"] == "traveller" and body["name"]
        return httpx.Response(200, json={"user": {"email": body["email"]}})

    def me(r):
        assert r.headers["cookie"] == "mz_session=sess-1"
        return httpx.Response(
            200, json={"user": {"email": "asha@x.dev", "name": "Asha K", "role": role}}
        )

    mock_net.on("/api/auth/login", login)
    mock_net.on("/api/auth/signup", register)
    mock_net.on("/api/auth/me", me)


def _code(c, store):
    code = "code-abc"
    c.portal.call(store.create_link_code, code, PHONE, 600)
    return code


def test_link_login_success(app_factory, store, sender, mock_net):
    _backend(mock_net)
    c = app_factory()
    code = _code(c, store)
    assert "Connect WhatsApp" in c.get(f"/link/{code}").text
    r = c.post(
        f"/link/{code}", data={"mode": "login", "email": "asha@x.dev", "password": "pw123456"}
    )
    assert r.status_code == 200 and "linked" in r.text
    link = c.portal.call(store.get_link, PHONE)
    assert link.access_token == "sess-1" and link.full_name == "Asha K"
    assert "linked, Asha K" in sender.sent[-1].body
    # single use
    assert c.get(f"/link/{code}").status_code == 410


def test_operator_accounts_cannot_link(app_factory, store, mock_net):
    _backend(mock_net, role="operator")
    c = app_factory()
    code = _code(c, store)
    r = c.post(f"/link/{code}", data={"mode": "login", "email": "op@x.dev", "password": "pw123456"})
    assert r.status_code == 403 and "Operator accounts" in r.text
    assert c.portal.call(store.get_link, PHONE) is None


def test_link_register_success(app_factory, store, mock_net):
    _backend(mock_net)
    c = app_factory()
    code = _code(c, store)
    r = c.post(
        f"/link/{code}",
        data={"mode": "register", "email": "new@x.dev", "password": "pw123456", "full_name": "New"},
    )
    assert r.status_code == 200
    assert c.portal.call(store.get_link, PHONE) is not None


def test_link_errors_and_attempt_limit(app_factory, store, mock_net, settings):
    _backend(mock_net, login_status=401)
    c = app_factory(link_max_attempts=2)
    code = _code(c, store)
    r = c.post(f"/link/{code}", data={"mode": "login", "email": "a@x.dev", "password": "wrongpass"})
    assert r.status_code == 400 and "incorrect" in r.text and "a@x.dev" in r.text
    r = c.post(f"/link/{code}", data={"mode": "login", "email": "a@x.dev", "password": "wrongpass"})
    assert r.status_code == 410 and "Too many attempts" in r.text


def test_link_register_validation_and_taken_email(app_factory, store, mock_net):
    _backend(mock_net, register_status=409)
    c = app_factory()
    code = _code(c, store)
    r = c.post(
        f"/link/{code}",
        data={"mode": "register", "email": "a@x.dev", "password": "short", "full_name": "A"},
    )
    assert "8 to 72" in r.text
    r = c.post(
        f"/link/{code}",
        data={"mode": "register", "email": "a@x.dev", "password": "pw123456", "full_name": ""},
    )
    assert "full name" in r.text
    r = c.post(
        f"/link/{code}",
        data={"mode": "register", "email": "a@x.dev", "password": "pw123456", "full_name": "A"},
    )
    assert "already has an account" in r.text


def test_link_backend_down(app_factory, store, mock_net):
    def down(r):
        raise httpx.ConnectError("refused")

    mock_net.on("/api/auth/", down)
    c = app_factory()
    code = _code(c, store)
    r = c.post(f"/link/{code}", data={"mode": "login", "email": "a@x.dev", "password": "pw123456"})
    assert r.status_code == 503 and "unreachable" in r.text
    assert c.get(f"/link/{code}").status_code == 200  # code still usable


def test_link_page_escapes_input(app_factory, store, mock_net):
    _backend(mock_net, login_status=401)
    c = app_factory()
    code = _code(c, store)
    r = c.post(
        f"/link/{code}",
        data={"mode": "login", "email": "<script>x</script>@x.dev", "password": "pw123456"},
    )
    assert "<script>x" not in r.text


def test_unknown_link_code(app_factory):
    assert app_factory().get("/link/does-not-exist").status_code == 410
