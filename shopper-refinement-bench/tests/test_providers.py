"""Provider tests. The Anthropic path is exercised with a stubbed client so the request
shape is verified without network access or spend."""

import types

import pytest

from srb.providers import MockProvider, build_provider, parse_queries


class TestParseQueries:
    def test_plain_json_array(self):
        assert parse_queries('["a", "b"]', 5) == ["a", "b"]

    def test_fenced_code_block(self):
        assert parse_queries('```json\n["x", "y"]\n```', 5) == ["x", "y"]

    def test_array_embedded_in_prose(self):
        assert parse_queries('Sure:\n["p","q"]\nhope that helps', 5) == ["p", "q"]

    def test_numbered_list_fallback(self):
        assert parse_queries("1. red shoes\n2. blue shoes", 5) == ["red shoes", "blue shoes"]

    def test_bulleted_list_fallback(self):
        assert parse_queries("- red shoes\n- blue shoes", 5) == ["red shoes", "blue shoes"]

    def test_truncates_to_k(self):
        assert len(parse_queries('["a","b","c","d"]', 2)) == 2

    def test_empty_and_garbage(self):
        assert parse_queries("", 5) == []
        assert parse_queries("{}", 5) == []

    def test_drops_non_strings_and_blanks(self):
        assert parse_queries('["a", null, "", "b"]', 5) == ["a", "b"]


class TestMockProvider:
    def test_is_deterministic(self):
        a = MockProvider().complete("sys", 'query "running shoes"', k=6)
        b = MockProvider().complete("sys", 'query "running shoes"', k=6)
        assert a.queries == b.queries

    def test_returns_exactly_k(self):
        assert len(MockProvider().complete("sys", 'query "tv"', k=9).queries) == 9


class _StubMessages:
    def __init__(self, outer):
        self.outer = outer

    def create(self, **kwargs):
        self.outer.captured = kwargs
        return types.SimpleNamespace(
            stop_reason=self.outer.stop_reason,
            content=[types.SimpleNamespace(type="text", text='["alpha", "beta"]')],
            usage=types.SimpleNamespace(input_tokens=100, output_tokens=20),
        )


class _StubClient:
    def __init__(self, stop_reason="end_turn"):
        self.stop_reason = stop_reason
        self.captured = None
        self.messages = _StubMessages(self)


def _provider(monkeypatch, stop_reason="end_turn", **kwargs):
    from srb import providers

    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key-not-real")
    provider = providers.AnthropicProvider.__new__(providers.AnthropicProvider)
    import anthropic

    provider._anthropic = anthropic
    provider.model = kwargs.get("model", "claude-opus-5")
    provider.max_tokens = kwargs.get("max_tokens", 8000)
    provider.effort = kwargs.get("effort")
    provider.thinking = kwargs.get("thinking", True)
    provider.client = _StubClient(stop_reason)
    return provider


class TestAnthropicRequestShape:
    def test_sends_expected_parameters(self, monkeypatch):
        p = _provider(monkeypatch)
        result = p.complete("SYSTEM", "USER", k=2)
        sent = p.client.captured
        assert sent["model"] == "claude-opus-5"
        assert sent["system"] == "SYSTEM"
        assert sent["messages"] == [{"role": "user", "content": "USER"}]
        assert sent["thinking"] == {"type": "adaptive"}
        assert result.queries == ["alpha", "beta"]
        assert result.usage == {"input_tokens": 100, "output_tokens": 20}

    def test_never_sends_temperature(self, monkeypatch):
        # Opus 5 / Sonnet 5 reject sampling parameters with a 400.
        p = _provider(monkeypatch)
        p.complete("s", "u", k=2)
        assert "temperature" not in p.client.captured
        assert "top_p" not in p.client.captured

    def test_never_enables_server_side_fallbacks(self, monkeypatch):
        # A silent model substitution would attribute one model's outputs to another.
        p = _provider(monkeypatch)
        p.complete("s", "u", k=2)
        assert "fallbacks" not in p.client.captured
        assert "betas" not in p.client.captured

    def test_effort_is_nested_in_output_config(self, monkeypatch):
        p = _provider(monkeypatch, effort="low")
        p.complete("s", "u", k=2)
        assert p.client.captured["output_config"] == {"effort": "low"}

    def test_thinking_omitted_when_disabled(self, monkeypatch):
        p = _provider(monkeypatch, thinking=False)
        p.complete("s", "u", k=2)
        assert "thinking" not in p.client.captured

    def test_refusal_is_recorded_not_retried(self, monkeypatch):
        p = _provider(monkeypatch, stop_reason="refusal")
        result = p.complete("s", "u", k=2)
        assert result.refused is True
        assert result.queries == []


class TestBuildProvider:
    def test_mock_spec(self):
        assert build_provider("mock:v1").name == "mock"

    def test_unknown_provider_exits(self):
        with pytest.raises(SystemExit):
            build_provider("notaprovider:x")

    def test_anthropic_without_key_exits(self, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
        monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
        with pytest.raises(SystemExit):
            build_provider("anthropic:claude-opus-5")
