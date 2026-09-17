"""Build a static, read-only leaderboard for hosting (Vercel, Pages, any static host).

Why static: the admin panel cannot run on a serverless host. Evals take minutes and
serverless invocations are killed in seconds; the runner is a subprocess that must
outlive its HTTP response; and results are written to a filesystem that does not persist
between invocations. Publishing a public panel would also put an unauthenticated
money-spending endpoint on the open internet.

So the split is: **runs happen locally, results are published**. This snapshots whatever
is in results/ into a self-contained directory of static files, with the same dashboard
front end in read-only mode.

    python -m srb.publish --out web-dist
    cd web-dist && vercel deploy --prod
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

from .server import ROOT, WEB_DIR, _load_runs, build_leaderboard

STATIC_ASSETS = ("styles.css", "app.js", "favicon.svg")

VERCEL_JSON = {
    "cleanUrls": True,
    "headers": [
        {
            "source": "/leaderboard.json",
            "headers": [{"key": "Cache-Control", "value": "public, max-age=0, must-revalidate"}],
        }
    ],
}


def build(out_dir: Path, *, title_note: str | None = None) -> dict:
    runs = _load_runs()
    if not runs:
        sys.exit(
            "No runs found in results/.\n"
            "Run an eval first, e.g.:  python -m srb.run_eval --models mock:v1 -n 40 -k 10"
        )

    rows = build_leaderboard(runs)
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")
    payload = {
        "rows": rows,
        "n_runs": len(runs),
        "generated": generated,
        "note": title_note,
        "static": True,
    }

    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True)

    for name in STATIC_ASSETS:
        shutil.copy2(WEB_DIR / name, out_dir / name)

    html = (WEB_DIR / "index.html").read_text()
    # Read-only mode: the front end reads a baked JSON file and drops the Run/Jobs tabs.
    html = html.replace(
        '<script src="/static/app.js"></script>',
        '<script>window.SRB_STATIC = true;</script>\n<script src="app.js"></script>',
    )
    html = html.replace('href="/static/styles.css"', 'href="styles.css"')
    html = html.replace('href="/static/favicon.svg"', 'href="favicon.svg"')
    (out_dir / "index.html").write_text(html)

    (out_dir / "leaderboard.json").write_text(json.dumps(payload, indent=2))
    (out_dir / "vercel.json").write_text(json.dumps(VERCEL_JSON, indent=2))

    # Ship the full run records too, so the page is not the only copy of the numbers.
    (out_dir / "runs.json").write_text(json.dumps(runs, indent=2))

    return {"rows": len(rows), "runs": len(runs), "generated": generated, "out": str(out_dir)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--out", type=Path, default=ROOT / "web-dist")
    ap.add_argument("--note", default=None,
                    help="short line shown under the standings, e.g. 'mock data only'")
    args = ap.parse_args(argv)

    info = build(args.out, title_note=args.note)
    print(
        f"built {info['out']}: {info['rows']} models from {info['runs']} runs "
        f"({info['generated']})",
        file=sys.stderr,
    )
    print(f"deploy with:  cd {info['out']} && vercel deploy --prod", file=sys.stderr)


if __name__ == "__main__":
    main()
