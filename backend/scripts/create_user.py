"""Bootstrap staff accounts (registration only creates travellers).

python -m scripts.create_user admin@musafir.dev 'password123' 'Admin' --role operator
"""

import argparse
import asyncio

from app.core.db import SessionLocal
from app.models.user import UserRole
from app.services.users import create_user


async def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("email")
    p.add_argument("password")
    p.add_argument("full_name")
    p.add_argument("--role", choices=[r.value for r in UserRole], default="operator")
    args = p.parse_args()
    async with SessionLocal() as db:
        user = await create_user(
            db,
            email=args.email,
            password=args.password,
            full_name=args.full_name,
            role=UserRole(args.role),
        )
    print(f"Created {user.role} {user.email} ({user.id})")


if __name__ == "__main__":
    asyncio.run(main())
