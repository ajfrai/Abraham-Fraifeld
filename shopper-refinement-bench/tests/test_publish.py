"""Publisher tests: the static build must be self-contained and must not carry any
admin surface onto a public host."""

import json

import pytest

from srb import publish


@pytest.fixture
def built(tmp_path, monkeypatch):
    run = {
        "model": "mock:v1", "prompt": "neutral", "tvd": 0.4, "run_id": "R1",
        "tvd_ci": [0.35, 0.45], "sampling_floor": 0.1, "excess_over_floor": 0.3,
        "marginal_tvd": 0.45, "human_holdout": 0.3, "uniform_tvd": 0.55,
        "facet_mae": 0.05, "novelty_gap": 0.01, "length_delta_gap": 0.2,
        "beats_marginal": True, "n_items": 100, "k": 12, "elicit": "batch",
        "human_dist": [0.2] * 5, "model_dist": [0.2] * 5,
        "human_facets": [0.1] * 7, "model_facets": [0.1] * 7,
        "classes": ["a"] * 5, "facet_classes": ["f"] * 7,
    }
    monkeypatch.setattr(publish, "_load_runs", lambda: [run])
    out = tmp_path / "dist"
    publish.build(out, title_note="test note")
    return out


class TestBuild:
    def test_emits_a_self_contained_directory(self, built):
        for name in ("index.html", "app.js", "styles.css", "favicon.svg",
                     "leaderboard.json", "runs.json", "vercel.json"):
            assert (built / name).is_file(), f"missing {name}"

    def test_leaderboard_json_carries_rows_and_provenance(self, built):
        payload = json.loads((built / "leaderboard.json").read_text())
        assert payload["static"] is True
        assert payload["note"] == "test note"
        assert payload["generated"]
        assert payload["rows"][0]["model"] == "mock:v1"

    def test_html_switches_the_front_end_to_static_mode(self, built):
        html = (built / "index.html").read_text()
        assert "window.SRB_STATIC = true" in html

    def test_asset_paths_are_relative_not_server_routes(self, built):
        html = (built / "index.html").read_text()
        assert "/static/" not in html
        assert 'href="styles.css"' in html
        assert 'src="app.js"' in html

    def test_publishes_no_server_module(self, built):
        # Nothing that can start a job may end up on a public host.
        names = {p.name for p in built.iterdir()}
        assert "server.py" not in names
        assert not any(n.endswith(".py") for n in names)

    def test_rebuild_replaces_stale_files(self, built, monkeypatch):
        stale = built / "old-run.json"
        stale.write_text("{}")
        monkeypatch.setattr(publish, "_load_runs", publish._load_runs)
        publish.build(built, title_note=None)
        assert not stale.exists()

    def test_exits_when_there_are_no_runs(self, tmp_path, monkeypatch):
        monkeypatch.setattr(publish, "_load_runs", lambda: [])
        with pytest.raises(SystemExit):
            publish.build(tmp_path / "dist")
