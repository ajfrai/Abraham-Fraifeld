"""Download ESCI parquet shards from the Hugging Face mirror.

Source: https://huggingface.co/datasets/tasksource/esci  (Apache-2.0)
Paper:  Reddy et al. (2022), "Shopping Queries Dataset: A Large-Scale ESCI Benchmark
        for Improving Product Search", arXiv:2206.06588
"""

from __future__ import annotations

import argparse
import sys
import urllib.request
from pathlib import Path

BASE = "https://huggingface.co/datasets/tasksource/esci/resolve/main/data"

SHARDS = [
    "train-00000-of-00011-2d36455632bef8a2.parquet",
    "train-00001-of-00011-18b81793a483996f.parquet",
    "train-00002-of-00011-71f741fdff9a6f54.parquet",
    "train-00003-of-00011-986bc53b83688d99.parquet",
    "train-00004-of-00011-207d8e840a42bc39.parquet",
    "train-00005-of-00011-14047762cd2d57cc.parquet",
]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out-dir", type=Path, default=Path("data/raw"))
    ap.add_argument("--shards", type=int, default=3,
                    help="how many shards to pull (~120-200 MB each; 3 gives ~1.2k seeds)")
    args = ap.parse_args(argv)

    args.out_dir.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(SHARDS[: args.shards]):
        dest = args.out_dir / f"esci_train_{i:02d}.parquet"
        if dest.exists():
            print(f"[{i + 1}/{args.shards}] {dest} exists, skipping", file=sys.stderr)
            continue
        print(f"[{i + 1}/{args.shards}] downloading {name}", file=sys.stderr)
        urllib.request.urlretrieve(f"{BASE}/{name}", dest)
        print(f"    -> {dest} ({dest.stat().st_size / 1e6:.0f} MB)", file=sys.stderr)
    print("done", file=sys.stderr)


if __name__ == "__main__":
    main()
