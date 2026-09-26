# Import every model here so Alembic autogenerate sees it.
from app.models.base import Base
from app.models.user import User, UserRole

__all__ = ["Base", "User", "UserRole"]
