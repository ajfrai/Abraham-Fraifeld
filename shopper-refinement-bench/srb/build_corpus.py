"""Build a human query-refinement corpus from the Amazon ESCI Shopping Queries Dataset.

ESCI has no session structure, so it cannot give temporal reformulation chains. What it
*does* give is the query-product relevance graph, and that supports a well-established
alternative construct: **query variants** -- distinct queries that real people issued for
the same underlying product need (Breuer et al., "Validating Simulations of User Query
Variants", ECIR 2022).

Two queries are treated as variants of one need when they share enough Exact-judged
products. The set of variants around a seed query is its *refinement neighborhood*, and
the distribution of taxonomy labels over (seed -> variant) pairs is the human target the
benchmark scores models against.

Limitation, stated plainly and repeated in the README: a variant pair is not a temporal
refinement. It measures how the same need is expressed differently across the shopper
population, not what one shopper typed next. See README "What this does and does not
measure".

Data: https://huggingface.co/datasets/tasksource/esci (Apache-2.0), the Shopping Queries
Dataset of Reddy et al. (2022), arXiv:2206.06588.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

from .taxonomy import label_pair, normalize, tokens

HF_BASE = "https://huggingface.co/datasets/tasksource/esci/resolve/main/data"
TRAIN_SHARDS = [
    "train-00000-of-00011-2d36455632bef8a2.parquet",
    "train-00001-of-00011-18b81793a483996f.parquet",
    "train-00002-of-00011-71f741fdff9a6f54.parquet",
    "train-00003-of-00011-986bc53b83688d99.parquet",
]

COLUMNS = [
    "query",
    "query_id",
    "product_id",
    "product_locale",
    "esci_label",
    "product_title",
    "product_brand",
    "product_color",
]


def _jaccard(a: set, b: set) -> float:
    union = len(a | b)
    return len(a & b) / union if union else 0.0


def load_shards(paths: list[Path], locale: str):
    import pyarrow.parquet as pq

    query_text: dict[int, str] = {}
    exact_products: dict[int, set[str]] = defaultdict(set)
    shown_products: dict[int, list[str]] = defaultdict(list)
    product_meta: dict[str, dict] = {}

    for path in paths:
        pf = pq.ParquetFile(path)
        for batch in pf.iter_batches(batch_size=50_000, columns=COLUMNS):
            cols = {name: batch.column(name).to_pylist() for name in COLUMNS}
            for i in range(batch.num_rows):
                if cols["product_locale"][i] != locale:
                    continue
                qid = cols["query_id"][i]
                pid = cols["product_id"][i]
                query_text.setdefault(qid, cols["query"][i])
                if cols["esci_label"][i] == "Exact":
                    exact_products[qid].add(pid)
                if len(shown_products[qid]) < 40:
                    shown_products[qid].append(pid)
                if pid not in product_meta:
                    product_meta[pid] = {
                        "title": cols["product_title"][i],
                        "brand": cols["product_brand"][i],
                        "color": cols["product_color"][i],
                    }
    return query_text, exact_products, shown_products, product_meta


def build_neighborhoods(
    query_text,
    exact_products,
    *,
    min_shared: int,
    min_jaccard: float,
    min_neighbors: int,
    max_neighbors: int,
    rng: random.Random,
):
    inverted: dict[str, list[int]] = defaultdict(list)
    for qid, pids in exact_products.items():
        for pid in pids:
            inverted[pid].append(qid)

    neighborhoods: dict[int, list[int]] = {}
    for qid, pids in exact_products.items():
        if len(pids) < min_shared:
            continue
        shared_counts: dict[int, int] = defaultdict(int)
        for pid in pids:
            for other in inverted[pid]:
                if other != qid:
                    shared_counts[other] += 1

        seed_norm = normalize(query_text[qid])
        seen_norms = {seed_norm}
        candidates = []
        for other, count in shared_counts.items():
            if count < min_shared:
                continue
            if _jaccard(pids, exact_products[other]) < min_jaccard:
                continue
            other_norm = normalize(query_text[other])
            if other_norm in seen_norms:  # dedupe exact restatements across query_ids
                continue
            seen_norms.add(other_norm)
            candidates.append((other, count))

        if len(candidates) < min_neighbors:
            continue
        candidates.sort(key=lambda kv: (-kv[1], kv[0]))
        chosen = candidates[: max_neighbors * 2]
        if len(chosen) > max_neighbors:
            chosen = rng.sample(chosen, max_neighbors)
        neighborhoods[qid] = [other for other, _ in chosen]
    return neighborhoods


def make_items(
    neighborhoods, query_text, shown_products, product_meta, *, n_results: int
):
    items = []
    for qid, neighbor_ids in neighborhoods.items():
        seed = query_text[qid]
        results = []
        brand_vocab: set[str] = set()
        for pid in shown_products.get(qid, [])[:n_results]:
            meta = product_meta.get(pid)
            if not meta or not meta.get("title"):
                continue
            brand = (meta.get("brand") or "").strip()
            if brand:
                for tok in tokens(brand):
                    if len(tok) > 2:
                        brand_vocab.add(tok)
            results.append(
                {
                    "product_id": pid,
                    "title": meta["title"][:220],
                    "brand": brand or None,
                    "color": (meta.get("color") or None),
                }
            )
        if len(results) < 3:
            continue

        frozen_vocab = frozenset(brand_vocab)
        human_refinements = []
        for nid in neighbor_ids:
            variant = query_text[nid]
            lab = label_pair(seed, variant, frozen_vocab)
            human_refinements.append({"query": variant, "query_id": nid, **lab.as_dict()})

        items.append(
            {
                "item_id": f"esci-{qid}",
                "seed_query": seed,
                "seed_query_id": qid,
                "results": results,
                "brand_vocab": sorted(frozen_vocab),
                "human_refinements": human_refinements,
            }
        )
    return items


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--raw-dir", type=Path, required=True, help="directory holding ESCI parquet shards")
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--locale", default="us")
    ap.add_argument("--min-shared", type=int, default=3, help="min shared Exact products to link two queries")
    ap.add_argument("--min-jaccard", type=float, default=0.25, help="min Jaccard over Exact product sets")
    ap.add_argument("--min-neighbors", type=int, default=6, help="drop seeds with fewer human variants")
    ap.add_argument("--max-neighbors", type=int, default=24)
    ap.add_argument("--n-results", type=int, default=8, help="products shown to the model as the result page")
    ap.add_argument("--max-items", type=int, default=0, help="0 = keep all")
    ap.add_argument("--seed", type=int, default=20260917)
    args = ap.parse_args(argv)

    shards = sorted(args.raw_dir.glob("*.parquet"))
    if not shards:
        sys.exit(f"no parquet shards in {args.raw_dir}; see README for the download command")
    print(f"reading {len(shards)} shard(s)...", file=sys.stderr)
    query_text, exact_products, shown_products, product_meta = load_shards(shards, args.locale)
    print(f"  {len(query_text):,} queries, {len(product_meta):,} products", file=sys.stderr)

    rng = random.Random(args.seed)
    neighborhoods = build_neighborhoods(
        query_text,
        exact_products,
        min_shared=args.min_shared,
        min_jaccard=args.min_jaccard,
        min_neighbors=args.min_neighbors,
        max_neighbors=args.max_neighbors,
        rng=rng,
    )
    print(f"  {len(neighborhoods):,} seeds with >= {args.min_neighbors} variants", file=sys.stderr)

    items = make_items(
        neighborhoods, query_text, shown_products, product_meta, n_results=args.n_results
    )
    items.sort(key=lambda it: it["item_id"])
    if args.max_items:
        rng.shuffle(items)
        items = items[: args.max_items]
        items.sort(key=lambda it: it["item_id"])

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w") as fh:
        for item in items:
            fh.write(json.dumps(item) + "\n")
    n_pairs = sum(len(it["human_refinements"]) for it in items)
    print(f"wrote {len(items):,} items / {n_pairs:,} human refinement pairs -> {args.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
