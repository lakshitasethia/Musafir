"""SQLite persistence: per-phone session state, account links, link codes, webhook dedup.

Kept deliberately separate from the backend's Postgres so this service can run on its own.
"""

import asyncio
import json
import sqlite3
import threading
import time
from dataclasses import dataclass, field
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    phone TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS links (
    phone TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    email TEXT NOT NULL,
    full_name TEXT NOT NULL,
    linked_at REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS link_codes (
    code TEXT PRIMARY KEY,
    phone TEXT NOT NULL,
    expires_at REAL NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS processed_messages (
    message_id TEXT PRIMARY KEY,
    seen_at REAL NOT NULL
);
"""

DEDUP_TTL_SECONDS = 3 * 24 * 3600  # Meta retries failed deliveries for up to ~3 days


@dataclass
class Session:
    phone: str
    history: list[dict[str, str]] = field(default_factory=list)
    location: dict[str, Any] | None = None  # {lat, lng, label, at}
    places: list[dict[str, Any]] = field(default_factory=list)  # last numbered search results
    pending: dict[str, Any] | None = None  # action awaiting a Confirm tap
    # numbered Musafir trip context (ids never shown to the model; it uses the numbers)
    trips: list[dict[str, Any]] = field(default_factory=list)
    trip: dict[str, Any] | None = None  # {id, destination, day, date} currently in view
    stops: list[dict[str, Any]] = field(default_factory=list)
    cards: list[dict[str, Any]] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps(
            {
                "history": self.history,
                "location": self.location,
                "places": self.places,
                "pending": self.pending,
                "trips": self.trips,
                "trip": self.trip,
                "stops": self.stops,
                "cards": self.cards,
            }
        )


@dataclass
class Link:
    phone: str
    access_token: str
    email: str
    full_name: str
    linked_at: float


class Store:
    def __init__(self, path: str) -> None:
        self._conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.Lock()
        with self._lock:
            if path != ":memory:":
                self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(SCHEMA)

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    def _run(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        with self._lock:
            return self._conn.execute(sql, params).fetchall()

    async def _q(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return await asyncio.to_thread(self._run, sql, params)

    # --- sessions ---
    async def get_session(self, phone: str) -> Session:
        rows = await self._q("SELECT data FROM sessions WHERE phone = ?", (phone,))
        if not rows:
            return Session(phone=phone)
        try:
            data = json.loads(rows[0]["data"])
        except (json.JSONDecodeError, TypeError):
            return Session(phone=phone)  # corrupt row: start fresh rather than crash the phone
        return Session(
            phone=phone,
            history=data.get("history") or [],
            location=data.get("location"),
            places=data.get("places") or [],
            pending=data.get("pending"),
            trips=data.get("trips") or [],
            trip=data.get("trip"),
            stops=data.get("stops") or [],
            cards=data.get("cards") or [],
        )

    async def save_session(self, session: Session) -> None:
        await self._q(
            "INSERT INTO sessions (phone, data, updated_at) VALUES (?, ?, ?) "
            "ON CONFLICT(phone) DO UPDATE SET "
            "data = excluded.data, updated_at = excluded.updated_at",
            (session.phone, session.to_json(), time.time()),
        )

    async def clear_session(self, phone: str) -> None:
        await self._q("DELETE FROM sessions WHERE phone = ?", (phone,))

    # --- account links ---
    async def get_link(self, phone: str) -> Link | None:
        rows = await self._q("SELECT * FROM links WHERE phone = ?", (phone,))
        return Link(**dict(rows[0])) if rows else None

    async def save_link(self, phone: str, access_token: str, email: str, full_name: str) -> None:
        await self._q(
            "INSERT INTO links (phone, access_token, email, full_name, linked_at) "
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT(phone) DO UPDATE SET "
            "access_token = excluded.access_token, email = excluded.email, "
            "full_name = excluded.full_name, linked_at = excluded.linked_at",
            (phone, access_token, email, full_name, time.time()),
        )

    async def delete_link(self, phone: str) -> bool:
        existed = await self.get_link(phone) is not None
        await self._q("DELETE FROM links WHERE phone = ?", (phone,))
        return existed

    # --- one-time link codes ---
    async def create_link_code(self, code: str, phone: str, ttl_seconds: int) -> None:
        # one live code per phone: asking again invalidates the previous link
        await self._q(
            "DELETE FROM link_codes WHERE phone = ? OR expires_at < ?", (phone, time.time())
        )
        await self._q(
            "INSERT INTO link_codes (code, phone, expires_at) VALUES (?, ?, ?)",
            (code, phone, time.time() + ttl_seconds),
        )

    async def get_link_code(self, code: str) -> sqlite3.Row | None:
        rows = await self._q(
            "SELECT * FROM link_codes WHERE code = ? AND expires_at >= ?", (code, time.time())
        )
        return rows[0] if rows else None

    async def bump_link_attempts(self, code: str, max_attempts: int) -> None:
        await self._q("UPDATE link_codes SET attempts = attempts + 1 WHERE code = ?", (code,))
        await self._q(
            "DELETE FROM link_codes WHERE code = ? AND attempts >= ?", (code, max_attempts)
        )

    async def consume_link_code(self, code: str) -> None:
        await self._q("DELETE FROM link_codes WHERE code = ?", (code,))

    # --- webhook dedup ---
    async def mark_processed(self, message_id: str) -> bool:
        """True the first time a message id is seen, False for a redelivery."""
        now = time.time()
        await self._q(
            "DELETE FROM processed_messages WHERE seen_at < ?", (now - DEDUP_TTL_SECONDS,)
        )
        rows = await self._q(
            "INSERT OR IGNORE INTO processed_messages (message_id, seen_at) VALUES (?, ?) "
            "RETURNING message_id",
            (message_id, now),
        )
        return bool(rows)
