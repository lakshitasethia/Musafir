"""Tool registry: each tool is a typed args model + async function the agent can call.

Add a tool by writing a module that calls `register(Tool(...))` and importing it in
`app/tools/__init__.py`. Trip/booking tools plug in here once the backend exposes them.
"""

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import httpx
from pydantic import BaseModel, ValidationError

if TYPE_CHECKING:
    from app.backend_client import BackendClient
    from app.channel import Sender
    from app.config import Settings
    from app.store import Session, Store


class ToolError(Exception):
    """Expected failure; the message is shown to the model so it can explain or recover."""


@dataclass
class ToolContext:
    session: "Session"  # mutable; the agent saves it after the turn
    store: "Store"
    sender: "Sender"
    http: httpx.AsyncClient
    backend: "BackendClient"
    settings: "Settings"

    @property
    def phone(self) -> str:
        return self.session.phone


@dataclass
class ToolResult:
    data: dict[str, Any]
    # the tool already messaged the user (location request, link, pin...) and the model
    # should not add another reply this turn
    ends_turn: bool = False


Runner = Callable[[ToolContext, Any], Awaitable[ToolResult | dict[str, Any]]]


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[BaseModel]
    run: Runner
    # when set, the agent asks the user to tap Confirm before running; `{field}` placeholders
    # are filled from the validated args
    confirm: str | None = None
    # one-line outcome sent after a confirmed run, filled from the result data
    confirmed_message: str | None = None

    def schema(self) -> dict[str, Any]:
        params = _strip_titles(self.args.model_json_schema())
        params.setdefault("properties", {})
        return {
            "type": "function",
            "function": {"name": self.name, "description": self.description, "parameters": params},
        }

    def parse(self, raw: str | dict[str, Any]) -> BaseModel:
        """Validated args; raises ToolError with a message the model can act on."""
        try:
            data = json.loads(raw) if isinstance(raw, str) else raw
        except json.JSONDecodeError as e:
            raise ToolError(f"arguments were not valid JSON: {e.msg}") from None
        if data is None:
            data = {}
        if not isinstance(data, dict):
            raise ToolError("arguments must be a JSON object")
        try:
            return self.args.model_validate(data)
        except ValidationError as e:
            problems = "; ".join(
                f"{'.'.join(str(p) for p in err['loc']) or 'args'}: {err['msg']}"
                for err in e.errors()
            )
            raise ToolError(f"invalid arguments: {problems}") from None


def _strip_titles(schema: Any) -> Any:
    if isinstance(schema, dict):
        return {k: _strip_titles(v) for k, v in schema.items() if k != "title"}
    if isinstance(schema, list):
        return [_strip_titles(v) for v in schema]
    return schema


_REGISTRY: dict[str, Tool] = {}


def register(tool: Tool) -> Tool:
    if tool.name in _REGISTRY:
        raise ValueError(f"tool {tool.name!r} registered twice")
    _REGISTRY[tool.name] = tool
    return tool


def get_tool(name: str) -> Tool | None:
    return _REGISTRY.get(name)


def all_tools() -> list[Tool]:
    return list(_REGISTRY.values())
