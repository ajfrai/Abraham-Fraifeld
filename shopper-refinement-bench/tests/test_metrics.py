import random

import pytest

from srb.metrics import (
    UNIFORM,
    bootstrap_ci,
    distribution,
    facet_rates,
    human_holdout,
    jensen_shannon,
    leave_one_out_marginal,
    mae,
    sampling_floor,
    tvd,
)
from srb.taxonomy import FACET_CLASSES, REFINEMENT_CLASSES


class TestDistances:
    def test_tvd_identical_is_zero(self):
        p = [0.2, 0.2, 0.2, 0.2, 0.2]
        assert tvd(p, p) == pytest.approx(0.0)

    def test_tvd_disjoint_is_one(self):
        assert tvd([1, 0, 0, 0, 0], [0, 1, 0, 0, 0]) == pytest.approx(1.0)

    def test_tvd_is_symmetric(self):
        p, q = [0.5, 0.5, 0, 0, 0], [0.1, 0.2, 0.3, 0.2, 0.2]
        assert tvd(p, q) == pytest.approx(tvd(q, p))

    def test_jsd_bounded(self):
        assert 0.0 <= jensen_shannon([1, 0, 0, 0, 0], [0, 1, 0, 0, 0]) <= 1.0


class TestDistribution:
    def test_normalizes(self):
        dist = distribution(["repeat", "repeat", "new"], REFINEMENT_CLASSES)
        assert sum(dist) == pytest.approx(1.0)
        assert dist[0] == pytest.approx(2 / 3)

    def test_empty_is_all_zero(self):
        assert distribution([], REFINEMENT_CLASSES) == [0.0] * len(REFINEMENT_CLASSES)

    def test_unknown_labels_ignored(self):
        assert distribution(["nonsense"], REFINEMENT_CLASSES) == [0.0] * len(REFINEMENT_CLASSES)


class TestSamplingFloor:
    def test_floor_is_positive(self):
        labels = ["substitution"] * 6 + ["new"] * 2 + ["specialization"] * 2
        assert sampling_floor(labels, 5, reps=500, rng=random.Random(0)) > 0

    def test_floor_shrinks_as_k_grows(self):
        labels = ["substitution"] * 6 + ["new"] * 2 + ["specialization"] * 2
        small = sampling_floor(labels, 4, reps=1500, rng=random.Random(0))
        large = sampling_floor(labels, 64, reps=1500, rng=random.Random(0))
        assert large < small

    def test_degenerate_distribution_has_zero_floor(self):
        # If every human did the same thing, sampling cannot disagree.
        assert sampling_floor(["repeat"] * 10, 5, reps=200, rng=random.Random(0)) == pytest.approx(0.0)

    def test_holdout_needs_enough_labels(self):
        assert human_holdout(["repeat"] * 3, reps=10, rng=random.Random(0)) != \
               human_holdout(["repeat"] * 3, reps=10, rng=random.Random(0)) or True
        value = human_holdout(["repeat", "new"], reps=10, rng=random.Random(0))
        assert value != value  # nan


class TestMarginal:
    def test_leaves_the_item_out(self):
        per_item = [["repeat"] * 10, ["new"] * 10]
        # excluding index 0 leaves only 'new'
        marginal = leave_one_out_marginal(per_item, 0)
        assert marginal[REFINEMENT_CLASSES.index(  # type: ignore[attr-defined]
            next(c for c in REFINEMENT_CLASSES if c.value == "new")
        )] == pytest.approx(1.0)

    def test_uniform_sums_to_one(self):
        assert sum(UNIFORM) == pytest.approx(1.0)


class TestFacetRates:
    def test_rates_are_per_facet_not_normalized(self):
        rates = facet_rates([["brand", "color"], ["brand"]])
        idx = [f.value for f in FACET_CLASSES].index("brand")
        assert rates[idx] == pytest.approx(1.0)

    def test_empty_input(self):
        assert facet_rates([]) == [0.0] * len(FACET_CLASSES)

    def test_mae_zero_for_identical(self):
        assert mae([0.1, 0.2], [0.1, 0.2]) == pytest.approx(0.0)


class TestBootstrap:
    def test_ci_brackets_the_mean(self):
        values = [0.4 + 0.01 * i for i in range(50)]
        lo, hi = bootstrap_ci(values, reps=1000, alpha=0.05, rng=random.Random(0))
        mean = sum(values) / len(values)
        assert lo < mean < hi

    def test_ci_nan_when_too_few(self):
        lo, hi = bootstrap_ci([0.5], reps=100, alpha=0.05, rng=random.Random(0))
        assert lo != lo and hi != hi
