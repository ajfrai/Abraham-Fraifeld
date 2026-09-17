# Shopper Refinement Benchmark

**Do frontier LLMs refine shopping queries the way real shoppers do?**

This measures one narrow thing: given a shopping query and the results it returned, does a
model produce the same *distribution of refinement types* — specialize, generalize,
substitute, restate, abandon-and-restart — and the same *mix of constraint types*
(brand, colour, size, price, compatibility) that real people produce?

It deliberately does not score task success, purchase prediction, or motivation. The
existing agentic shopping benchmarks cover those. Refinement-type distribution is not
covered, in shopping, by anything public.

---

## Why distribution rather than next-query accuracy

Published shopper-simulation benchmarks score exact-match next-action prediction, where
frontier models land around 11–21%. That metric has two defects this benchmark avoids:

1. **Its ceiling is unknown.** Nobody reports how well one human predicts another human's
   next query, so a 20% score cannot be read as good or bad.
2. **It rewards mode collapse.** Always predicting the single most common action scores
   well and is maximally unlike a population of shoppers.

Here the unit of comparison is a distribution, scored with Total Variation Distance, and
**every run reports the noise floor**: the TVD an ideal simulator would still show simply
from drawing `k` samples. That number is computed per item by resampling the human labels,
and it is the reference point missing from the published work.

```
TVD  0.0 ─────────── floor ─────────── your model ─────── marginal ─────── uniform  1.0
                      ▲                                      ▲
         no simulator beats this              beat this or you are only
         (sampling noise at k)                 predicting the corpus prior
```

Four reference points print with every run:

| Reference | Meaning |
|---|---|
| `sampling_floor` | Irreducible noise at sample size `k`. Hard lower bound. |
| `human_holdout` | TVD between two disjoint halves of the same human neighborhood. |
| `marginal` | Predicting the corpus-wide human marginal for every item, leave-one-out. A model that fails to beat this is not modeling the item. |
| `uniform` | Predicting a flat distribution. Sanity floor. |

The reported `excess = TVD − floor` is the actual signal.

---

## What this does and does not measure

**The data.** Amazon [ESCI Shopping Queries](https://github.com/amazon-science/esci-data)
(Apache-2.0; Reddy et al. 2022, arXiv:2206.06588) — 130k+ real shopper queries in raw
text with query–product relevance judgments.

**The construct.** ESCI has no sessions, so it cannot supply temporal refinement chains.
It does supply the query–product graph, which supports **query variants**: distinct
queries real people issued for the same product need, identified here by shared
Exact-judged products (Jaccard ≥ 0.25, ≥ 3 shared products). This is the construct used in
the IR user-simulation literature (Breuer et al., *Validating Simulations of User Query
Variants*, ECIR 2022).

**The limitation, stated plainly.** A variant pair is **not** a temporal refinement. This
measures how the same need is expressed differently *across the shopper population*, not
what one shopper typed next after seeing results. Every public e-commerce session dataset
with real reformulation chains — Coveo SIGIR 2021, JDsearch, Diginetica, Yandex — ships
query text as embeddings or anonymized token IDs, which cannot be fed to an LLM. That is
the binding constraint, not an oversight. If you obtain session data with raw text
(SCEM by request, or your own logs), `build_corpus.py` is the only file that changes.

Other limits worth knowing before you cite a number:

- **Facet detection is lexical**, grounded in each item's catalog brands plus vocabularies
  for colour/material/audience/price and a number+unit rule. It measures constraints typed
  *into the query box*, which is a proxy for filter clicks, not filter clicks themselves.
  No public dataset has shopping facet-application logs.
- `facets_added` counts facets that appear in the refinement and not the seed. A *changed*
  size (`55 inch tv` → `65 inch tv`) is not an addition and scores zero.
- ESCI queries are from ~2022 and may be in training data. Contamination would help models
  here, so a poor score is still meaningful; a strong score deserves suspicion.
- The corpus is US-locale English only.

---

## Quickstart

```bash
pip install -r requirements.txt

# 1. Fetch ESCI shards (~120-200 MB each; 3 shards -> ~1.2k seeds)
python -m srb.fetch_data --out-dir data/raw --shards 3

# 2. Build the human refinement corpus
python -m srb.build_corpus --raw-dir data/raw --out data/corpus_full.jsonl

# 3. Verify the pipeline with no API key and no spend
python -m srb.run_eval --models mock:v1 -n 40 -k 10

# 4. Run real models
export ANTHROPIC_API_KEY=...
python -m srb.run_eval \
  --corpus data/corpus_full.jsonl \
  --models anthropic:claude-opus-5 anthropic:claude-sonnet-5 \
  --prompts neutral persona log \
  -n 200 -k 12
```

A prebuilt corpus is committed: `data/corpus_full.jsonl` (1,238 seeds / 10,217 human
refinement pairs) and `data/corpus_dev.jsonl` (200 seeds) — so steps 1–2 are optional.

**Cost.** One `(model, prompt)` run over 200 items in `batch` mode is 200 calls of roughly
600 input / 300 output tokens. On Claude Opus 5 that is about **$0.2 per run**; the three
prompt variants across two models is about **$1.3**. `--elicit sample` multiplies call
count by `k`. Responses are cached under `results/.cache/`, so reruns and crash recovery
are free.

---

## Metrics

| Metric | What it catches |
|---|---|
| `TVD` | Overall mismatch in refinement-type mix. **Headline.** |
| `excess` | `TVD − sampling_floor`. The part not explained by sampling noise. |
| `facet_MAE` | Mean absolute error across the 7 constraint types. Catches a model that specializes at the right rate but always reaches for price when people reach for brand. |
| `novelty_gap` | Model minus human share of refinement tokens absent from the result page. Negative = the model copies the page; people bring outside vocabulary. |
| `length_gap` | Signed token-count delta difference. Catches models that always make queries longer. |
| `JSD` | Reported alongside TVD; less sensitive to zero-support classes. |

Confidence intervals are percentile bootstrap over items (items are the resampling unit).

## Prompt sensitivity is part of the measurement

LLM refinement behavior is strongly prompt-dependent, so a single prompt measures a
prompt, not a model. Three framings ship (`neutral`, `persona`, `log`) varying how much
the model is asked to *be* a shopper versus to *continue a log*. **Report the spread.** A
result that does not survive all three is not a result.

Two elicitation modes:

- `--elicit batch` (default): one call returning `k` queries. Cheap. Measures the model's
  *explicit* account of how shoppers vary.
- `--elicit sample`: `k` independent single-query calls. `k`× the cost. Measures the
  model's *implicit* distribution. More principled; use it for anything you publish.

They are different constructs and should not be compared to each other.

## Design notes

**No server-side fallbacks.** The Anthropic SDK can reroute a refused request to another
model. That is deliberately disabled: silently substituting a model would attribute one
model's outputs to another. Refusals are recorded and excluded, and the count prints in
RUN HEALTH.

**The labeler is rule-based, not learned.** Both human and model refinements pass through
the identical deterministic labeler. An LLM judge would leak model-specific bias into the
thing being measured.

## Layout

```
srb/taxonomy.py       5-class labeler + facet layer      (41 unit tests)
srb/build_corpus.py   ESCI -> human refinement neighborhoods
srb/prompts.py        the 3-prompt family
srb/providers.py      anthropic / openai / deterministic mock
srb/metrics.py        TVD, JSD, bootstrap CI, the four baselines
srb/run_eval.py       runner with disk cache and concurrency
srb/report.py         console report
tests/                pytest
```

```bash
python -m pytest tests/ -q
```

## Taxonomy

Five classes, standard in the query-log literature (Huang & Efthimiadis 2009; Liu et al.
2010): `repeat`, `specialization`, `generalization`, `substitution`, `new`. Fuzzy token
alignment folds misspellings into `substitution` rather than letting a typo destroy
lexical overlap and register as a brand-new intent — query logs are typo-heavy and this
materially shifts the human distribution.

Seven facet types: `brand`, `color`, `size_spec`, `price_value`, `material`,
`audience_use`, `compatibility`.

## Status

MVP. The corpus, labeler, metrics and runner are complete and tested. What it needs next,
in order of value:

1. **A human-human ceiling from real session data** — the sampling floor bounds below; a
   session corpus with raw query text would bound above.
2. **Facet-click ground truth** — a small instrumented study (n≈40) logging queries *and*
   filter clicks. No public dataset supplies this, which makes it the most valuable thing
   anyone could add here.
3. **Locale sweep** — ESCI ships Japanese and Spanish; refinement style is likely
   culture-dependent and the corpus builder already takes `--locale`.
