"""Tests run against a throwaway database (<dev db>_test), rebuilt via Alembic each session.

All app I/O runs on the one event loop owned by the session-wide TestClient; run async
setup code through `client.portal.call(...)` so it shares that loop.
"""

import asyncio
import os
import uuid

import asyncpg
import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.engine import make_url

from app.core.config import settings

dev_url = make_url(settings.database_url)
test_url = make_url(
    os.environ.get("TEST_DATABASE_URL") or dev_url.set(database=f"{dev_url.database}_test")
)
# must happen before app.core.db creates its engine
settings.database_url = test_url.render_as_string(hide_password=False)
settings.llm_mock = True

from fastapi.testclient import TestClient  # noqa: E402

from app.main import app  # noqa: E402


async def _recreate_test_db() -> None:
    admin = test_url.set(drivername="postgresql", database="postgres")
    conn = await asyncpg.connect(admin.render_as_string(hide_password=False))
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{test_url.database}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{test_url.database}"')
    finally:
        await conn.close()


@pytest.fixture(scope="session")
def client():
    asyncio.run(_recreate_test_db())
    cfg = Config("alembic.ini")
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")
    with TestClient(app) as c:
        yield c


@pytest.fixture
def make_user(client):
    """Create a user of any role directly; returns (user, auth headers)."""
    from app.core.db import SessionLocal
    from app.models.user import UserRole
    from app.services.users import create_user

    async def _create(role: UserRole):
        async with SessionLocal() as db:
            return await create_user(
                db,
                email=f"{role}-{uuid.uuid4().hex[:8]}@test.dev",
                password="password123",
                full_name=f"Test {role}",
                role=role,
            )

    def factory(role: UserRole = UserRole.traveller):
        user = client.portal.call(_create, role)
        r = client.post("/api/v1/auth/login", json={"email": user.email, "password": "password123"})
        return user, {"Authorization": f"Bearer {r.json()['access_token']}"}

    return factory
