from fastapi import APIRouter

from app.api.v1 import auth, users, ws
from app.schemas.common import ErrorResponse

api_router = APIRouter(responses={"4XX": {"model": ErrorResponse}})
api_router.include_router(auth.router)
api_router.include_router(users.router)
api_router.include_router(ws.router)
