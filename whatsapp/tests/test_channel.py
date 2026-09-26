import hashlib
import hmac

from app.channel import parse_webhook, split_text, to_whatsapp_markup, verify_signature


def _payload(*messages, contacts=None, statuses=None):
    value = {"messaging_product": "whatsapp", "messages": list(messages)}
    if contacts is not None:
        value["contacts"] = contacts
    if statuses is not None:
        value["statuses"] = statuses
    return {
        "object": "whatsapp_business_account",
        "entry": [{"id": "1", "changes": [{"field": "messages", "value": value}]}],
    }


def test_parses_text_with_profile_name():
    p = _payload(
        {"id": "m1", "from": "9198", "type": "text", "text": {"body": "  hi  "}},
        contacts=[{"wa_id": "9198", "profile": {"name": "Asha"}}],
    )
    [msg] = parse_webhook(p)
    assert (msg.kind, msg.text, msg.phone, msg.profile_name) == ("text", "hi", "9198", "Asha")


def test_parses_location_and_rejects_bad_coordinates():
    good = {
        "id": "m1",
        "from": "1",
        "type": "location",
        "location": {"latitude": 26.92, "longitude": 75.82, "name": "Hawa Mahal"},
    }
    bad = {"id": "m2", "from": "1", "type": "location", "location": {"latitude": "x"}}
    out_of_range = {
        "id": "m3",
        "from": "1",
        "type": "location",
        "location": {"latitude": 120, "longitude": 10},
    }
    a, b, c = parse_webhook(_payload(good, bad, out_of_range))
    assert a.kind == "location" and a.location.lat == 26.92 and a.location.name == "Hawa Mahal"
    assert b.kind == "unsupported" and c.kind == "unsupported"


def test_parses_button_and_list_replies():
    btn = {
        "id": "m1",
        "from": "1",
        "type": "interactive",
        "interactive": {
            "type": "button_reply",
            "button_reply": {"id": "pa:x:yes", "title": "Confirm"},
        },
    }
    lst = {
        "id": "m2",
        "from": "1",
        "type": "interactive",
        "interactive": {"type": "list_reply", "list_reply": {"id": "row-2", "title": "Two"}},
    }
    a, b = parse_webhook(_payload(btn, lst))
    assert (a.kind, a.button_id) == ("button", "pa:x:yes")
    assert (b.kind, b.button_id, b.text) == ("button", "row-2", "Two")


def test_media_is_unsupported_and_statuses_ignored():
    img = {"id": "m1", "from": "1", "type": "image", "image": {"id": "media"}}
    p = _payload(img, statuses=[{"id": "m0", "status": "delivered"}])
    [msg] = parse_webhook(p)
    assert msg.kind == "unsupported" and msg.raw_type == "image"
    assert parse_webhook(_payload(statuses=[{"status": "read"}])) == []


def test_garbage_payloads_do_not_raise():
    for junk in (
        None,
        [],
        "x",
        {"entry": None},
        {"entry": [None]},
        {"entry": [{"changes": [None]}]},
        _payload({"from": "1", "type": "text"}),
        _payload("not-a-dict"),
    ):
        assert parse_webhook(junk) == []


def test_empty_text_is_unsupported():
    [msg] = parse_webhook(
        _payload({"id": "m", "from": "1", "type": "text", "text": {"body": "  "}})
    )
    assert msg.kind == "unsupported"


def test_signature():
    body = b'{"a":1}'
    sig = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
    assert verify_signature("secret", body, sig)
    assert not verify_signature("secret", body + b" ", sig)
    assert not verify_signature("secret", body, None)
    assert not verify_signature("secret", body, "md5=abc")


def test_markup_conversion():
    assert to_whatsapp_markup("**Jantar Mantar** is __close__") == "*Jantar Mantar* is _close_"
    assert to_whatsapp_markup("## Options\n[map](https://x.y/z)") == "*Options*\nmap: https://x.y/z"


def test_split_text_respects_limit_and_boundaries():
    text = ("word " * 50 + "\n\n") * 10
    chunks = split_text(text, limit=300)
    assert all(len(c) <= 300 for c in chunks)
    assert "".join(chunks).replace(" ", "").replace("\n", "") == text.replace(" ", "").replace(
        "\n", ""
    )
    assert split_text("x" * 650, limit=300) == ["x" * 300, "x" * 300, "x" * 50]
    assert split_text("   ") == []
