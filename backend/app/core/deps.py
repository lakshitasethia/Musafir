from collections.abc import Callable, Coroutine
from typing import Any

from fastapi import Depends, Query
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.errors import AppError
from app.models.user import User, UserRole
from app.services import users as user_service

bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    creds: HTTPAuthorizationCredentials | None = Depends(bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    user = await user_service.get_by_token(db, creds.credentials) if creds else None
    if user is None:
        raise AppError(401, "Missing or invalid access token")
    return user


def require_roles(*roles: UserRole) -> Callable[..., Coroutine[Any, Any, User]]:
    async def dep(user: User = Depends(get_current_user)) -> User:
        if user.role not in roles:
            raise AppError(403, "You do not have access to this resource")
        return user

    return dep


class PageParams(BaseModel):
    limit: int
    offset: int


def page_params(limit: int = Query(20, ge=1, le=100), offset: int = Query(0, ge=0)) -> PageParams:
    return PageParams(limit=limit, offset=offset)
