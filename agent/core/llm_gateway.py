# Copyright (c) 2026 XylonStudio
# Licensed under the MIT License
# See LICENSE in the project root for license information

"""
XylonStudio LLM Gateway
Supports multiple LLM backends (Claude, OpenAI, Ollama, vLLM)
"""

from abc import ABC, abstractmethod
from typing import Optional, List, Dict, Iterator
from enum import Enum
import logging
from dataclasses import dataclass
import time

logger = logging.getLogger(__name__)


class LLMProvider(Enum):
    """Supported LLM providers"""
    CLAUDE = "claude"
    OPENAI = "openai"
    OLLAMA = "ollama"
    VLLM = "vllm"
    AZURE_OPENAI = "azure"


@dataclass
class LLMResponse:
    """Unified LLM response format"""
    text: str
    provider: LLMProvider
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
    cost_usd: float


class LLMBackend(ABC):
    """Abstract base class for LLM backends"""

    @abstractmethod
    def generate(
        self,
        prompt: str,
        max_tokens: int = 4000,
        temperature: float = 0.7,
        stop_sequences: Optional[List[str]] = None
    ) -> LLMResponse:
        """Generate text"""
        pass

    @abstractmethod
    def generate_streaming(
        self,
        prompt: str,
        max_tokens: int = 4000
    ) -> Iterator[str]:
        """Generate text with streaming"""
        pass

    @abstractmethod
    def health_check(self) -> bool:
        """Check backend health"""
        pass


class ClaudeBackend(LLMBackend):
    """Anthropic Claude API Backend"""

    def __init__(self, api_key: str, model: str = "claude-sonnet-4-6"):
        try:
            from anthropic import Anthropic
        except ImportError:
            raise ImportError("Please install: pip install anthropic")

        self.client = Anthropic(api_key=api_key)
        self.model = model
        self.provider = LLMProvider.CLAUDE

        # Pricing ($/1K tokens, as of 2026-04)
        self.pricing = {
            "claude-opus-4-6": {"input": 0.015, "output": 0.075},
            "claude-sonnet-4-6": {"input": 0.003, "output": 0.015},
            "claude-haiku-4-5": {"input": 0.0008, "output": 0.004}
        }

    def generate(
        self,
        prompt: str,
        max_tokens: int = 4000,
        temperature: float = 0.7,
        stop_sequences: Optional[List[str]] = None
    ) -> LLMResponse:
        start_time = time.time()

        response = self.client.messages.create(
            model=self.model,
            max_tokens=max_tokens,
            temperature=temperature,
            stop_sequences=stop_sequences or [],
            messages=[{"role": "user", "content": prompt}]
        )

        latency_ms = (time.time() - start_time) * 1000

        input_tokens = response.usage.input_tokens
        output_tokens = response.usage.output_tokens
        cost_usd = self._calculate_cost(input_tokens, output_tokens)

        return LLMResponse(
            text=response.content[0].text,
            provider=self.provider,
            model=self.model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=latency_ms,
            cost_usd=cost_usd
        )

    def generate_streaming(self, prompt: str, max_tokens: int = 4000) -> Iterator[str]:
        with self.client.messages.stream(
            model=self.model,
            max_tokens=max_tokens,
            messages=[{"role": "user", "content": prompt}]
        ) as stream:
            for text in stream.text_stream:
                yield text

    def health_check(self) -> bool:
        try:
            self.generate("test", max_tokens=10)
            return True
        except Exception as e:
            logger.error(f"Claude health check failed: {e}")
            return False

    def _calculate_cost(self, input_tokens: int, output_tokens: int) -> float:
        price = self.pricing.get(self.model, self.pricing["claude-sonnet-4-6"])
        return (input_tokens * price["input"] + output_tokens * price["output"]) / 1000


class OllamaBackend(LLMBackend):
    """Ollama local backend"""

    def __init__(self, base_url: str = "http://localhost:11434", model: str = "qwen2.5-coder:32b"):
        import requests
        self.base_url = base_url
        self.model = model
        self.provider = LLMProvider.OLLAMA
        self.session = requests.Session()

    def generate(
        self,
        prompt: str,
        max_tokens: int = 4000,
        temperature: float = 0.7,
        stop_sequences: Optional[List[str]] = None
    ) -> LLMResponse:
        import requests

        start_time = time.time()

        response = self.session.post(
            f"{self.base_url}/api/generate",
            json={
                "model": self.model,
                "prompt": prompt,
                "stream": False,
                "options": {
                    "num_predict": max_tokens,
                    "temperature": temperature,
                    "stop": stop_sequences or []
                }
            },
            timeout=120
        )
        response.raise_for_status()

        latency_ms = (time.time() - start_time) * 1000
        data = response.json()

        # Ollama doesn't provide exact token count, estimate it
        input_tokens = len(prompt.split()) * 1.3
        output_tokens = len(data["response"].split()) * 1.3

        return LLMResponse(
            text=data["response"],
            provider=self.provider,
            model=self.model,
            input_tokens=int(input_tokens),
            output_tokens=int(output_tokens),
            latency_ms=latency_ms,
            cost_usd=0.0  # Local deployment has no cost
        )

    def generate_streaming(self, prompt: str, max_tokens: int = 4000) -> Iterator[str]:
        import requests
        import json

        response = self.session.post(
            f"{self.base_url}/api/generate",
            json={
                "model": self.model,
                "prompt": prompt,
                "stream": True,
                "options": {"num_predict": max_tokens}
            },
            stream=True
        )

        for line in response.iter_lines():
            if line:
                chunk = json.loads(line)
                if "response" in chunk:
                    yield chunk["response"]

    def health_check(self) -> bool:
        try:
            import requests
            response = self.session.get(f"{self.base_url}/api/tags", timeout=5)
            return response.status_code == 200
        except Exception as e:
            logger.error(f"Ollama health check failed: {e}")
            return False


class VLLMBackend(LLMBackend):
    """vLLM OpenAI-compatible Backend"""

    def __init__(
        self,
        base_url: str = "http://localhost:8000/v1",
        model: str = "Qwen/Qwen2.5-Coder-32B-Instruct",
        api_key: str = "dummy"
    ):
        try:
            from openai import OpenAI
        except ImportError:
            raise ImportError("Please install: pip install openai")

        self.client = OpenAI(base_url=base_url, api_key=api_key)
        self.model = model
        self.provider = LLMProvider.VLLM

    def generate(
        self,
        prompt: str,
        max_tokens: int = 4000,
        temperature: float = 0.7,
        stop_sequences: Optional[List[str]] = None
    ) -> LLMResponse:
        start_time = time.time()

        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
            stop=stop_sequences
        )

        latency_ms = (time.time() - start_time) * 1000

        msg = response.choices[0].message
        text = msg.content or ""
        if not text:
            # Thinking models (e.g., Qwen 3.5) may return reasoning_content
            # but empty content. This means the model only produced internal
            # reasoning without a final answer — do NOT use reasoning as output,
            # as it contains "let me think..." text, not valid code.
            logger.warning("LLM returned empty content (model may be in thinking mode). "
                           "Set LLM_NO_THINK=true or append /no_think to disable.")

        return LLMResponse(
            text=text,
            provider=self.provider,
            model=self.model,
            input_tokens=response.usage.prompt_tokens,
            output_tokens=response.usage.completion_tokens,
            latency_ms=latency_ms,
            cost_usd=0.0  # Local deployment
        )

    def generate_streaming(self, prompt: str, max_tokens: int = 4000) -> Iterator[str]:
        stream = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            stream=True
        )

        for chunk in stream:
            if chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content

    def health_check(self) -> bool:
        try:
            self.client.models.list()
            return True
        except Exception as e:
            logger.error(f"vLLM health check failed: {e}")
            return False


class LLMGateway:
    """
    LLM Gateway - Unified management for multiple LLM backends

    Usage:
        # Development: Use Claude
        gateway = LLMGateway(
            primary_provider=LLMProvider.CLAUDE,
            backends={
                LLMProvider.CLAUDE: ClaudeBackend(api_key="sk-ant-xxx")
            }
        )

        # Testing: Claude + Ollama comparison
        gateway = LLMGateway(
            primary_provider=LLMProvider.CLAUDE,
            fallback_provider=LLMProvider.OLLAMA,
            backends={
                LLMProvider.CLAUDE: ClaudeBackend(api_key="sk-ant-xxx"),
                LLMProvider.OLLAMA: OllamaBackend(base_url="http://localhost:11434")
            }
        )

        # Production: vLLM + Claude fallback
        gateway = LLMGateway(
            primary_provider=LLMProvider.VLLM,
            fallback_provider=LLMProvider.CLAUDE,
            backends={...}
        )
    """

    def __init__(
        self,
        primary_provider: LLMProvider,
        backends: Dict[LLMProvider, LLMBackend],
        fallback_provider: Optional[LLMProvider] = None,
        compare_mode: bool = False
    ):
        self.primary = primary_provider
        self.fallback = fallback_provider
        self.backends = backends
        self.compare_mode = compare_mode

        self.metrics = {
            "requests": 0,
            "successes": 0,
            "failures": 0,
            "fallbacks": 0,
            "total_cost_usd": 0.0,
            "total_latency_ms": 0.0
        }

    def generate(self, prompt: str, **kwargs) -> LLMResponse:
        """Generate text with automatic fallback"""
        self.metrics["requests"] += 1

        try:
            backend = self.backends[self.primary]
            response = backend.generate(prompt, **kwargs)

            self.metrics["successes"] += 1
            self.metrics["total_cost_usd"] += response.cost_usd
            self.metrics["total_latency_ms"] += response.latency_ms

            logger.info(
                f"LLM generation success: provider={response.provider.value}, "
                f"latency={response.latency_ms:.0f}ms, cost=${response.cost_usd:.4f}"
            )

            return response

        except Exception as e:
            logger.error(f"Primary backend ({self.primary.value}) failed: {e}")
            self.metrics["failures"] += 1

            if self.fallback and self.fallback in self.backends:
                logger.warning(f"Falling back to {self.fallback.value}")
                self.metrics["fallbacks"] += 1

                try:
                    backend = self.backends[self.fallback]
                    response = backend.generate(prompt, **kwargs)
                    self.metrics["successes"] += 1
                    self.metrics["total_cost_usd"] += response.cost_usd
                    return response
                except Exception as fallback_error:
                    logger.error(f"Fallback also failed: {fallback_error}")
                    raise
            else:
                raise

    def compare_quality(self, prompt: str, **kwargs) -> Dict[str, LLMResponse]:
        """Call multiple backends simultaneously for quality comparison (testing)"""
        results = {}

        for provider, backend in self.backends.items():
            try:
                logger.info(f"Comparing with {provider.value}...")
                response = backend.generate(prompt, **kwargs)
                results[provider.value] = response
            except Exception as e:
                logger.error(f"{provider.value} comparison failed: {e}")
                results[provider.value] = None

        return results

    def switch_provider(self, new_primary: LLMProvider):
        """Switch primary provider"""
        logger.info(f"Switching provider: {self.primary.value} → {new_primary.value}")
        self.primary = new_primary

    def get_metrics(self) -> Dict:
        """Get usage statistics"""
        return {
            **self.metrics,
            "success_rate": self.metrics["successes"] / max(self.metrics["requests"], 1),
            "fallback_rate": self.metrics["fallbacks"] / max(self.metrics["requests"], 1),
            "avg_latency_ms": self.metrics["total_latency_ms"] / max(self.metrics["successes"], 1)
        }

    def health_check_all(self) -> Dict[str, bool]:
        """Check health status of all backends"""
        return {
            provider.value: backend.health_check()
            for provider, backend in self.backends.items()
        }
