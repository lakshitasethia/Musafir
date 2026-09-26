# Musafir API contract

Base URL: `/api/v1` (except `GET /health`). Interactive schema: `/docs`, raw: `/openapi.json`.

## Auth
- `POST /auth/login` returns `{access_token, token_type: "bearer", expires_in}`.
- Send `Authorization: Bearer <access_token>` on every authenticated request.
- Roles: `traveller`, `operator`, `coordinator`. `POST /auth/register` always creates a traveller;
  operators create staff through `POST /users`.

## Errors
Every non-2xx response has the same shape:

```json
{"error": {"code": "invalid_credentials", "message": "Invalid email or password", "details": null}}
```

- `code` is a stable snake_case string the UI can switch on. `message` is human-readable.
- `details` is optional extra data. For `validation_error` (422) it is the list of field errors
  (`[{loc, msg, type, ...}]`).
- Generic codes come from the HTTP status: `bad_request`, `unauthorized`, `forbidden`,
  `not_found`, `conflict`, `internal_error`, ... Domain codes override them (`email_taken`,
  `invalid_credentials`, `account_disabled`).

## Pagination
List endpoints take `?limit=` (1–100, default 20) and `?offset=` (default 0) and return:

```json
{"items": [...], "total": 123}
```

`total` is the count ignoring limit/offset.

## Data formats
- **IDs:** UUID strings.
- **Times:** ISO 8601 with a timezone, e.g. `2026-09-26T08:30:00Z` / `+00:00`. The server stores
  and returns UTC; send any offset.
- **Money:** INR as an integer number of **paise** (`₹1,250.50` → `125050`). Fields are suffixed
  `_paise`.

## Real-time
WebSocket at `/api/v1/ws?token=<access_token>`. See [events.md](events.md).
