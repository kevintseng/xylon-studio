"""Bounded local model providers for product assistants."""

from __future__ import annotations

import asyncio
import json
import threading
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_PROVIDER_RESPONSE_BYTES = 64 * 1024
PROVIDER_TIMEOUT_SECONDS = 30
# Timing intent is a small, typed classification. Bounding generation keeps a
# local model from spending its entire context/compute budget on prose or
# hidden reasoning before Xylon can validate the response.
MAX_PROVIDER_COMPLETION_TOKENS = 512
# The API creates a provider per request, so the admission control must be
# process-wide.  A non-blocking slot keeps a second chat request from loading
# another model context; callers receive a retryable busy response instead.
_PROVIDER_SLOT = threading.BoundedSemaphore(1)


class ProviderError(RuntimeError):
    """Stable public provider failure without upstream response leakage."""

    def __init__(self, code: str, message: str, recovery: str):
        super().__init__(message)
        self.code = code
        self.message = message
        self.recovery = recovery


class ProviderConfig(BaseModel):
    """Non-secret local model configuration supplied by the local browser."""

    model_config = ConfigDict(extra="forbid")

    protocol: str = Field(pattern=r"^openai-compatible$")
    model: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9._:/-]+$")
    base_url: str = Field(min_length=1, max_length=512)

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.rstrip("/")
        parsed = urlparse(value)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("base_url cannot contain credentials, query parameters, or fragments")
        if parsed.scheme != "http" or parsed.hostname not in {"127.0.0.1", "::1"}:
            raise ValueError("local model endpoint must use HTTP on loopback")
        if parsed.path not in {"", "/v1"}:
            raise ValueError("local model endpoint path must be empty or /v1")
        if parsed.port is None:
            raise ValueError("local model endpoint requires an explicit port")
        return value


class _NoRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None


@dataclass(frozen=True)
class OpenAICompatibleProvider:
    """One bounded loopback OpenAI-compatible chat-completions request."""

    config: ProviderConfig

    async def complete_json(
        self,
        *,
        system_prompt: str,
        user_message: str,
        response_schema: dict | None = None,
    ) -> dict:
        return await asyncio.to_thread(
            self._complete_json_sync,
            system_prompt=system_prompt,
            user_message=user_message,
            response_schema=response_schema,
        )

    def _complete_json_sync(
        self,
        *,
        system_prompt: str,
        user_message: str,
        response_schema: dict | None = None,
    ) -> dict:
        if response_schema is None:
            response_format: dict = {"type": "json_object"}
        else:
            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": "xylon_timing_intent",
                    "strict": True,
                    "schema": response_schema,
                },
            }
        if not _PROVIDER_SLOT.acquire(blocking=False):
            raise ProviderError(
                "TimingAgentProviderBusy",
                "Another local model request is already using Xylon's provider slot.",
                "Wait for the current assistant request to finish, then retry; no EDA action was started.",
            )
        try:
            try:
                body = json.dumps(
                    {
                        "model": self.config.model,
                        "temperature": 0,
                        "max_tokens": MAX_PROVIDER_COMPLETION_TOKENS,
                        "reasoning_effort": "none",
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_message},
                        ],
                        "response_format": response_format,
                    },
                    separators=(",", ":"),
                ).encode("utf-8")
                request = Request(
                    f"{self.config.base_url}/chat/completions",
                    data=body,
                    headers={"Content-Type": "application/json", "Accept": "application/json"},
                    method="POST",
                )
                with build_opener(_NoRedirectHandler()).open(
                    request,
                    timeout=PROVIDER_TIMEOUT_SECONDS,
                ) as response:
                    raw = response.read(MAX_PROVIDER_RESPONSE_BYTES + 1)
            except HTTPError as exc:
                if 300 <= exc.code < 400:
                    raise ProviderError(
                        "TimingAgentProviderRedirectRejected",
                        "The local model endpoint attempted to redirect the request.",
                        "Use the loopback model endpoint directly; Xylon does not follow redirects.",
                    ) from exc
                if exc.code == 429:
                    raise ProviderError(
                        "TimingAgentProviderRateLimited",
                        "The local model endpoint rate-limited this request.",
                        "Wait for the local model queue to recover or choose a smaller model.",
                    ) from exc
                raise ProviderError(
                    "TimingAgentProviderUnavailable",
                    "The local model endpoint did not complete the request.",
                    "Check the local model server and selected model, then retry.",
                ) from exc
            except (TimeoutError, URLError, OSError) as exc:
                raise ProviderError(
                    "TimingAgentProviderUnavailable",
                    "The local model endpoint could not be reached within the bounded request.",
                    "Start the local model server or correct its loopback URL; no EDA action was started.",
                ) from exc

            if len(raw) > MAX_PROVIDER_RESPONSE_BYTES:
                raise ProviderError(
                    "TimingAgentProviderResponseInvalid",
                    "The local model response exceeded Xylon's safety limit.",
                    "Use a model that can return the requested compact JSON intent.",
                )
            try:
                envelope = json.loads(raw.decode("utf-8"))
                content = envelope["choices"][0]["message"]["content"]
                parsed = json.loads(content)
            except (UnicodeDecodeError, json.JSONDecodeError, KeyError, IndexError, TypeError) as exc:
                raise ProviderError(
                    "TimingAgentProviderResponseInvalid",
                    "The local model did not return the required timing-intent JSON.",
                    "Retry with a model that supports compact JSON responses; no EDA action was started.",
                ) from exc
            if not isinstance(parsed, dict):
                raise ProviderError(
                    "TimingAgentProviderResponseInvalid",
                    "The model timing intent was not a JSON object.",
                    "Retry with a model that follows the Xylon timing-agent contract.",
                )
            return parsed
        finally:
            _PROVIDER_SLOT.release()
