"""Local leaderboard + admin panel.

Serves a dashboard of completed benchmark runs and a panel that launches new ones.

This binds to 127.0.0.1 by default and has no authentication, because it starts
subprocesses and spends money through your API keys. Do not expose it to a network you
do not control. Every field that reaches the subprocess is validated against an allowlist
and passed as an argv list -- never through a shell.

    python -m srb.server            # http://127.0.0.1:8000
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from .prompts import PROMPT_NAMES

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = Path(__file__).resolve().parent / "web"
RESULTS_DIR = ROOT / "results"
DATA_DIR = ROOT / "data"
JOBS_FILE = RESULTS_DIR / "jobs.json"
LOG_DIR = RESULTS_DIR / "logs"

MODEL_SPEC_RE = re.compile(r"^(anthropic|openai|mock):[A-Za-z0-9._\-]{1,64}$")

# USD per million tokens. Used only for the pre-run estimate shown in the panel.
PRICES: dict[str, tuple[float, float]] = {
    "claude-fable-5-1": (10.0, 50.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-opus-5": (5.0, 25.0),
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-sonnet-5": (2.0, 10.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}

# Approximate per-call token shape for the shipped prompts at k=12. Output includes an
# allowance for adaptive-thinking tokens, which are billed as output and dominate the
# cost of a short generation like this one. Treat the estimate as an upper-ish bound;
# actual usage is recorded per run and shown on the leaderboard.
CALL_SHAPE = {
    "batch": (700, 700),   # one call returns k queries
    "sample": (650, 400),  # k calls each return one query; thinking overhead per call
}

MODEL_PRESETS = [
    "anthropic:claude-opus-5",
    "anthropic:claude-sonnet-5",
    "anthropic:claude-haiku-4-5",
    "openai:gpt-5",
    "mock:v1",
]

app = FastAPI(title="Shopper Refinement Benchmark")

_jobs: dict[str, dict] = {}
_procs: dict[str, subprocess.Popen] = {}
_lock = threading.Lock()


# --------------------------------------------------------------------------------------
# Job persistence
# --------------------------------------------------------------------------------------


def _load_jobs() -> None:
    if JOBS_FILE.exists():
        try:
            for job in json.loads(JOBS_FILE.read_text()):
                if job.get("status") == "running":
                    # The server restarted; the child did not survive it.
                    job["status"] = "orphaned"
                _jobs[job["id"]] = job
        except (json.JSONDecodeError, KeyError):
            pass


def _save_jobs() -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    with _lock:
        payload = sorted(_jobs.values(), key=lambda j: j["created"], reverse=True)[:200]
    JOBS_FILE.write_text(json.dumps(payload, indent=2))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# --------------------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------------------


def _validate(spec: dict) -> dict:
    models = spec.get("models") or []
    if not models or len(models) > 8:
        raise HTTPException(400, "pick between 1 and 8 models")
    for model in models:
        if not MODEL_SPEC_RE.match(model):
            raise HTTPException(400, f"invalid model spec: {model!r}")

    prompts = spec.get("prompts") or []
    if not prompts or any(p not in PROMPT_NAMES for p in prompts):
        raise HTTPException(400, f"prompts must be a non-empty subset of {list(PROMPT_NAMES)}")

    try:
        n_items = int(spec.get("n_items", 100))
        k = int(spec.get("k", 12))
    except (TypeError, ValueError):
        raise HTTPException(400, "n_items and k must be integers")
    if not 1 <= n_items <= 2000:
        raise HTTPException(400, "n_items must be between 1 and 2000")
    if not 1 <= k <= 50:
        raise HTTPException(400, "k must be between 1 and 50")

    elicit = spec.get("elicit", "batch")
    if elicit not in ("batch", "sample"):
        raise HTTPException(400, "elicit must be 'batch' or 'sample'")

    corpus_name = spec.get("corpus", "corpus_full.jsonl")
    corpus = (DATA_DIR / corpus_name).resolve()
    if corpus.parent != DATA_DIR.resolve() or not corpus.is_file():
        raise HTTPException(400, f"corpus must be a file in {DATA_DIR}")

    effort = spec.get("effort") or None
    if effort and effort not in ("low", "medium", "high", "xhigh", "max"):
        raise HTTPException(400, "invalid effort")

    return {
        "models": models,
        "prompts": prompts,
        "n_items": n_items,
        "k": k,
        "elicit": elicit,
        "corpus": corpus_name,
        "effort": effort,
    }


def estimate(cfg: dict) -> dict:
    calls_per_item = 1 if cfg["elicit"] == "batch" else cfg["k"]
    calls = cfg["n_items"] * calls_per_item * len(cfg["prompts"]) * len(cfg["models"])
    per_model_calls = calls / max(1, len(cfg["models"]))

    in_tokens, out_tokens = CALL_SHAPE[cfg["elicit"]]
    total = 0.0
    unpriced = []
    for spec in cfg["models"]:
        provider, _, model = spec.partition(":")
        if provider == "mock":
            continue
        price = PRICES.get(model)
        if price is None:
            unpriced.append(spec)
            continue
        total += per_model_calls * (
            in_tokens / 1e6 * price[0] + out_tokens / 1e6 * price[1]
        )
    return {"calls": int(calls), "usd": round(total, 2), "unpriced": unpriced}


def actual_cost(model_spec: str, input_tokens: int, output_tokens: int) -> float | None:
    """Real spend for a completed run, from the token counts the runner recorded."""
    _, _, model = model_spec.partition(":")
    price = PRICES.get(model)
    if price is None or not (input_tokens or output_tokens):
        return None
    return round(input_tokens / 1e6 * price[0] + output_tokens / 1e6 * price[1], 4)


# --------------------------------------------------------------------------------------
# Job execution
# --------------------------------------------------------------------------------------


def _argv(cfg: dict) -> list[str]:
    argv = [
        sys.executable, "-u", "-m", "srb.run_eval",
        "--corpus", str(DATA_DIR / cfg["corpus"]),
        "--models", *cfg["models"],
        "--prompts", *cfg["prompts"],
        "-n", str(cfg["n_items"]),
        "-k", str(cfg["k"]),
        "--elicit", cfg["elicit"],
        "--out", str(RESULTS_DIR),
    ]
    if cfg["effort"]:
        argv += ["--effort", cfg["effort"]]
    return argv


def _run_job(job_id: str, cfg: dict) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOG_DIR / f"{job_id}.log"
    argv = _argv(cfg)

    with log_path.open("w") as log:
        log.write(f"$ {' '.join(argv)}\n\n")
        log.flush()
        proc = subprocess.Popen(
            argv, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
            env={**os.environ, "PYTHONPATH": str(ROOT)},
        )
        _procs[job_id] = proc
        code = proc.wait()

    _procs.pop(job_id, None)
    with _lock:
        job = _jobs[job_id]
        job["status"] = "done" if code == 0 else ("cancelled" if code < 0 else "failed")
        job["returncode"] = code
        job["finished"] = _now()
    _save_jobs()


# --------------------------------------------------------------------------------------
# Leaderboard
# --------------------------------------------------------------------------------------


def _load_runs() -> list[dict]:
    runs: list[dict] = []
    for path in sorted(RESULTS_DIR.glob("runs-*.json")):
        try:
            payload = json.loads(path.read_text())
        except json.JSONDecodeError:
            continue
        stamp = path.stem.replace("runs-", "")
        for run in payload:
            run["run_id"] = stamp
            run["run_file"] = path.name
            runs.append(run)
    return runs


def _mean(values):
    values = [v for v in values if v is not None and v == v]
    return sum(values) / len(values) if values else None


def build_leaderboard(runs: list[dict]) -> list[dict]:
    """One row per model, using that model's most recent run_id.

    Runs are not pooled across run_ids: different runs may use different item counts,
    k, or corpora, and averaging across them would compare models on different tests.
    """
    latest: dict[str, str] = {}
    for run in sorted(runs, key=lambda r: r["run_id"]):
        latest[run["model"]] = run["run_id"]

    rows = []
    for model, run_id in latest.items():
        group = [r for r in runs if r["model"] == model and r["run_id"] == run_id]
        if not group:
            continue
        tvds = [r["tvd"] for r in group]
        best = min(group, key=lambda r: r["tvd"])
        rows.append(
            {
                "model": model,
                "run_id": run_id,
                "n_prompts": len(group),
                "tvd": _mean(tvds),
                "tvd_best": min(tvds),
                "tvd_worst": max(tvds),
                "prompt_spread": max(tvds) - min(tvds),
                "best_prompt": best["prompt"],
                "sampling_floor": _mean([r["sampling_floor"] for r in group]),
                "excess": _mean([r["excess_over_floor"] for r in group]),
                "marginal": _mean([r["marginal_tvd"] for r in group]),
                "human_holdout": _mean([r["human_holdout"] for r in group]),
                "uniform": _mean([r["uniform_tvd"] for r in group]),
                "facet_mae": _mean([r["facet_mae"] for r in group]),
                "novelty_gap": _mean([r["novelty_gap"] for r in group]),
                "length_gap": _mean([r["length_delta_gap"] for r in group]),
                "beats_marginal": all(r["beats_marginal"] for r in group),
                "n_items": best["n_items"],
                "k": best["k"],
                "elicit": best["elicit"],
                "refusals": sum(r.get("n_refusals", 0) for r in group),
                "errors": sum(r.get("n_errors", 0) for r in group),
                "input_tokens": sum(r.get("n_input_tokens", 0) for r in group),
                "output_tokens": sum(r.get("n_output_tokens", 0) for r in group),
                "actual_usd": actual_cost(
                    model,
                    sum(r.get("n_input_tokens", 0) for r in group),
                    sum(r.get("n_output_tokens", 0) for r in group),
                ),
                "human_dist": best["human_dist"],
                "model_dist": best["model_dist"],
                "human_facets": best["human_facets"],
                "model_facets": best["model_facets"],
                "classes": best["classes"],
                "facet_classes": best["facet_classes"],
                "per_prompt": [
                    {"prompt": r["prompt"], "tvd": r["tvd"], "ci": r["tvd_ci"],
                     "excess": r["excess_over_floor"], "facet_mae": r["facet_mae"],
                     "novelty_gap": r["novelty_gap"], "beats_marginal": r["beats_marginal"]}
                    for r in sorted(group, key=lambda r: r["prompt"])
                ],
            }
        )
    rows.sort(key=lambda r: r["tvd"])
    return rows


# --------------------------------------------------------------------------------------
# API
# --------------------------------------------------------------------------------------


@app.get("/api/config")
def api_config():
    return {
        "prompts": list(PROMPT_NAMES),
        "corpora": sorted(p.name for p in DATA_DIR.glob("*.jsonl")),
        "model_presets": MODEL_PRESETS,
        "keys": {
            "anthropic": bool(os.environ.get("ANTHROPIC_API_KEY")
                              or os.environ.get("ANTHROPIC_AUTH_TOKEN")),
            "openai": bool(os.environ.get("OPENAI_API_KEY")),
        },
    }


@app.post("/api/estimate")
def api_estimate(spec: dict = Body(...)):
    return estimate(_validate(spec))


@app.get("/api/leaderboard")
def api_leaderboard():
    runs = _load_runs()
    return {"rows": build_leaderboard(runs), "n_runs": len(runs)}


@app.get("/api/runs")
def api_runs():
    runs = _load_runs()
    runs.sort(key=lambda r: (r["run_id"], r["model"], r["prompt"]), reverse=True)
    return {"runs": runs}


@app.get("/api/jobs")
def api_jobs():
    with _lock:
        jobs = sorted(_jobs.values(), key=lambda j: j["created"], reverse=True)
    return {"jobs": jobs[:50]}


@app.post("/api/jobs")
def api_create_job(spec: dict = Body(...)):
    cfg = _validate(spec)
    for model in cfg["models"]:
        provider = model.split(":", 1)[0]
        if provider == "anthropic" and not (
            os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")
        ):
            raise HTTPException(400, "ANTHROPIC_API_KEY is not set in the server environment")
        if provider == "openai" and not os.environ.get("OPENAI_API_KEY"):
            raise HTTPException(400, "OPENAI_API_KEY is not set in the server environment")

    job_id = uuid.uuid4().hex[:12]
    job = {
        "id": job_id,
        "config": cfg,
        "estimate": estimate(cfg),
        "status": "running",
        "created": _now(),
        "finished": None,
        "returncode": None,
        "command": " ".join(_argv(cfg)),
    }
    with _lock:
        _jobs[job_id] = job
    _save_jobs()
    threading.Thread(target=_run_job, args=(job_id, cfg), daemon=True).start()
    return job


@app.get("/api/jobs/{job_id}")
def api_job(job_id: str, tail: int = 200):
    with _lock:
        job = _jobs.get(job_id)
    if not job:
        raise HTTPException(404, "no such job")
    log_path = LOG_DIR / f"{job_id}.log"
    log = ""
    if log_path.exists():
        lines = log_path.read_text(errors="replace").splitlines()
        log = "\n".join(lines[-tail:])
    return {**job, "log": log}


@app.post("/api/jobs/{job_id}/cancel")
def api_cancel(job_id: str):
    proc = _procs.get(job_id)
    if not proc:
        raise HTTPException(409, "job is not running")
    proc.send_signal(signal.SIGTERM)
    return {"ok": True}


@app.get("/")
def index():
    return FileResponse(WEB_DIR / "index.html")


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return FileResponse(WEB_DIR / "favicon.svg", media_type="image/svg+xml")


@app.get("/healthz")
def healthz():
    return JSONResponse({"ok": True, "time": _now()})


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--host", default="127.0.0.1",
                    help="default 127.0.0.1; this panel spends money and has no auth")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1"):
        print(
            f"WARNING: binding to {args.host}. This panel starts jobs that spend your API\n"
            "         budget and it has no authentication. Only do this on a trusted network.",
            file=sys.stderr,
        )

    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    _load_jobs()

    import uvicorn

    print(f"Shopper Refinement Benchmark -> http://{args.host}:{args.port}", file=sys.stderr)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
