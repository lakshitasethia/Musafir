.PHONY: up down logs migrate revision test lint seed

up:
	docker compose up -d --build

down:
	docker compose down

logs:
	docker compose logs -f

migrate:
	docker compose exec api alembic upgrade head

# make revision m="add trips table"
revision:
	docker compose exec api alembic revision --autogenerate -m "$(m)"

test:
	docker compose exec api pytest

lint:
	docker compose exec api sh -c "ruff check . && ruff format --check ."

seed:
	@echo "Nothing to seed yet (Phase 1)."
