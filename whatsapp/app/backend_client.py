"""Calls into the Musafir Next.js app (the repo root) over its public HTTP API.

Our API authenticates with the signed `mz_session` cookie that /api/auth/login sets, so that
cookie value is what this service stores as a linked number's "access token". Errors come back
as {"error": "<message>"}; they're mapped to stable codes the link page understands.
"""

from typing import Any

import httpx

SESSION_COOKIE = "mz_session"


class BackendError(Exception):
    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


class BackendUnavailable(Exception):
    pass


class BackendClient:
    def __init__(self, http: httpx.AsyncClient, base_url: str) -> None:
        self._http = http
        self._base = base_url.rstrip("/") + "/api"

    async def _raw(
        self, method: str, path: str, *, token: str | None = None, json: Any = None
    ) -> httpx.Response:
        headers = {"Cookie": f"{SESSION_COOKIE}={token}"} if token else {}
        try:
            r = await self._http.request(
                method, self._base + path, json=json, headers=headers, timeout=20
            )
        except httpx.HTTPError as e:
            raise BackendUnavailable(str(e)) from e
        if r.status_code >= 500:
            raise BackendUnavailable(f"Musafir API returned {r.status_code}")
        if r.status_code >= 400:
            try:
                message = str(r.json()["error"])
            except (ValueError, KeyError, TypeError):
                message = r.text[:200]
            code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 409: "conflict"}.get(
                r.status_code, "invalid"
            )
            raise BackendError(r.status_code, code, message)
        return r

    async def request(
        self, method: str, path: str, *, token: str, json: Any = None
    ) -> dict[str, Any]:
        """Authenticated call as the linked user; `path` is below /api (e.g. "/trips")."""
        return (await self._raw(method, path, token=token, json=json)).json()

    async def login(self, email: str, password: str) -> str:
        try:
            r = await self._raw("POST", "/auth/login", json={"email": email, "password": password})
        except BackendError as e:
            if e.status == 401:
                raise BackendError(401, "invalid_credentials", e.message) from None
            raise
        token = r.cookies.get(SESSION_COOKIE)
        if not token:
            raise BackendUnavailable("Musafir API did not return a session")
        return token

    async def register(
        self, email: str, password: str, full_name: str, phone: str | None
    ) -> dict[str, Any]:
        # Only traveller accounts are created from WhatsApp; operators sign up on the web.
        body = {"email": email, "password": password, "name": full_name, "role": "traveller"}
        try:
            return (await self._raw("POST", "/auth/signup", json=body)).json()
        except BackendError as e:
            if e.status == 409:
                raise BackendError(409, "email_taken", e.message) from None
            raise

    async def me(self, token: str) -> dict[str, Any]:
        user = (await self._raw("GET", "/auth/me", token=token)).json()["user"]
        return {
            "full_name": user.get("name"),
            "email": user.get("email"),
            "role": user.get("role"),
            "guest": user.get("guest", False),
        }
