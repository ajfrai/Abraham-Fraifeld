"""Console report rendering."""

from __future__ import annotations

from .taxonomy import FACET_CLASSES, REFINEMENT_CLASSES


def _bar(value: float, width: int = 18, scale: float = 1.0) -> str:
    filled = max(0, min(width, round((value / scale) * width)))
    return "#" * filled + "." * (width - filled)


def _fmt(value: float, places: int = 3) -> str:
    return "n/a" if value != value else f"{value:.{places}f}"


def render_report(runs: list[dict]) -> str:
    out: list[str] = []
    out.append("")
    out.append("=" * 96)
    out.append("SHOPPER REFINEMENT BENCHMARK -- refinement-type distribution vs. real shoppers")
    out.append("=" * 96)
    out.append("")
    out.append("Lower TVD = closer to human. The floor is the TVD an ideal simulator would still")
    out.append("show from sampling k queries. 'excess' = TVD - floor, and is the real signal.")
    out.append("")

    header = (
        f"{'model':28} {'prompt':8} {'TVD':>6} {'95% CI':>15} {'floor':>6} "
        f"{'excess':>7} {'margin':>7} {'facetMAE':>9} {'novelty':>8}"
    )
    out.append(header)
    out.append("-" * len(header))
    for run in sorted(runs, key=lambda r: (r["tvd"])):
        lo, hi = run["tvd_ci"]
        flag = "" if run["beats_marginal"] else "  <- does not beat marginal"
        out.append(
            f"{run['model'][:28]:28} {run['prompt'][:8]:8} {_fmt(run['tvd']):>6} "
            f"[{_fmt(lo)},{_fmt(hi)}] {_fmt(run['sampling_floor']):>6} "
            f"{_fmt(run['excess_over_floor']):>7} {_fmt(run['marginal_tvd']):>7} "
            f"{_fmt(run['facet_mae']):>9} {run['novelty_gap']:+8.3f}{flag}"
        )
    out.append("")

    ref = runs[0]
    out.append("REFERENCE POINTS (averaged over items)")
    out.append(f"  sampling floor (k={ref['k']}) : {_fmt(ref['sampling_floor'])}"
               "   irreducible; no simulator beats this")
    out.append(f"  human holdout (split-half): {_fmt(ref['human_holdout'])}")
    out.append(f"  corpus marginal          : {_fmt(ref['marginal_tvd'])}"
               "   beat this or you are only predicting the prior")
    out.append(f"  uniform                  : {_fmt(ref['uniform_tvd'])}")
    out.append("")

    out.append("REFINEMENT-TYPE DISTRIBUTION")
    names = [c.value for c in REFINEMENT_CLASSES]
    width = max(len(n) for n in names)
    out.append(f"  {'class':{width}}  {'human':>7}  {'model':>7}   (first run shown: "
               f"{ref['model']} / {ref['prompt']})")
    for i, name in enumerate(names):
        h, m = ref["human_dist"][i], ref["model_dist"][i]
        out.append(f"  {name:{width}}  {h:>6.1%}  {m:>6.1%}   h|{_bar(h)}|  m|{_bar(m)}|")
    out.append("")

    out.append("FACET-ADDITION RATE (share of refinements that add this constraint type)")
    fnames = [f.value for f in FACET_CLASSES]
    fwidth = max(len(n) for n in fnames)
    out.append(f"  {'facet':{fwidth}}  {'human':>7}  {'model':>7}")
    for i, name in enumerate(fnames):
        h, m = ref["human_facets"][i], ref["model_facets"][i]
        out.append(f"  {name:{fwidth}}  {h:>6.1%}  {m:>6.1%}   h|{_bar(h, scale=0.4)}|  "
                   f"m|{_bar(m, scale=0.4)}|")
    out.append("")

    out.append("RUN HEALTH")
    for run in runs:
        out.append(
            f"  {run['model'][:26]:26} {run['prompt'][:8]:8} items={run['n_items']:4} "
            f"calls={run['n_calls']:5} refusals={run['n_refusals']:3} "
            f"errors={run['n_errors']:3} empty={run['n_empty']:3} "
            f"tok_in={run['n_input_tokens']:>8} tok_out={run['n_output_tokens']:>8} "
            f"{run['wall_seconds']:>7.1f}s"
        )
    out.append("")
    out.append("novelty_gap: model minus human share of refinement tokens absent from the")
    out.append("result page. Negative = the model copies the page more than people do.")
    out.append("length_gap and per-item scores are in the items-*.json file.")
    out.append("")
    return "\n".join(out)
