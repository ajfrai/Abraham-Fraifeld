import pytest

from srb.taxonomy import (
    Facet,
    Refinement,
    align_tokens,
    facets_added,
    is_spelling_variant,
    label_pair,
    normalize,
    tokens,
)


class TestNormalization:
    def test_lowercases_and_strips_punctuation(self):
        assert normalize("Nike  Air-Max, 90!") == "nike air max 90"

    def test_strips_accents(self):
        assert normalize("Termómetro") == "termometro"

    def test_light_stemming_collapses_plurals(self):
        assert tokens("running shoes") == tokens("running shoe")

    def test_stemming_leaves_short_and_ss_words_alone(self):
        assert tokens("dress gas") == ["dress", "gas"]


class TestRefinementClasses:
    @pytest.mark.parametrize(
        "q0,q1,expected",
        [
            ("running shoes", "running shoe", Refinement.REPEAT),
            ("running shoes", "nike running shoes", Refinement.SPECIALIZATION),
            ("nike running shoes", "running shoes", Refinement.GENERALIZATION),
            ("coffee maker", "coffee grinder", Refinement.SUBSTITUTION),
            ("running shoes", "hiking boots", Refinement.NEW),
        ],
    )
    def test_five_classes(self, q0, q1, expected):
        assert label_pair(q0, q1).refinement is expected

    def test_misspelling_is_substitution_not_new(self):
        # Without fuzzy alignment this pair has zero token overlap and lands in NEW,
        # which would inflate the NEW rate across a typo-heavy query log.
        label = label_pair("food thermometer", "meat themometer")
        assert label.refinement is Refinement.SUBSTITUTION
        assert label.spelling_correction is True

    def test_clean_rewording_is_not_flagged_as_spelling(self):
        assert label_pair("food thermometer", "meat thermometer").spelling_correction is False

    def test_length_delta_is_signed(self):
        assert label_pair("shoes", "nike running shoes").length_delta == 2
        assert label_pair("nike running shoes", "shoes").length_delta == -2


class TestSpellingVariant:
    def test_detects_single_typo(self):
        assert is_spelling_variant("bluetooth headphones", "bluetooth headphnes")

    def test_rejects_different_word(self):
        assert not is_spelling_variant("bluetooth headphones", "bluetooth speakers")

    def test_rejects_short_tokens(self):
        assert not is_spelling_variant("cat bed", "cot bed")

    def test_align_tokens_maps_typo_to_source(self):
        assert align_tokens(["thermometer"], ["themometer"]) == ["thermometer"]

    def test_align_tokens_leaves_genuine_words(self):
        assert align_tokens(["shoes"], ["boots"]) == ["boots"]


class TestFacets:
    def test_brand_requires_catalog_vocabulary(self):
        assert facets_added("running shoes", "nike running shoes") == set()
        assert facets_added(
            "running shoes", "nike running shoes", frozenset({"nike"})
        ) == {Facet.BRAND}

    def test_colour(self):
        assert Facet.COLOR in facets_added("shoes", "black shoes")

    def test_number_unit_bigram_is_a_size(self):
        assert Facet.SIZE_SPEC in facets_added("tv", "55 inch tv")

    def test_bare_model_number_is_not_a_size(self):
        # 'iphone 13' is a model number; treating it as a size inflates size_spec.
        assert Facet.SIZE_SPEC not in facets_added("phone case", "iphone 13 phone case")

    def test_price_phrase(self):
        assert Facet.PRICE_VALUE in facets_added("headphones", "headphones under $50")

    def test_only_added_facets_count(self):
        assert facets_added("black shoes", "black running shoes") == set()
