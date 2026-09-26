import asyncio
import json
from uuid import UUID

from fastapi import APIRouter, WebSocket, WebSocketDisconnect, status

from app.core.db import SessionLocal
from app.core.errors import AppError
from app.core.events import make_event, redis, role_channel, trip_channel, user_channel
from app.schemas.common import ErrorResponse
from app.services import users as user_service

router = APIRouter(tags=["ws"])

WS_DOC = """\
**WebSocket** — connect with `ws://<host>/api/v1/ws?token=<access_token>`.
Swagger can't open sockets; this GET only documents the protocol and returns 426.

- On connect you are subscribed to `user:<your id>` and `role:<your role>`.
- Send `{"subscribe": "trip:<trip id>"}` to also receive a trip's events.
- Every server message is an envelope `{type, id, ts, payload}`. See `docs/events.md`.
- A missing or invalid token closes the socket with code 4401 before it opens.
"""


@router.get(
    "/ws",
    summary="Real-time events (WebSocket)",
    description=WS_DOC,
    status_code=status.HTTP_426_UPGRADE_REQUIRED,
    responses={426: {"model": ErrorResponse}},
)
async def ws_docs() -> None:
    raise AppError(426, "Connect with a WebSocket client")


@router.websocket("/ws")
async def ws(websocket: WebSocket, token: str | None = None) -> None:
    async with SessionLocal() as db:
        user = await user_service.get_by_token(db, token) if token else None
    if user is None:
        await websocket.close(code=4401, reason="Invalid token")
        return

    pubsub = redis.pubsub()
    # subscribe before accept so nothing published after the handshake is missed
    await pubsub.subscribe(user_channel(user.id), role_channel(user.role))
    await websocket.accept()

    async def forward() -> None:
        async for msg in pubsub.listen():
            if msg["type"] == "message":
                await websocket.send_text(msg["data"])

    forwarder = asyncio.create_task(forward())
    try:
        while True:
            try:
                msg = json.loads(await websocket.receive_text())
                channel = msg["subscribe"]
                prefix, trip_id = channel.split(":", 1)
                if prefix != "trip":
                    raise ValueError
                # ponytail: any user may join any trip channel; check trip access in Phase 1
                channel = trip_channel(UUID(trip_id))
            except (ValueError, KeyError, TypeError, AttributeError):
                err = make_event("ws.error", {"message": 'Expected {"subscribe": "trip:<uuid>"}'})
                await websocket.send_json(err)
                continue
            await pubsub.subscribe(channel)
            await websocket.send_json(make_event("ws.subscribed", {"channel": channel}))
    except WebSocketDisconnect:
        pass
    finally:
        forwarder.cancel()
        await pubsub.aclose()
