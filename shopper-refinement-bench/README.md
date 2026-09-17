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
git clone --branch claude/llm-shopping-benchmark-sq6dr3 \
  https://github.com/ajfrai/Abraham-Fraifeld.git
cd Abraham-Fraifeld/shopper-refinement-bench

python3 -m venv .venv && source .venv/bin/activate   # Python 3.10+
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

**Cost.** Adaptive thinking tokens are billed as output and dominate a short generation
like this one, so budget accordingly. Measured against the shipped prompts at k=12, 200
items:

| Configuration | Calls | Est. cost |
|---|---|---|
| Opus 5, 1 prompt, `batch` | 200 | ~$4.20 |
| Opus 5 + Sonnet 5, 3 prompts, `batch` | 1,200 | ~$17.60 |
| Haiku 4.5, 3 prompts, `batch` | 600 | ~$2.50 |
| Opus 5, 1 prompt, `sample` | 2,400 | ~$31.80 |

Start on Haiku or a smaller `-n` to shake out the pipeline before spending on Opus.
Responses are cached under `results/.cache/`, so reruns and crash recovery are free, and
the admin panel prices any configuration before you start it.

---

## Leaderboard and admin panel

```bash
python -m srb.server          # http://127.0.0.1:8000
```

The corpus is committed, so the panel has data the moment the server starts. Runs need a
key in the server's environment:

```bash
export ANTHROPIC_API_KEY=...   # and/or OPENAI_API_KEY
python -m srb.server
```

Without a key the panel still runs `mock:v1`, which is how you check the pipeline for free.

Three tabs:

- **Leaderboard** — models ranked by TVD, each on its most recent run. Runs are never
  pooled across `run_id`, because two runs may differ in item count, `k` or corpus and
  averaging them would compare models on different tests. Clicking a row opens a
  position-on-scale meter (where the model sits between the floor, the human split-half,
  the marginal and uniform), the human-vs-model refinement-type and constraint-type
  distributions, and the per-prompt breakdown with confidence intervals.
- **Run** — pick models, prompt variants, corpus, `n`, `k`, elicitation mode and effort.
  It prices the configuration before you start it and shows actual token spend afterwards.
- **Jobs** — live log tail from the runner, polled while a job is active, with cancel.

**Security.** The panel binds to `127.0.0.1` and has no authentication, because it starts
subprocesses and spends money through your API keys. Do not expose it to a network you do
not control. Every field reaching the subprocess is validated against an allowlist —
model specs must match `^(anthropic|openai|mock):[A-Za-z0-9._-]{1,64}$`, the corpus must
resolve inside `data/`, `n` and `k` are range-bounded — and the command is passed as an
argv list, never through a shell. That layer has its own tests.

---

## Publishing the leaderboard

Live: **https://shopper-refinement-bench.vercel.app**

```bash
python -m srb.publish --out web-dist --note "optional caveat line"
cd web-dist && vercel deploy --prod
```

This snapshots whatever is in `results/` into a self-contained directory of static files
(`index.html`, `app.js`, `styles.css`, `leaderboard.json`, `runs.json`) and serves the
same dashboard in read-only mode: the Run and Jobs tabs are removed and the page reads a
baked JSON file instead of the API. Re-run the two commands to update the published
snapshot. `runs.json` ships alongside it so the page is not the only copy of the numbers.

**The admin panel is not deployed, and cannot be.** Serverless invocations are killed in
seconds while an eval takes minutes; the runner is a subprocess that has to outlive its
HTTP response; and results are written to a filesystem that does not persist between
invocations. Publishing it would also put an unauthenticated endpoint that spends your API
budget on the open internet. The split is deliberate: **runs happen locally, results are
published.** The publisher has a test asserting that no Python file reaches the output
directory.

If you ever do want the runner reachable remotely, it needs a host that allows
long-running processes and persistent disk (Fly, Render, a VM) plus real authentication in
front of it — not a serverless platform.

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
srb/taxonomy.py       5-class labeler + facet layer
srb/build_corpus.py   ESCI -> human refinement neighborhoods
srb/prompts.py        the 3-prompt family
srb/providers.py      anthropic / openai / deterministic mock
srb/metrics.py        TVD, JSD, bootstrap CI, the four baselines
srb/run_eval.py       runner with disk cache and concurrency
srb/report.py         console report
srb/server.py         leaderboard + admin panel (FastAPI, local only)
srb/publish.py        static read-only build for hosting
srb/web/              dashboard front end, no build step
tests/                105 pytest tests
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
