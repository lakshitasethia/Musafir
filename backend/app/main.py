from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1 import health
from app.api.v1.router import api_router
from app.core.config import settings
from app.core.errors import register_error_handlers

TAGS = [
    {"name": "auth", "description": "Traveller sign-up, login, current user"},
    {"name": "users", "description": "Operator-managed staff accounts"},
    {"name": "ws", "description": "Real-time event WebSocket"},
    {"name": "health", "description": "Liveness of API, database and Redis"},
]

app = FastAPI(
    title="Musafir API",
    version="0.1.0",
    description="Personalized dynamic tour planning and operations. "
    "Errors are always `{error: {code, message, details}}`; see docs/api-contract.md.",
    openapi_tags=TAGS,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
register_error_handlers(app)
app.include_router(health.router)
app.include_router(api_router, prefix="/api/v1")
