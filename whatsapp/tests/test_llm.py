import json

import httpx
import pytest

from app.llm import GroqModel, LLMError

OK = {
    "choices": [
        {
            "message": {
                "role": "assistant",
                "content": None,
                "tool_calls": [
                    {
                        "id": "t1",
                        "type": "function",
                        "function": {"name": "get_weather", "arguments": "{}"},
                    }
                ],
            }
        }
    ]
}
NOT_FOUND = {
    "error": {
        "message": "The model `x` does not exist or you do not have access to it.",
        "code": "model_not_found",
    }
}


def _client(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


async def test_falls_back_when_model_missing_and_remembers():
    seen = []

    def handler(request):
        model = json.loads(request.content)["model"]
        seen.append(model)
        if model == "gone":
            return httpx.Response(404, json=NOT_FOUND)
        return httpx.Response(200, json=OK)

    async with _client(handler) as http:
        llm = GroqModel(http, "k", ["gone", "good", "other"], "https://groq.test/openai/v1")
        out = await llm.complete([{"role": "user", "content": "hi"}], [])
        assert out.tool_calls[0].name == "get_weather"
        await llm.complete([{"role": "user", "content": "again"}], [])
    assert seen == ["gone", "good", "good"]  # dead model is not retried
    assert llm.model == "good"


async def test_all_models_missing():
    async with _client(lambda r: httpx.Response(404, json=NOT_FOUND)) as http:
        llm = GroqModel(http, "k", ["a", "b"], "https://groq.test/openai/v1")
        with pytest.raises(LLMError, match="no configured Groq model"):
            await llm.complete([], [])


async def test_other_client_errors_do_not_trigger_fallback():
    seen = []

    def handler(request):
        seen.append(json.loads(request.content)["model"])
        return httpx.Response(401, json={"error": {"message": "Invalid API Key"}})

    async with _client(handler) as http:
        llm = GroqModel(http, "k", ["a", "b"], "https://groq.test/openai/v1")
        with pytest.raises(LLMError, match="401"):
            await llm.complete([], [])
    assert seen == ["a"]


async def test_rate_limited_call_moves_to_next_model_without_dropping_primary():
    seen = []
    limited = {"a"}

    def handler(request):
        body = json.loads(request.content)
        seen.append((body["model"], body.get("reasoning_effort")))
        if body["model"] in limited:
            return httpx.Response(429, headers={"retry-after": "30"}, json={"error": {}})
        return httpx.Response(200, json=OK)

    async with _client(handler) as http:
        llm = GroqModel(http, "k", ["a", "openai/gpt-oss-20b"], "https://groq.test/openai/v1")
        await llm.complete([], [])
        limited.clear()
        await llm.complete([], [])
    assert seen == [("a", None), ("openai/gpt-oss-20b", "low"), ("a", None)]


async def test_groq_tool_validation_error_is_resampled_then_reported():
    calls = []
    bad = {
        "error": {
            "message": "Tool call validation failed: /category must be one of ...",
            "code": "tool_use_failed",
        }
    }

    def handler(request):
        calls.append(1)
        return httpx.Response(400, json=bad)

    async with _client(handler) as http:
        llm = GroqModel(http, "k", ["a"], "https://groq.test/openai/v1")
        with pytest.raises(LLMError) as exc:
            await llm.complete([], [])
    assert len(calls) == 2  # one resample
    assert exc.value.invalid_tool_call and "category" in str(exc.value)


async def test_every_model_rate_limited():
    async with _client(lambda r: httpx.Response(429, json={"error": {}})) as http:
        llm = GroqModel(http, "k", ["a", "b"], "https://groq.test/openai/v1")
        with pytest.raises(LLMError) as exc:
            await llm.complete([], [])
    assert exc.value.rate_limited
