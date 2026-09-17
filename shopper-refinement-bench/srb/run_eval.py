"""Run the refinement benchmark against one or more models."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import asdict
from pathlib import Path

from . import prompts as prompt_lib
from .metrics import (
    ItemScore,
    UNIFORM,
    aggregate,
    distribution,
    facet_rates,
    human_holdout,
    jensen_shannon,
    leave_one_out_marginal,
    mae,
    sampling_floor,
    tvd,
)
from .providers import build_provider
from .report import render_report
from .taxonomy import FACET_CLASSES, REFINEMENT_CLASSES, label_pair, tokens


def load_corpus(path: Path, *, n: int, seed: int) -> list[dict]:
    items = [json.loads(line) for line in path.open() if line.strip()]
    if n and n < len(items):
        rng = random.Random(seed)
        items = rng.sample(items, n)
    items.sort(key=lambda it: it["item_id"])
    return items


def page_vocabulary(item: dict) -> set[str]:
    vocab: set[str] = set()
    for r in item["results"]:
        vocab.update(tokens(r["title"]))
        if r.get("brand"):
            vocab.update(tokens(r["brand"]))
        if r.get("color"):
            vocab.update(tokens(r["color"]))
    return vocab


def novelty(query: str, page_vocab: set[str], seed_vocab: set[str]) -> float:
    toks = tokens(query)
    if not toks:
        return 0.0
    known = page_vocab | seed_vocab
    return sum(1 for t in toks if t not in known) / len(toks)


def cache_key(model_spec: str, prompt_name: str, item_id: str, k: int, elicit: str, rep: int) -> str:
    raw = f"{model_spec}|{prompt_name}|{item_id}|{k}|{elicit}|{rep}"
    return hashlib.sha256(raw.encode()).hexdigest()[:24]


def elicit_queries(provider, item, prompt_name, k, elicit, cache_dir, model_spec):
    """Return (queries, meta). Cached on disk so reruns and crashes are cheap."""
    if elicit == "batch":
        reps, per_rep = 1, k
    else:  # 'sample': k independent single-query calls
        reps, per_rep = k, 1

    all_queries: list[str] = []
    meta = {"refusals": 0, "errors": 0, "input_tokens": 0, "output_tokens": 0, "calls": 0}

    for rep in range(reps):
        key = cache_key(model_spec, prompt_name, item["item_id"], k, elicit, rep)
        cache_path = cache_dir / f"{key}.json" if cache_dir else None
        if cache_path and cache_path.exists():
            payload = json.loads(cache_path.read_text())
        else:
            system, user = prompt_lib.build(prompt_name, item, per_rep)
            completion = provider.complete(system, user, k=per_rep)
            payload = {
                "queries": completion.queries,
                "refused": completion.refused,
                "error": completion.error,
                "usage": completion.usage,
            }
            if cache_path:
                cache_path.write_text(json.dumps(payload))
            meta["calls"] += 1
        all_queries.extend(payload["queries"])
        meta["refusals"] += int(bool(payload.get("refused")))
        meta["errors"] += int(bool(payload.get("error")))
        usage = payload.get("usage") or {}
        meta["input_tokens"] += usage.get("input_tokens", 0)
        meta["output_tokens"] += usage.get("output_tokens", 0)

    return all_queries[:k], meta


def score_item(
    item: dict,
    model_queries: list[str],
    *,
    index: int,
    per_item_human_labels: list[list[str]],
    floor_reps: int,
    rng: random.Random,
) -> ItemScore | None:
    if not model_queries:
        return None

    brand_vocab = frozenset(item["brand_vocab"])
    human = item["human_refinements"]
    human_labels = [h["refinement"] for h in human]
    human_facets_raw = [h["facets"] for h in human]

    model_labels_full = [label_pair(item["seed_query"], q, brand_vocab) for q in model_queries]
    model_labels = [lab.refinement.value for lab in model_labels_full]
    model_facets_raw = [sorted(f.value for f in lab.facets) for lab in model_labels_full]

    h_dist = distribution(human_labels, REFINEMENT_CLASSES)
    m_dist = distribution(model_labels, REFINEMENT_CLASSES)

    page_vocab = page_vocabulary(item)
    seed_vocab = set(tokens(item["seed_query"]))
    h_novelty = sum(novelty(h["query"], page_vocab, seed_vocab) for h in human) / len(human)
    m_novelty = sum(novelty(q, page_vocab, seed_vocab) for q in model_queries) / len(model_queries)

    h_len = sum(h["length_delta"] for h in human) / len(human)
    m_len = sum(lab.length_delta for lab in model_labels_full) / len(model_labels_full)

    return ItemScore(
        item_id=item["item_id"],
        n_human=len(human),
        n_model=len(model_queries),
        tvd=tvd(m_dist, h_dist),
        jsd=jensen_shannon(m_dist, h_dist),
        facet_mae=mae(facet_rates(model_facets_raw), facet_rates(human_facets_raw)),
        length_delta_gap=m_len - h_len,
        novelty_gap=m_novelty - h_novelty,
        sampling_floor=sampling_floor(human_labels, len(model_queries), reps=floor_reps, rng=rng),
        human_holdout=human_holdout(human_labels, reps=floor_reps, rng=rng),
        marginal_tvd=tvd(leave_one_out_marginal(per_item_human_labels, index), h_dist),
        uniform_tvd=tvd(UNIFORM, h_dist),
        model_dist=m_dist,
        human_dist=h_dist,
    )


def run_one(model_spec, prompt_name, items, args, cache_dir):
    provider = build_provider(
        model_spec,
        max_tokens=args.max_tokens,
        effort=args.effort,
        thinking=not args.no_thinking,
    )
    per_item_human_labels = [[h["refinement"] for h in it["human_refinements"]] for it in items]

    results: dict[str, tuple[list[str], dict]] = {}
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        futures = {
            pool.submit(
                elicit_queries,
                provider,
                item,
                prompt_name,
                args.k,
                args.elicit,
                cache_dir,
                model_spec,
            ): item["item_id"]
            for item in items
        }
        done = 0
        for fut in as_completed(futures):
            item_id = futures[fut]
            try:
                results[item_id] = fut.result()
            except Exception as exc:  # keep the run alive; surfaced as an error count
                results[item_id] = ([], {"refusals": 0, "errors": 1, "calls": 0,
                                         "input_tokens": 0, "output_tokens": 0,
                                         "exception": str(exc)})
            done += 1
            if done % 25 == 0 or done == len(items):
                print(f"    {model_spec}/{prompt_name}: {done}/{len(items)}", file=sys.stderr)

    rng = random.Random(args.seed)
    item_scores, all_model_labels, all_human_labels = [], [], []
    all_model_facets, all_human_facets = [], []
    totals = {"refusals": 0, "errors": 0, "calls": 0, "input_tokens": 0, "output_tokens": 0,
              "empty": 0}

    for index, item in enumerate(items):
        queries, meta = results.get(item["item_id"], ([], {}))
        for key in ("refusals", "errors", "calls", "input_tokens", "output_tokens"):
            totals[key] += meta.get(key, 0)
        if not queries:
            totals["empty"] += 1
            continue
        score = score_item(
            item,
            queries,
            index=index,
            per_item_human_labels=per_item_human_labels,
            floor_reps=args.floor_reps,
            rng=rng,
        )
        if score is None:
            continue
        item_scores.append(score)
        brand_vocab = frozenset(item["brand_vocab"])
        for q in queries:
            lab = label_pair(item["seed_query"], q, brand_vocab)
            all_model_labels.append(lab.refinement.value)
            all_model_facets.append(sorted(f.value for f in lab.facets))
        for h in item["human_refinements"]:
            all_human_labels.append(h["refinement"])
            all_human_facets.append(h["facets"])

    if not item_scores:
        raise SystemExit(f"{model_spec}/{prompt_name}: no scorable items (errors={totals['errors']})")

    run = aggregate(
        item_scores,
        human_dist=distribution(all_human_labels, REFINEMENT_CLASSES),
        model_dist=distribution(all_model_labels, REFINEMENT_CLASSES),
        human_facets=facet_rates(all_human_facets),
        model_facets=facet_rates(all_model_facets),
        bootstrap_reps=args.bootstrap_reps,
        alpha=args.alpha,
        rng=rng,
    )
    payload = run.as_dict()
    payload.update(
        model=model_spec,
        prompt=prompt_name,
        k=args.k,
        elicit=args.elicit,
        wall_seconds=round(time.time() - started, 1),
        **{f"n_{key}": value for key, value in totals.items()},
    )
    return payload, [asdict(s) for s in item_scores]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--corpus", type=Path, default=Path("data/corpus_full.jsonl"))
    ap.add_argument("--models", nargs="+", default=["mock:v1"],
                    help="provider:model specs, e.g. anthropic:claude-opus-5 openai:gpt-5")
    ap.add_argument("--prompts", nargs="+", default=list(prompt_lib.PROMPT_NAMES),
                    choices=list(prompt_lib.PROMPT_NAMES))
    ap.add_argument("-n", "--n-items", type=int, default=120)
    ap.add_argument("-k", type=int, default=12, help="refinements elicited per item")
    ap.add_argument("--elicit", choices=("batch", "sample"), default="batch",
                    help="batch: one call for k queries. sample: k independent calls")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--max-tokens", type=int, default=8000)
    ap.add_argument("--effort", default=None, choices=("low", "medium", "high", "xhigh", "max"))
    ap.add_argument("--no-thinking", action="store_true")
    ap.add_argument("--seed", type=int, default=20260917)
    ap.add_argument("--floor-reps", type=int, default=400)
    ap.add_argument("--bootstrap-reps", type=int, default=2000)
    ap.add_argument("--alpha", type=float, default=0.05)
    ap.add_argument("--out", type=Path, default=Path("results"))
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args(argv)

    if not args.corpus.exists():
        sys.exit(f"corpus not found: {args.corpus}\nBuild it first -- see README Quickstart.")

    items = load_corpus(args.corpus, n=args.n_items, seed=args.seed)
    print(f"{len(items)} items, k={args.k}, elicit={args.elicit}", file=sys.stderr)

    args.out.mkdir(parents=True, exist_ok=True)
    cache_dir = None if args.no_cache else args.out / ".cache"
    if cache_dir:
        cache_dir.mkdir(exist_ok=True)

    runs, per_item = [], {}
    for model_spec in args.models:
        for prompt_name in args.prompts:
            print(f"  running {model_spec} / {prompt_name}", file=sys.stderr)
            payload, scores = run_one(model_spec, prompt_name, items, args, cache_dir)
            runs.append(payload)
            per_item[f"{model_spec}|{prompt_name}"] = scores

    stamp = time.strftime("%Y%m%dT%H%M%S")
    (args.out / f"runs-{stamp}.json").write_text(json.dumps(runs, indent=2))
    (args.out / f"items-{stamp}.json").write_text(json.dumps(per_item, indent=2))
    (args.out / "latest.json").write_text(json.dumps(runs, indent=2))

    report = render_report(runs)
    print(report)
    (args.out / f"report-{stamp}.txt").write_text(report)
    print(f"\nwrote {args.out}/runs-{stamp}.json", file=sys.stderr)


if __name__ == "__main__":
    main()
