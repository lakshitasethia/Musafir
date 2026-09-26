"""Talk to the agent from your terminal: same agent, real Groq + map/weather APIs, no WhatsApp.

    uv run python -m scripts.chat

Type messages normally. Special inputs:
    /loc <lat>,<lng> [name]   simulate sharing a WhatsApp location
    /tap <button id>          simulate tapping a button (ids are printed with each button message)
    /quit
"""

import asyncio
import itertools
import logging
import uuid

import httpx

from app.agent import Agent
from app.backend_client import BackendClient
from app.channel import Inbound, Location, RecordingSender
from app.config import Settings
from app.llm import GroqModel
from app.store import Store

PHONE = "10000000000"


def parse(line: str, n: int) -> Inbound | None:
    mid = f"cli-{n}-{uuid.uuid4().hex[:8]}"  # unique across runs, or dedup drops it
    if line.startswith("/loc "):
        coords, _, name = line[5:].strip().partition(" ")
        try:
            lat, lng = (float(x) for x in coords.split(","))
        except ValueError:
            print("usage: /loc 26.9239,75.8267 Hawa Mahal")
            return None
        return Inbound(mid, PHONE, "location", location=Location(lat, lng, name or None))
    if line.startswith("/tap "):
        return Inbound(mid, PHONE, "button", button_id=line[5:].strip())
    return Inbound(mid, PHONE, "text", profile_name="CLI", text=line)


async def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    settings = Settings()
    async with httpx.AsyncClient(headers={"User-Agent": settings.user_agent}) as http:
        llm = (
            GroqModel(http, settings.groq_api_key, settings.groq_models, settings.groq_base_url)
            if settings.groq_api_key
            else None
        )
        store = Store(settings.database_path)
        agent = Agent(
            settings=settings,
            store=store,
            sender=RecordingSender(echo=True),
            llm=llm,
            http=http,
            backend=BackendClient(http, settings.musafir_api_url),
        )
        await store.clear_session(PHONE)
        print("Musafir WhatsApp simulator. /loc lat,lng [name] · /tap <id> · /quit")
        for n in itertools.count():
            try:
                line = (await asyncio.to_thread(input, "you> ")).strip()
            except (EOFError, KeyboardInterrupt):
                break
            if line == "/quit":
                break
            if line and (msg := parse(line, n)):
                await agent.handle(msg)
        store.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nbye")
