"""Scoring for refinement-distribution similarity.

The headline metric is Total Variation Distance between the model's distribution over
refinement classes and the human distribution, averaged over items. TVD is used rather
than exact-match next-query accuracy for a specific reason: human refinement is
high-entropy, so exact match has an unknown and low ceiling, and it rewards a model that
collapses onto the single most common action. TVD scores the *shape* of the behavior.

A raw TVD is still uninterpretable on its own, so every run reports it against four
reference points:

  sampling_floor   TVD you get from drawing k samples from the true human distribution.
                   This is the irreducible noise floor at the model's sample size. No
                   simulator, however perfect, scores below this. **This is the number
                   the literature on shopper simulation does not report, and without it
                   a model's score cannot be read as good or bad.**
  human_holdout    TVD between two disjoint halves of the same human neighborhood.
  marginal         TVD from predicting the corpus-wide human marginal for every item,
                   computed leave-one-out. A model that does not beat this is not
                   modeling the item, only the prior.
  uniform          TVD from predicting a uniform distribution over the classes.
"""

from __future__ import annotations

import math
import random
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from .taxonomy import FACET_CLASSES, REFINEMENT_CLASSES, Facet, Refinement


# --------------------------------------------------------------------------------------
# Distances
# --------------------------------------------------------------------------------------


def distribution(labels: Iterable[str], classes: Sequence) -> list[float]:
    counts = Counter(labels)
    total = sum(counts[c.value] for c in classes)
    if total == 0:
        return [0.0] * len(classes)
    return [counts[c.value] / total for c in classes]


def tvd(p: Sequence[float], q: Sequence[float]) -> float:
    """Total variation distance. 0 = identical, 1 = disjoint support."""
    return 0.5 * sum(abs(a - b) for a, b in zip(p, q))


def jensen_shannon(p: Sequence[float], q: Sequence[float]) -> float:
    """JS divergence in bits. Reported alongside TVD; bounded in [0, 1]."""

    def _kl(a, b):
        return sum(x * math.log2(x / y) for x, y in zip(a, b) if x > 0 and y > 0)

    m = [(x + y) / 2 for x, y in zip(p, q)]
    return 0.5 * _kl(p, m) + 0.5 * _kl(q, m)


def facet_rates(facet_lists: Iterable[Sequence[str]]) -> list[float]:
    """Per-facet activation rate. Facets are multi-label, so this is a rate vector, not
    a distribution -- compared with mean absolute error rather than TVD."""
    facet_lists = list(facet_lists)
    if not facet_lists:
        return [0.0] * len(FACET_CLASSES)
    return [
        sum(1 for fl in facet_lists if f.value in fl) / len(facet_lists) for f in FACET_CLASSES
    ]


def mae(p: Sequence[float], q: Sequence[float]) -> float:
    if not p:
        return 0.0
    return sum(abs(a - b) for a, b in zip(p, q)) / len(p)


# --------------------------------------------------------------------------------------
# Baselines
# --------------------------------------------------------------------------------------


def sampling_floor(
    human_labels: Sequence[str], k: int, *, reps: int, rng: random.Random
) -> float:
    """Expected TVD when k draws from the human distribution are scored against it.

    Uses sampling with replacement so the probe is independent of the reference, exactly
    as the model's k predictions are. This is the noise floor at sample size k.
    """
    if not human_labels or k <= 0:
        return float("nan")
    reference = distribution(human_labels, REFINEMENT_CLASSES)
    total = 0.0
    for _ in range(reps):
        probe = [rng.choice(human_labels) for _ in range(k)]
        total += tvd(distribution(probe, REFINEMENT_CLASSES), reference)
    return total / reps


def human_holdout(human_labels: Sequence[str], *, reps: int, rng: random.Random) -> float:
    """TVD between two disjoint halves of the same human neighborhood."""
    if len(human_labels) < 4:
        return float("nan")
    half = len(human_labels) // 2
    total = 0.0
    for _ in range(reps):
        shuffled = list(human_labels)
        rng.shuffle(shuffled)
        total += tvd(
            distribution(shuffled[:half], REFINEMENT_CLASSES),
            distribution(shuffled[half : 2 * half], REFINEMENT_CLASSES),
        )
    return total / reps


def leave_one_out_marginal(
    per_item_labels: Sequence[Sequence[str]], index: int
) -> list[float]:
    """Corpus-wide human marginal computed with item `index` excluded."""
    counts = Counter()
    for i, labels in enumerate(per_item_labels):
        if i != index:
            counts.update(labels)
    total = sum(counts[c.value] for c in REFINEMENT_CLASSES)
    if total == 0:
        return [1 / len(REFINEMENT_CLASSES)] * len(REFINEMENT_CLASSES)
    return [counts[c.value] / total for c in REFINEMENT_CLASSES]


UNIFORM = [1 / len(REFINEMENT_CLASSES)] * len(REFINEMENT_CLASSES)


# --------------------------------------------------------------------------------------
# Aggregation
# --------------------------------------------------------------------------------------


def bootstrap_ci(
    values: Sequence[float], *, reps: int, alpha: float, rng: random.Random
) -> tuple[float, float]:
    """Percentile bootstrap CI over items (the unit of resampling is the item)."""
    clean = [v for v in values if not math.isnan(v)]
    if len(clean) < 2:
        return (float("nan"), float("nan"))
    means = []
    n = len(clean)
    for _ in range(reps):
        means.append(sum(rng.choice(clean) for _ in range(n)) / n)
    means.sort()
    lo = means[int((alpha / 2) * reps)]
    hi = means[min(reps - 1, int((1 - alpha / 2) * reps))]
    return (lo, hi)


def _mean(values: Sequence[float]) -> float:
    clean = [v for v in values if not math.isnan(v)]
    return sum(clean) / len(clean) if clean else float("nan")


@dataclass
class ItemScore:
    item_id: str
    n_human: int
    n_model: int
    tvd: float
    jsd: float
    facet_mae: float
    length_delta_gap: float
    novelty_gap: float
    sampling_floor: float
    human_holdout: float
    marginal_tvd: float
    uniform_tvd: float
    model_dist: list[float] = field(default_factory=list)
    human_dist: list[float] = field(default_factory=list)


@dataclass
class RunScore:
    n_items: int
    tvd: float
    tvd_ci: tuple[float, float]
    jsd: float
    facet_mae: float
    length_delta_gap: float
    novelty_gap: float
    sampling_floor: float
    human_holdout: float
    marginal_tvd: float
    uniform_tvd: float
    excess_over_floor: float
    beats_marginal: bool
    human_dist: list[float]
    model_dist: list[float]
    human_facets: list[float]
    model_facets: list[float]

    def as_dict(self) -> dict:
        d = dict(self.__dict__)
        d["classes"] = [c.value for c in REFINEMENT_CLASSES]
        d["facet_classes"] = [f.value for f in FACET_CLASSES]
        return d


def aggregate(
    item_scores: Sequence[ItemScore],
    *,
    human_dist: list[float],
    model_dist: list[float],
    human_facets: list[float],
    model_facets: list[float],
    bootstrap_reps: int,
    alpha: float,
    rng: random.Random,
) -> RunScore:
    tvds = [s.tvd for s in item_scores]
    mean_tvd = _mean(tvds)
    floor = _mean([s.sampling_floor for s in item_scores])
    marginal = _mean([s.marginal_tvd for s in item_scores])
    return RunScore(
        n_items=len(item_scores),
        tvd=mean_tvd,
        tvd_ci=bootstrap_ci(tvds, reps=bootstrap_reps, alpha=alpha, rng=rng),
        jsd=_mean([s.jsd for s in item_scores]),
        facet_mae=_mean([s.facet_mae for s in item_scores]),
        length_delta_gap=_mean([s.length_delta_gap for s in item_scores]),
        novelty_gap=_mean([s.novelty_gap for s in item_scores]),
        sampling_floor=floor,
        human_holdout=_mean([s.human_holdout for s in item_scores]),
        marginal_tvd=marginal,
        uniform_tvd=_mean([s.uniform_tvd for s in item_scores]),
        excess_over_floor=mean_tvd - floor,
        beats_marginal=bool(mean_tvd < marginal),
        human_dist=human_dist,
        model_dist=model_dist,
        human_facets=human_facets,
        model_facets=model_facets,
    )
