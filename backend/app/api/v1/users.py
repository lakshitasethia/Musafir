from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db
from app.core.deps import require_roles
from app.models.user import User, UserRole
from app.schemas.user import UserCreateIn, UserOut
from app.services import users as user_service

router = APIRouter(prefix="/users", tags=["users"])


@router.post(
    "",
    response_model=UserOut,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(require_roles(UserRole.operator))],
)
async def create_staff_user(body: UserCreateIn, db: AsyncSession = Depends(get_db)) -> User:
    """Operator-only: create a coordinator or operator account."""
    return await user_service.create_user(db, **body.model_dump())
