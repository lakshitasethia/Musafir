from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security import decode_access_token, hash_password, verify_password
from app.models.user import User, UserRole


async def create_user(
    db: AsyncSession,
    *,
    email: str,
    password: str,
    full_name: str,
    role: UserRole,
    phone: str | None = None,
) -> User:
    user = User(
        email=email.lower(),
        hashed_password=hash_password(password),
        full_name=full_name,
        phone=phone,
        role=role,
    )
    db.add(user)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError(409, "Email is already registered", code="email_taken") from None
    await db.refresh(user)
    return user


async def authenticate(db: AsyncSession, email: str, password: str) -> User:
    user = await db.scalar(select(User).where(User.email == email.lower()))
    if user is None or not verify_password(password, user.hashed_password):
        raise AppError(401, "Invalid email or password", code="invalid_credentials")
    if not user.is_active:
        raise AppError(403, "Account is disabled", code="account_disabled")
    return user


async def get_by_token(db: AsyncSession, token: str) -> User | None:
    """Active user for a valid access token, else None."""
    user_id = decode_access_token(token)
    user = await db.get(User, user_id) if user_id else None
    return user if user and user.is_active else None
