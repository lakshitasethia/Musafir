from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException


def _code(status: int) -> str:
    # 404 -> "not_found", 401 -> "unauthorized", ...
    return HTTPStatus(status).phrase.lower().replace(" ", "_").replace("-", "_")


class AppError(Exception):
    """Raise from anywhere; rendered as {"error": {"code", "message", "details"}}."""

    def __init__(
        self, status: int, message: str, code: str | None = None, details: Any = None
    ) -> None:
        self.status = status
        self.code = code or _code(status)
        self.message = message
        self.details = details


def error_response(status: int, code: str, message: str, details: Any = None) -> JSONResponse:
    body = {"error": {"code": code, "message": message, "details": details}}
    return JSONResponse(jsonable_encoder(body), status_code=status)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def app_error(_: Request, exc: AppError) -> JSONResponse:
        return error_response(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, exc: HTTPException) -> JSONResponse:
        return error_response(exc.status_code, _code(exc.status_code), str(exc.detail))

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return error_response(422, "validation_error", "Request validation failed", exc.errors())

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception) -> JSONResponse:
        return error_response(500, "internal_error", "Internal server error")
