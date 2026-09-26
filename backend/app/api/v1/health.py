import asyncio

from fastapi import APIRouter, Response
from sqlalchemy import text

from app.core.db import SessionLocal
from app.core.events import redis
from app.schemas.health import HealthOut

router = APIRouter(tags=["health"])


async def _ok(check) -> bool:
    try:
        await asyncio.wait_for(check(), timeout=2)
        return True
    except Exception:
        return False


async def _db() -> None:
    async with SessionLocal() as db:
        await db.execute(text("SELECT 1"))


@router.get("/health", response_model=HealthOut, responses={503: {"model": HealthOut}})
async def health(response: Response) -> HealthOut:
    """DB and Redis status. 503 when either is down."""
    db_ok, redis_ok = await asyncio.gather(_ok(_db), _ok(redis.ping))
    if not (db_ok and redis_ok):
        response.status_code = 503
    return HealthOut(
        status="ok" if db_ok and redis_ok else "degraded",
        db="ok" if db_ok else "error",
        redis="ok" if redis_ok else "error",
    )
