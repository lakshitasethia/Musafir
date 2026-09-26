"""Groq chat completions (OpenAI-compatible) with tool calling, over plain httpx."""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: str  # raw JSON string, validated by the tool registry


@dataclass(frozen=True)
class Completion:
    content: str | None
    tool_calls: list[ToolCall] = field(default_factory=list)

    def as_message(self) -> dict[str, Any]:
        msg: dict[str, Any] = {"role": "assistant"}
        if self.content:
            msg["content"] = self.content
        if self.tool_calls:
            msg["tool_calls"] = [
                {
                    "id": c.id,
                    "type": "function",
                    "function": {"name": c.name, "arguments": c.arguments},
                }
                for c in self.tool_calls
            ]
        else:
            msg.setdefault("content", "")
        return msg


class LLMError(Exception):
    def __init__(
        self, message: str, *, rate_limited: bool = False, invalid_tool_call: bool = False
    ) -> None:
        super().__init__(message)
        self.rate_limited = rate_limited
        # the model's tool call failed Groq's schema check; the message says why
        self.invalid_tool_call = invalid_tool_call


def _bad_tool_call(text: str) -> bool:
    return "tool_use_failed" in text or "Tool call validation failed" in text


def _error_message(r: httpx.Response) -> str:
    try:
        return str(r.json()["error"]["message"])[:500]
    except (ValueError, KeyError, TypeError):
        return r.text[:500]


class ChatModel(Protocol):
    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> Completion: ...


class ModelUnavailable(Exception):
    pass


def _model_unavailable(r: httpx.Response) -> bool:
    """Model id unknown, retired, or not enabled for this key."""
    if r.status_code not in (400, 403, 404):
        return False
    text = r.text
    return any(s in text for s in ("model_not_found", "model_decommissioned", "does not exist"))


class GroqModel:
    """Tries `models` in order; a model the key can't use is skipped for the process lifetime."""

    def __init__(
        self, http: httpx.AsyncClient, api_key: str, models: list[str], base_url: str
    ) -> None:
        if not models:
            raise ValueError("at least one Groq model is required")
        self._http = http
        self._models = list(dict.fromkeys(models))  # dedupe, keep order
        self._url = f"{base_url.rstrip('/')}/chat/completions"
        self._headers = {"Authorization": f"Bearer {api_key}"}

    @property
    def model(self) -> str:
        return self._models[0]

    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> Completion:
        # Free-tier limits are per model, so a rate-limited call moves to the next model for
        # this request only; a missing model is dropped for good.
        i = 0
        rate_limited: LLMError | None = None
        while i < len(self._models):
            model = self._models[i]
            is_last = i == len(self._models) - 1
            try:
                return await self._complete_with(model, messages, tools, wait_on_429=is_last)
            except ModelUnavailable:
                self._models.pop(i)
                log.warning("groq model %s unavailable for this key; dropping it", model)
            except LLMError as e:
                if not e.rate_limited:
                    raise
                log.info("groq model %s rate-limited, trying the next model", model)
                rate_limited = e
                i += 1
        if rate_limited:
            raise rate_limited
        raise LLMError("no configured Groq model is available")

    async def _complete_with(
        self,
        model: str,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]],
        *,
        wait_on_429: bool = True,
    ) -> Completion:
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            # reasoning models spend part of this budget thinking; it also counts toward TPM
            "max_tokens": 1024,
        }
        if model.startswith("openai/gpt-oss"):
            body["reasoning_effort"] = "low"  # short WhatsApp replies don't need deep thought
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        for attempt in range(3):
            try:
                r = await self._http.post(self._url, json=body, headers=self._headers, timeout=30)
            except httpx.HTTPError as e:
                if attempt < 2:
                    await asyncio.sleep(0.5 * (attempt + 1))  # rides out DNS/connection blips
                    continue
                raise LLMError(f"Groq unreachable: {e}") from e

            if r.status_code == 429:
                wait = _retry_after(r)
                if wait_on_429 and attempt < 2 and wait is not None and wait <= 6:
                    await asyncio.sleep(wait)
                    continue
                raise LLMError("Groq rate limit reached", rate_limited=True)
            if r.status_code >= 500 and attempt < 2:
                await asyncio.sleep(0.5 * (attempt + 1))
                continue
            if _model_unavailable(r):
                raise ModelUnavailable(model)
            if r.status_code == 400 and _bad_tool_call(r.text):
                # models occasionally emit a malformed tool call; a resample usually fixes it
                if attempt < 1:
                    log.info("groq rejected a tool call, resampling")
                    continue
                raise LLMError(_error_message(r), invalid_tool_call=True)
            if r.status_code >= 400:
                raise LLMError(f"Groq {r.status_code}: {r.text[:300]}")

            try:
                msg = r.json()["choices"][0]["message"]
            except (ValueError, KeyError, IndexError, TypeError) as e:
                raise LLMError("Unexpected Groq response shape") from e
            calls = [
                ToolCall(
                    id=c.get("id") or f"call_{i}",
                    name=(c.get("function") or {}).get("name") or "",
                    arguments=(c.get("function") or {}).get("arguments") or "{}",
                )
                for i, c in enumerate(msg.get("tool_calls") or [])
            ]
            return Completion(content=msg.get("content"), tool_calls=calls)
        raise LLMError("Groq failed after retries")


def _retry_after(r: httpx.Response) -> float | None:
    try:
        return float(r.headers.get("retry-after", ""))
    except ValueError:
        return None
