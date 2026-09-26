# Musafir backend

API backend for Musafir, a personalized dynamic tour planning and tour operations platform
(hackathon). Journey: Discover → Personalize → Plan → Price → Book → Prepare → Operate → Assist →
Adapt → Complete → Review. The UI is a separate Next.js app (repo root) built by a teammate
against this API, so keep OpenAPI clean and tagged.

Read first: `docs/musafir-research-and-architecture.md`, `docs/musafir-implementation-plan.md`,
`docs/api-contract.md`, `docs/events.md`.

Stack: Python 3.12, uv, FastAPI, Pydantic v2, SQLAlchemy 2.0 async (asyncpg), Alembic,
Postgres 16 + pgvector, Redis 7, Celery + beat, JWT (PyJWT) + passlib[bcrypt], Ruff, pytest.

## Structure
```
app/
  main.py        FastAPI app, CORS, error handlers, routers
  core/          config, db (engine/session), security (JWT, hashing), deps (auth, roles,
                 pagination), errors (AppError + envelope handlers), events (Redis pub/sub)
  models/        SQLAlchemy models; TimestampedBase = UUID pk + created_at/updated_at.
                 Import new models in models/__init__.py so autogenerate sees them.
  schemas/       Pydantic request/response models (common.py: ErrorResponse, Page[T])
  api/v1/        one router per domain, wired in router.py (health.py is mounted at /health)
  services/      business logic
  engines/       planner (OR-Tools) / impact (NetworkX) / assignment (CP-SAT)
  ai/            Gemini client + assistant agent
  integrations/  external APIs (Places, ORS, Open-Meteo, Viator, LiteAPI, Razorpay)
  workers/       celery_app.py (beat_schedule lives here) + tasks.py
migrations/      Alembic (async env)
scripts/         one-off CLIs, run as `python -m scripts.<name>`
tests/
docs/
```

## Commands
```
cp .env.example .env     # then set JWT_SECRET
make up                  # build + start db, redis, api, worker, beat
make migrate             # alembic upgrade head
make revision m="msg"    # autogenerate a migration
make test | make lint | make logs | make down
docker compose exec api python -m scripts.create_user me@x.dev 'pass1234' 'Me' --role operator
```
API: http://localhost:8000/docs. Postgres is on host port 5433, Redis on 6379.

## Conventions
- Services hold business logic; routers stay thin (parse input, call a service, return).
- Raise `AppError(status, message, code=...)` for expected failures; never return ad-hoc error
  bodies. Errors are always `{"error": {"code", "message", "details"}}`.
- Lists: `page_params` dependency + `Page[T]` response (`{items, total}`).
- IDs are UUIDs, times are tz-aware ISO 8601 (UTC), money is INR in integer paise (`*_paise`).
- Guard routes with `Depends(get_current_user)` or `Depends(require_roles(UserRole.operator, ...))`.
- Every new route needs tests.
- Every new WebSocket event must be added to `docs/events.md`; publish with
  `app.core.events.publish(type, payload, channels)`.
- Never call Gemini in tests: `LLM_MOCK=true` (conftest forces it).
- Schema changes go through Alembic migrations, never `create_all`.

## Tests
`tests/conftest.py` drops and recreates `<db>_test` (or `TEST_DATABASE_URL`) and runs migrations
each session. A session-wide `TestClient` owns the event loop; run async setup through
`client.portal.call(fn, *args)`. `make_user(role)` fixture returns `(user, auth_headers)`.
