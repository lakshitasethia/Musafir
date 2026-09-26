# Event catalog

Every WebSocket message from the server is an envelope:

```json
{"type": "system.ping", "id": "6f1c…", "ts": "2026-09-26T08:30:00.123456+00:00", "payload": {}}
```

| Field | Meaning |
|---|---|
| `type` | `<domain>.<event>`, e.g. `trip.updated` |
| `id` | UUID of this event (dedupe on it) |
| `ts` | ISO 8601 UTC time the event was published |
| `payload` | event-specific object, documented below |

## Connecting
`ws://<host>/api/v1/ws?token=<access_token>`. A missing/invalid token closes with code **4401**.

## Channels
| Channel | Who is subscribed |
|---|---|
| `user:<user_id>` | that user, automatically |
| `role:<role>` | every user with that role, automatically |
| `trip:<trip_id>` | clients that send `{"subscribe": "trip:<trip_id>"}` |

Server side: `await publish(event_type, payload, channels)` from `app.core.events`.

## Events

### `system.ping`
Connectivity test. No fixed publisher.
```json
{"type": "system.ping", "id": "…", "ts": "…", "payload": {"msg": "hi"}}
```

### `ws.subscribed`
Sent to the client after a successful `{"subscribe": …}`.
```json
{"type": "ws.subscribed", "id": "…", "ts": "…", "payload": {"channel": "trip:0b7e…"}}
```

### `ws.error`
Sent to the client when its message can't be handled; the socket stays open.
```json
{"type": "ws.error", "id": "…", "ts": "…", "payload": {"message": "Expected {\"subscribe\": \"trip:<uuid>\"}"}}
```
