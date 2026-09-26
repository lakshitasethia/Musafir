"""Event bus: Redis pub/sub fanned out to WebSocket clients. Catalog: docs/events.md."""

import json
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

from fastapi.encoders import jsonable_encoder
from redis.asyncio import Redis

from app.core.config import settings

redis = Redis.from_url(settings.redis_url, decode_responses=True)


def user_channel(user_id: UUID | str) -> str:
    return f"user:{user_id}"


def role_channel(role: str) -> str:
    return f"role:{role}"


def trip_channel(trip_id: UUID | str) -> str:
    return f"trip:{trip_id}"


def make_event(event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": event_type,
        "id": str(uuid4()),
        "ts": datetime.now(UTC).isoformat(),
        "payload": jsonable_encoder(payload),
    }


async def publish(event_type: str, payload: dict[str, Any], channels: list[str]) -> dict:
    event = make_event(event_type, payload)
    data = json.dumps(event)
    for channel in channels:
        await redis.publish(channel, data)
    return event
