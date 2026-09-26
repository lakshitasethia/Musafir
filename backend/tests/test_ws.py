import uuid

import pytest
from starlette.websockets import WebSocketDisconnect

from app.core.events import publish, role_channel, trip_channel, user_channel
from app.models.user import UserRole


def test_ws_rejects_without_token(client):
    for url in ("/api/v1/ws", "/api/v1/ws?token=garbage"):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(url):
                pass
        assert exc.value.code == 4401


def test_ws_receives_user_role_and_trip_events(client, make_user):
    user, headers = make_user(UserRole.coordinator)
    token = headers["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect(f"/api/v1/ws?token={token}") as ws:
        client.portal.call(publish, "system.ping", {"msg": "hi"}, [user_channel(user.id)])
        event = ws.receive_json()
        assert event["type"] == "system.ping"
        assert event["payload"] == {"msg": "hi"}
        assert set(event) == {"type", "id", "ts", "payload"}

        client.portal.call(publish, "system.ping", {}, [role_channel("coordinator")])
        assert ws.receive_json()["type"] == "system.ping"

        trip = trip_channel(uuid.uuid4())
        ws.send_json({"subscribe": trip})
        assert ws.receive_json()["payload"] == {"channel": trip}
        client.portal.call(publish, "system.ping", {"t": 1}, [trip])
        assert ws.receive_json()["payload"] == {"t": 1}

        ws.send_json({"subscribe": "user:someone-else"})
        assert ws.receive_json()["type"] == "ws.error"
