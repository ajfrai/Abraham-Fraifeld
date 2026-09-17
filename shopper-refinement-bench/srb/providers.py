"""Model providers.

Design note on fallbacks: the Anthropic SDK can route a refused request to another model
server-side. That is deliberately NOT enabled here. A benchmark that silently substitutes
a different model would attribute one model's outputs to another and invalidate the
measurement. Refusals are recorded as refusals and excluded from scoring, with the count
surfaced in the report.
"""

from __future__ import annotations

import json
import os
import re
import time
from dataclasses import dataclass, field


@dataclass
class Completion:
    queries: list[str]
    raw: str = ""
    stop_reason: str | None = None
    refused: bool = False
    error: str | None = None
    usage: dict = field(default_factory=dict)


_JSON_ARRAY_RE = re.compile(r"\[.*?\]", re.DOTALL)


def parse_queries(text: str, k: int) -> list[str]:
    """Parse a JSON array of strings, tolerating fenced code blocks and stray prose."""
    if not text:
        return []
    candidate = text.strip()
    if candidate.startswith("```"):
        candidate = re.sub(r"^```[a-zA-Z]*\n?", "", candidate)
        candidate = re.sub(r"\n?```$", "", candidate).strip()

    for blob in ([candidate] if candidate.startswith("[") else []) + _JSON_ARRAY_RE.findall(text):
        try:
            parsed = json.loads(blob)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            out = [str(x).strip() for x in parsed if isinstance(x, (str, int, float))]
            out = [q for q in out if q]
            if out:
                return out[:k]

    # Last resort: numbered or bulleted lines.
    lines = []
    for line in text.splitlines():
        stripped = re.sub(r'^\s*(?:[-*•]|\d+[.)])\s*', "", line).strip().strip('",')
        if stripped and not stripped.startswith(("{", "[", "```")):
            lines.append(stripped)
    return lines[:k]


class Provider:
    name = "base"

    def complete(self, system: str, user: str, *, k: int) -> Completion:  # pragma: no cover
        raise NotImplementedError


class MockProvider(Provider):
    """Deterministic offline provider.

    Exists so the whole pipeline is runnable and testable without API keys, and so the
    scorer has a known-behavior input during development. It applies crude, fixed
    refinement rules to the seed query; its scores are NOT a claim about any real model.
    """

    name = "mock"

    def __init__(self, model: str = "mock-v1", seed: int | None = None):
        import hashlib

        self.model = model
        # Derive the seed from the model name so different mock specs behave differently,
        # which makes the leaderboard meaningful without spending anything.
        self._seed = seed if seed is not None else int(
            hashlib.sha256(model.encode()).hexdigest()[:8], 16
        )

    def complete(self, system: str, user: str, *, k: int) -> Completion:
        import hashlib
        import random

        match = re.search(r'"([^"]+)"', user)
        seed_query = match.group(1) if match else "product"
        brands = re.findall(r"brand: ([^|\n]+)", user)
        colors = re.findall(r"colour/variant: ([^|\n]+)", user)

        digest = hashlib.sha256(f"{seed_query}{self._seed}".encode()).hexdigest()
        rng = random.Random(int(digest[:16], 16))

        out: list[str] = []
        if brands:
            out.append(f"{brands[0].strip().lower()} {seed_query}")
        if colors:
            out.append(f"{seed_query} {colors[0].strip().lower()}")
        out += [
            f"best {seed_query}",
            f"{seed_query} for men",
            seed_query.split()[-1] if len(seed_query.split()) > 1 else f"cheap {seed_query}",
            f"{seed_query} reviews",
        ]
        rng.shuffle(out)
        while len(out) < k:
            out.append(f"{seed_query} {rng.choice(['online', 'near me', 'sale', '2 pack'])}")
        return Completion(queries=out[:k], raw=json.dumps(out[:k]), stop_reason="end_turn")


class AnthropicProvider(Provider):
    name = "anthropic"

    def __init__(
        self,
        model: str = "claude-opus-5",
        *,
        max_tokens: int = 8000,
        effort: str | None = None,
        thinking: bool = True,
        max_retries: int = 4,
    ):
        import anthropic

        self.model = model
        self.max_tokens = max_tokens
        self.effort = effort
        self.thinking = thinking
        self.max_retries = max_retries
        self._anthropic = anthropic
        self.client = anthropic.Anthropic(max_retries=max_retries)

    def complete(self, system: str, user: str, *, k: int) -> Completion:
        kwargs: dict = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "system": system,
            "messages": [{"role": "user", "content": user}],
        }
        if self.thinking:
            kwargs["thinking"] = {"type": "adaptive"}
        if self.effort:
            kwargs["output_config"] = {"effort": self.effort}

        try:
            msg = self.client.messages.create(**kwargs)
        except self._anthropic.APIStatusError as exc:
            return Completion(queries=[], error=f"{type(exc).__name__}: {exc}")
        except self._anthropic.APIConnectionError as exc:
            return Completion(queries=[], error=f"connection: {exc}")

        if msg.stop_reason == "refusal":
            return Completion(queries=[], stop_reason="refusal", refused=True)

        text = "".join(b.text for b in msg.content if getattr(b, "type", None) == "text")
        return Completion(
            queries=parse_queries(text, k),
            raw=text,
            stop_reason=msg.stop_reason,
            usage={
                "input_tokens": msg.usage.input_tokens,
                "output_tokens": msg.usage.output_tokens,
            },
        )


class OpenAIProvider(Provider):
    name = "openai"

    def __init__(self, model: str = "gpt-5", *, max_tokens: int = 8000, max_retries: int = 4):
        from openai import OpenAI

        self.model = model
        self.max_tokens = max_tokens
        self.client = OpenAI(max_retries=max_retries)

    def complete(self, system: str, user: str, *, k: int) -> Completion:
        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                max_completion_tokens=self.max_tokens,
            )
        except Exception as exc:  # provider SDK exception surface varies by version
            return Completion(queries=[], error=f"{type(exc).__name__}: {exc}")
        choice = resp.choices[0]
        text = choice.message.content or ""
        return Completion(
            queries=parse_queries(text, k),
            raw=text,
            stop_reason=choice.finish_reason,
            usage={
                "input_tokens": resp.usage.prompt_tokens,
                "output_tokens": resp.usage.completion_tokens,
            },
        )


def build_provider(spec: str, **kwargs) -> Provider:
    """spec is 'provider:model', e.g. 'anthropic:claude-opus-5' or 'mock:v1'."""
    provider, _, model = spec.partition(":")
    provider = provider.lower()
    if provider == "mock":
        return MockProvider(model or "mock-v1")
    if provider == "anthropic":
        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            raise SystemExit("ANTHROPIC_API_KEY is not set; export it or use --models mock:v1")
        return AnthropicProvider(model or "claude-opus-5", **kwargs)
    if provider == "openai":
        if not os.environ.get("OPENAI_API_KEY"):
            raise SystemExit("OPENAI_API_KEY is not set")
        allowed = {kk: vv for kk, vv in kwargs.items() if kk in {"max_tokens", "max_retries"}}
        return OpenAIProvider(model or "gpt-5", **allowed)
    raise SystemExit(f"unknown provider {provider!r} (expected anthropic, openai or mock)")
