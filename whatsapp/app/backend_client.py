"""Calls into the Musafir backend API (../backend). Only uses its public HTTP contract."""

from typing import Any

import httpx


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
        self._base = base_url.rstrip("/") + "/api/v1"

    async def _request(
        self, method: str, path: str, *, token: str | None = None, json: Any = None
    ) -> Any:
        headers = {"Authorization": f"Bearer {token}"} if token else {}
        try:
            r = await self._http.request(
                method, self._base + path, json=json, headers=headers, timeout=10
            )
        except httpx.HTTPError as e:
            raise BackendUnavailable(str(e)) from e
        if r.status_code >= 500:
            raise BackendUnavailable(f"Musafir API returned {r.status_code}")
        if r.status_code >= 400:
            # backend errors are always {"error": {code, message, details}}
            try:
                err = r.json()["error"]
                raise BackendError(r.status_code, err["code"], err["message"])
            except (ValueError, KeyError, TypeError):
                raise BackendError(r.status_code, "unknown", r.text[:200]) from None
        return r.json()

    async def login(self, email: str, password: str) -> str:
        data = await self._request(
            "POST", "/auth/login", json={"email": email, "password": password}
        )
        return data["access_token"]

    async def register(
        self, email: str, password: str, full_name: str, phone: str | None
    ) -> dict[str, Any]:
        body = {"email": email, "password": password, "full_name": full_name, "phone": phone}
        return await self._request("POST", "/auth/register", json=body)

    async def me(self, token: str) -> dict[str, Any]:
        return await self._request("GET", "/auth/me", token=token)
