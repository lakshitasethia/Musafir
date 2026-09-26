import json
import logging
from contextlib import asynccontextmanager

import httpx
from fastapi import BackgroundTasks, FastAPI, Form, Query, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse

from app.agent import Agent
from app.backend_client import BackendClient, BackendError, BackendUnavailable
from app.channel import RecordingSender, Sender, WhatsAppClient, parse_webhook, verify_signature
from app.config import Settings
from app.link_page import link_form, message_page
from app.llm import ChatModel, GroqModel
from app.store import Store

log = logging.getLogger("musafir.whatsapp")


def create_app(
    settings: Settings | None = None,
    *,
    http: httpx.AsyncClient | None = None,
    llm: ChatModel | None = None,
    sender: Sender | None = None,
    store: Store | None = None,
) -> FastAPI:
    """Everything injectable so tests can swap the network, the model and the sender."""
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        own_http = http is None
        client = http or httpx.AsyncClient(headers={"User-Agent": settings.user_agent})
        db = store or Store(settings.database_path)
        out: Sender
        if sender is not None:
            out = sender
        elif settings.whatsapp_enabled:
            out = WhatsAppClient(
                client,
                settings.whatsapp_access_token,
                settings.whatsapp_phone_number_id,
                settings.whatsapp_api_version,
            )
        else:
            log.warning(
                "WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID not set: outbound messages are logged"
            )
            out = RecordingSender()
        model = llm
        if model is None and settings.groq_api_key:
            model = GroqModel(
                client, settings.groq_api_key, settings.groq_models, settings.groq_base_url
            )
        if model is None:
            log.warning("GROQ_API_KEY not set: the agent will only answer built-in commands")
        if not settings.whatsapp_app_secret:
            log.warning("WHATSAPP_APP_SECRET not set: webhook signatures are NOT verified")

        backend = BackendClient(client, settings.musafir_api_url)
        app.state.store = db
        app.state.sender = out
        app.state.backend = backend
        app.state.agent = Agent(
            settings=settings, store=db, sender=out, llm=model, http=client, backend=backend
        )
        try:
            yield
        finally:
            if own_http:
                await client.aclose()
            if store is None:
                db.close()

    app = FastAPI(title="Musafir WhatsApp", version="0.1.0", lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict:
        return {
            "status": "ok",
            "whatsapp_configured": settings.whatsapp_enabled,
            "llm_configured": app.state.agent.llm is not None,
        }

    # ------------------------------------------------------------ webhook

    @app.get("/webhook", response_class=PlainTextResponse)
    async def verify_webhook(
        mode: str | None = Query(None, alias="hub.mode"),
        token: str | None = Query(None, alias="hub.verify_token"),
        challenge: str | None = Query(None, alias="hub.challenge"),
    ) -> Response:
        """Meta calls this once when you save the webhook URL in the dashboard."""
        if (
            mode == "subscribe"
            and settings.whatsapp_verify_token
            and token == settings.whatsapp_verify_token
            and challenge is not None
        ):
            return PlainTextResponse(challenge)
        return PlainTextResponse("verification failed", status_code=403)

    @app.post("/webhook")
    async def receive_webhook(request: Request, background: BackgroundTasks) -> Response:
        body = await request.body()
        if settings.whatsapp_app_secret and not verify_signature(
            settings.whatsapp_app_secret, body, request.headers.get("x-hub-signature-256")
        ):
            return JSONResponse({"error": "invalid signature"}, status_code=403)
        try:
            payload = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return JSONResponse({"error": "invalid JSON"}, status_code=400)

        # acknowledge immediately; Meta retries (and eventually disables) slow webhooks
        agent: Agent = app.state.agent
        for msg in parse_webhook(payload):
            background.add_task(agent.handle, msg)
        return JSONResponse({"status": "received"})

    # ------------------------------------------------------------ account linking

    @app.get("/link/{code}", response_class=HTMLResponse)
    async def link_get(code: str) -> HTMLResponse:
        if await app.state.store.get_link_code(code) is None:
            return _expired()
        return HTMLResponse(link_form(code))

    @app.post("/link/{code}", response_class=HTMLResponse)
    async def link_post(
        code: str,
        mode: str = Form("login"),
        email: str = Form(""),
        password: str = Form(""),
        full_name: str = Form(""),
    ) -> HTMLResponse:
        db: Store = app.state.store
        backend: BackendClient = app.state.backend
        row = await db.get_link_code(code)
        if row is None:
            return _expired()
        phone = row["phone"]
        email, full_name = email.strip(), full_name.strip()

        def retry(msg: str, status: int = 400) -> HTMLResponse:
            return HTMLResponse(link_form(code, msg, email, full_name), status_code=status)

        if not email or not password:
            return retry("Enter your email and password.")
        try:
            if mode == "register":
                if not full_name:
                    return retry("Enter your full name.")
                if not 8 <= len(password) <= 72:
                    return retry("Password must be 8 to 72 characters.")
                await backend.register(email, password, full_name, f"+{phone}")
            token = await backend.login(email, password)
            me = await backend.me(token)
        except BackendError as e:
            await db.bump_link_attempts(code, settings.link_max_attempts)
            if await db.get_link_code(code) is None:
                return _expired("Too many attempts. Ask Musafir on WhatsApp for a new link.")
            if e.code == "email_taken":
                return retry("That email already has an account. Sign in above instead.")
            if e.code == "invalid_credentials":
                return retry("Email or password is incorrect.")
            return retry(e.message)
        except BackendUnavailable:
            return retry(
                "Musafir servers are unreachable right now. Please try again shortly.", 503
            )
        if me.get("role") != "traveller":
            # Operator powers (approvals, autonomy rules, locked bookings) stay in the web console.
            return retry(
                "Operator accounts can't be linked to WhatsApp. "
                "Use the Operations console on the web.",
                403,
            )

        await db.save_link(phone, token, me.get("email", email), me.get("full_name", full_name))
        await db.consume_link_code(code)
        name = me.get("full_name") or "there"
        try:
            await app.state.sender.send_text(
                phone, f"You're linked, {name}. Your Musafir account is now connected here."
            )
        except Exception:
            log.exception("link confirmation message failed")
        return HTMLResponse(
            message_page("You're linked", "Head back to WhatsApp and keep chatting.", ok=True)
        )

    return app


def _expired(
    text: str = "This link has expired or was already used. "
    'Message Musafir on WhatsApp "link my account" for a new one.',
) -> HTMLResponse:
    return HTMLResponse(message_page("Link expired", text), status_code=410)


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
app = create_app()
