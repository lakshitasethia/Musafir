from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db
from app.core.deps import get_current_user
from app.core.security import create_access_token
from app.models.user import User, UserRole
from app.schemas.user import LoginIn, RegisterIn, TokenOut, UserOut
from app.services import users as user_service

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterIn, db: AsyncSession = Depends(get_db)) -> User:
    """Self sign-up. Always creates a traveller."""
    return await user_service.create_user(db, **body.model_dump(), role=UserRole.traveller)


@router.post("/login", response_model=TokenOut)
async def login(body: LoginIn, db: AsyncSession = Depends(get_db)) -> TokenOut:
    user = await user_service.authenticate(db, body.email, body.password)
    return TokenOut(
        access_token=create_access_token(user.id, user.role),
        expires_in=settings.jwt_expire_minutes * 60,
    )


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user
