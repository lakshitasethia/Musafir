import uuid

from app.models.user import UserRole


def _email() -> str:
    return f"t-{uuid.uuid4().hex[:8]}@Test.dev"


def _staff(role: str) -> dict:
    return {"email": _email(), "password": "password123", "full_name": "C", "role": role}


def test_register_login_me(client):
    email = _email()
    r = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "password123", "full_name": "Asha"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["role"] == "traveller"
    assert body["email"] == email.lower()
    assert "hashed_password" not in body
    uuid.UUID(body["id"])
    assert body["created_at"].endswith(("Z", "+00:00"))

    r = client.post("/api/v1/auth/login", json={"email": email, "password": "password123"})
    assert r.status_code == 200, r.text
    token = r.json()["access_token"]

    r = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["id"] == body["id"]


def test_register_cannot_choose_role(client):
    r = client.post(
        "/api/v1/auth/register",
        json={"email": _email(), "password": "password123", "full_name": "X", "role": "operator"},
    )
    assert r.status_code == 201
    assert r.json()["role"] == "traveller"


def test_duplicate_email(client):
    body = {"email": _email(), "password": "password123", "full_name": "A"}
    assert client.post("/api/v1/auth/register", json=body).status_code == 201
    r = client.post("/api/v1/auth/register", json=body)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "email_taken"


def test_bad_login_uses_error_envelope(client):
    r = client.post("/api/v1/auth/login", json={"email": _email(), "password": "nope-nope"})
    assert r.status_code == 401
    err = {"code": "invalid_credentials", "message": "Invalid email or password", "details": None}
    assert r.json() == {"error": err}


def test_validation_error_envelope(client):
    r = client.post("/api/v1/auth/register", json={"email": "not-an-email"})
    assert r.status_code == 422
    err = r.json()["error"]
    assert err["code"] == "validation_error"
    assert isinstance(err["details"], list)


def test_me_requires_token(client):
    assert client.get("/api/v1/auth/me").status_code == 401
    r = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "unauthorized"


def test_operator_creates_coordinator(client, make_user):
    _, headers = make_user(UserRole.operator)
    r = client.post(
        "/api/v1/users",
        headers=headers,
        json=_staff("coordinator"),
    )
    assert r.status_code == 201, r.text
    assert r.json()["role"] == "coordinator"


def test_operator_cannot_create_traveller_via_users(client, make_user):
    _, headers = make_user(UserRole.operator)
    r = client.post(
        "/api/v1/users",
        headers=headers,
        json=_staff("traveller"),
    )
    assert r.status_code == 422


def test_role_guard_blocks_traveller(client, make_user):
    _, headers = make_user(UserRole.traveller)
    r = client.post(
        "/api/v1/users",
        headers=headers,
        json=_staff("operator"),
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden"
