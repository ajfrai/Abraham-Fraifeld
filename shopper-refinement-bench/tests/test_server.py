"""Server tests.

The admin panel starts subprocesses and spends money, so the validation layer gets the
most attention here: anything that reaches argv must be rejected unless it matches an
allowlist.
"""

import pytest
from fastapi.testclient import TestClient

from srb import server
from srb.server import app, build_leaderboard, estimate

client = TestClient(app)


def _spec(**overrides):
    base = {
        "models": ["mock:v1"],
        "prompts": ["neutral"],
        "n_items": 10,
        "k": 5,
        "elicit": "batch",
        "corpus": "corpus_full.jsonl",
    }
    return {**base, **overrides}


class TestValidation:
    @pytest.mark.parametrize(
        "model",
        [
            "anthropic:x; rm -rf /",
            "anthropic:$(whoami)",
            "anthropic:a`id`",
            "anthropic:a b",
            "bash:sh",
            "anthropic:",
            "--output=/etc/passwd",
            "anthropic:" + "x" * 65,
        ],
    )
    def test_rejects_hostile_model_specs(self, model):
        res = client.post("/api/estimate", json=_spec(models=[model]))
        assert res.status_code == 400

    def test_accepts_known_providers(self):
        for model in ("anthropic:claude-opus-5", "openai:gpt-5", "mock:v1"):
            assert client.post("/api/estimate", json=_spec(models=[model])).status_code == 200

    @pytest.mark.parametrize("corpus", ["../../../etc/passwd", "/etc/passwd", "nope.jsonl",
                                        "../srb/server.py"])
    def test_rejects_corpus_outside_the_data_dir(self, corpus):
        assert client.post("/api/estimate", json=_spec(corpus=corpus)).status_code == 400

    @pytest.mark.parametrize("field,value", [
        ("n_items", 0), ("n_items", 5000), ("n_items", "abc"),
        ("k", 0), ("k", 500),
    ])
    def test_rejects_out_of_range_numbers(self, field, value):
        assert client.post("/api/estimate", json=_spec(**{field: value})).status_code == 400

    def test_rejects_unknown_prompt(self):
        assert client.post("/api/estimate", json=_spec(prompts=["nope"])).status_code == 400

    def test_rejects_empty_model_list(self):
        assert client.post("/api/estimate", json=_spec(models=[])).status_code == 400

    def test_rejects_unknown_elicit(self):
        assert client.post("/api/estimate", json=_spec(elicit="shell")).status_code == 400

    def test_rejects_unknown_effort(self):
        assert client.post("/api/estimate", json=_spec(effort="turbo")).status_code == 400


class TestArgvConstruction:
    def test_every_argument_is_a_separate_argv_entry(self):
        # No shell is involved, so nothing can be word-split into an extra flag.
        argv = server._argv(server._validate(_spec(models=["mock:v1", "mock:v2"])))
        assert argv[:4] == [server.sys.executable, "-u", "-m", "srb.run_eval"]
        assert "mock:v1" in argv and "mock:v2" in argv
        assert all(isinstance(a, str) for a in argv)
        assert not any(";" in a or "|" in a or "&&" in a for a in argv)


class TestEstimate:
    def test_sample_mode_costs_more_than_batch(self):
        batch = estimate(server._validate(_spec(models=["anthropic:claude-opus-5"],
                                                elicit="batch", k=12)))
        sample = estimate(server._validate(_spec(models=["anthropic:claude-opus-5"],
                                                 elicit="sample", k=12)))
        assert sample["calls"] == batch["calls"] * 12
        assert sample["usd"] > batch["usd"]

    def test_mock_is_free(self):
        assert estimate(server._validate(_spec(models=["mock:v1"])))["usd"] == 0.0

    def test_unknown_model_is_reported_not_silently_zero(self):
        result = estimate(server._validate(_spec(models=["anthropic:some-future-model"])))
        assert result["unpriced"] == ["anthropic:some-future-model"]

    def test_calls_scale_with_prompts_and_models(self):
        result = estimate(server._validate(
            _spec(models=["mock:v1", "mock:v2"], prompts=["neutral", "persona"], n_items=50)))
        assert result["calls"] == 50 * 2 * 2


class TestLeaderboard:
    def _run(self, model, prompt, tvd, run_id, **extra):
        return {
            "model": model, "prompt": prompt, "tvd": tvd, "run_id": run_id,
            "tvd_ci": [tvd - 0.01, tvd + 0.01], "sampling_floor": 0.1,
            "excess_over_floor": tvd - 0.1, "marginal_tvd": 0.4, "human_holdout": 0.3,
            "uniform_tvd": 0.55, "facet_mae": 0.05, "novelty_gap": 0.01,
            "length_delta_gap": 0.2, "beats_marginal": tvd < 0.4, "n_items": 100, "k": 12,
            "elicit": "batch", "human_dist": [0.2] * 5, "model_dist": [0.2] * 5,
            "human_facets": [0.1] * 7, "model_facets": [0.1] * 7,
            "classes": ["a"] * 5, "facet_classes": ["f"] * 7, **extra,
        }

    def test_sorted_by_tvd_ascending(self):
        rows = build_leaderboard([
            self._run("m:b", "neutral", 0.5, "R1"),
            self._run("m:a", "neutral", 0.3, "R1"),
        ])
        assert [r["model"] for r in rows] == ["m:a", "m:b"]

    def test_uses_only_the_latest_run_per_model(self):
        rows = build_leaderboard([
            self._run("m:a", "neutral", 0.9, "R1"),
            self._run("m:a", "neutral", 0.2, "R2"),
        ])
        assert len(rows) == 1
        assert rows[0]["tvd"] == pytest.approx(0.2)
        assert rows[0]["run_id"] == "R2"

    def test_prompt_spread_is_worst_minus_best(self):
        rows = build_leaderboard([
            self._run("m:a", "neutral", 0.2, "R1"),
            self._run("m:a", "persona", 0.5, "R1"),
        ])
        assert rows[0]["prompt_spread"] == pytest.approx(0.3)
        assert rows[0]["best_prompt"] == "neutral"
        assert rows[0]["tvd"] == pytest.approx(0.35)

    def test_beats_marginal_requires_every_prompt_to_beat_it(self):
        rows = build_leaderboard([
            self._run("m:a", "neutral", 0.2, "R1"),
            self._run("m:a", "persona", 0.45, "R1"),
        ])
        assert rows[0]["beats_marginal"] is False

    def test_actual_cost_from_recorded_tokens(self):
        rows = build_leaderboard([
            self._run("anthropic:claude-opus-5", "neutral", 0.3, "R1",
                      n_input_tokens=1_000_000, n_output_tokens=1_000_000),
        ])
        assert rows[0]["actual_usd"] == pytest.approx(30.0)

    def test_actual_cost_is_none_for_unpriced_model(self):
        rows = build_leaderboard([
            self._run("mock:v1", "neutral", 0.3, "R1",
                      n_input_tokens=1000, n_output_tokens=1000),
        ])
        assert rows[0]["actual_usd"] is None


class TestEndpoints:
    def test_config_lists_prompts_and_corpora(self):
        body = client.get("/api/config").json()
        assert body["prompts"] == ["neutral", "persona", "log"]
        assert "corpus_full.jsonl" in body["corpora"]

    def test_index_and_health(self):
        assert client.get("/healthz").json()["ok"] is True
        assert client.get("/").status_code == 200

    def test_leaderboard_endpoint_shape(self):
        body = client.get("/api/leaderboard").json()
        assert "rows" in body and "n_runs" in body

    def test_unknown_job_is_404(self):
        assert client.get("/api/jobs/doesnotexist").status_code == 404

    def test_cancel_unknown_job_is_409(self):
        assert client.post("/api/jobs/doesnotexist/cancel").status_code == 409
