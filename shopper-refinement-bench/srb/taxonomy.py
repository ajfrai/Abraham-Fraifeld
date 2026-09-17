"""Query-refinement taxonomy.

Implements the five-class reformulation taxonomy that is standard in the query-log
literature (repeat / specialization / generalization / substitution / new), plus a
facet-intent layer that records *which kind of constraint* a refinement adds.

References for the class set:
  Huang & Efthimiadis (2009), "Analyzing and evaluating query reformulation
    strategies in web search logs".
  Liu et al. (2010), "Analysis of query reformulation types on different search tasks".

The labeler is deliberately rule-based and deterministic: the benchmark compares a
*human* label distribution against a *model* label distribution, so the labeler must
apply identical treatment to both sides. A learned or LLM-based labeler would leak
model-specific bias into the measurement.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from enum import Enum
from functools import lru_cache

# --------------------------------------------------------------------------------------
# Refinement classes
# --------------------------------------------------------------------------------------


class Refinement(str, Enum):
    REPEAT = "repeat"
    SPECIALIZATION = "specialization"
    GENERALIZATION = "generalization"
    SUBSTITUTION = "substitution"
    NEW = "new"


REFINEMENT_CLASSES: tuple[Refinement, ...] = (
    Refinement.REPEAT,
    Refinement.SPECIALIZATION,
    Refinement.GENERALIZATION,
    Refinement.SUBSTITUTION,
    Refinement.NEW,
)


# --------------------------------------------------------------------------------------
# Normalization
# --------------------------------------------------------------------------------------

# Kept deliberately small. A large stoplist would collapse meaningful shopping modifiers
# ("for", "without", "with" carry real intent in product queries).
_STOPWORDS = frozenset({"a", "an", "the", "of", "and", "or", "to"})

_PUNCT_RE = re.compile(r"[^\w\s]+", re.UNICODE)
_WS_RE = re.compile(r"\s+")


def _strip_accents(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def normalize(query: str) -> str:
    """Lowercase, strip accents and punctuation, collapse whitespace."""
    text = _strip_accents(query.lower())
    text = _PUNCT_RE.sub(" ", text)
    return _WS_RE.sub(" ", text).strip()


def _stem(token: str) -> str:
    """Very light suffix stripping.

    Without this, 'running shoe' -> 'running shoes' labels as SUBSTITUTION, which is
    wrong: no intent changed. Full Porter stemming is overkill and mangles product
    vocabulary (e.g. 'wireless' -> 'wireless' but 'stainless' -> 'stainl').
    """
    if len(token) <= 3:
        return token
    for suffix in ("ies",):
        if token.endswith(suffix) and len(token) > 4:
            return token[: -len(suffix)] + "y"
    for suffix in ("sses", "shes", "ches", "xes"):
        if token.endswith(suffix):
            return token[:-2]
    if token.endswith("s") and not token.endswith(("ss", "us", "is")):
        return token[:-1]
    return token


def tokens(query: str, *, stem: bool = True, drop_stopwords: bool = True) -> list[str]:
    raw = normalize(query).split()
    if drop_stopwords:
        raw = [t for t in raw if t not in _STOPWORDS]
    if stem:
        raw = [_stem(t) for t in raw]
    return raw


def token_set(query: str, **kwargs) -> frozenset[str]:
    return frozenset(tokens(query, **kwargs))


# --------------------------------------------------------------------------------------
# Spelling-variant detection
# --------------------------------------------------------------------------------------


@lru_cache(maxsize=100_000)
def _edit_distance(a: str, b: str) -> int:
    if a == b:
        return 0
    if len(a) < len(b):
        a, b = b, a
    previous = list(range(len(b) + 1))
    for i, ca in enumerate(a, start=1):
        current = [i]
        for j, cb in enumerate(b, start=1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (ca != cb)))
        previous = current
    return previous[-1]


def _near_duplicate(a: str, b: str) -> bool:
    """True when two tokens are plausibly the same word, one misspelled."""
    if min(len(a), len(b)) < 4:
        return False
    if abs(len(a) - len(b)) > 2:
        return False
    return _edit_distance(a, b) <= max(1, min(len(a), len(b)) // 5)


def is_spelling_variant(q0: str, q1: str) -> bool:
    """True when q1 is q0 with one or more tokens respelled, and nothing else changed."""
    t0, t1 = tokens(q0), tokens(q1)
    if len(t0) != len(t1) or t0 == t1:
        return False
    unmatched0 = [a for a, b in zip(t0, t1) if a != b]
    unmatched1 = [b for a, b in zip(t0, t1) if a != b]
    if not unmatched0 or len(unmatched0) > 2:
        return False
    return all(_near_duplicate(a, b) for a, b in zip(unmatched0, unmatched1))


# --------------------------------------------------------------------------------------
# Facet-intent layer
# --------------------------------------------------------------------------------------


class Facet(str, Enum):
    BRAND = "brand"
    COLOR = "color"
    SIZE_SPEC = "size_spec"
    PRICE_VALUE = "price_value"
    MATERIAL = "material"
    AUDIENCE_USE = "audience_use"
    COMPATIBILITY = "compatibility"


FACET_CLASSES: tuple[Facet, ...] = tuple(Facet)

_COLORS = frozenset(
    """black white red blue green yellow orange purple pink brown grey gray silver gold
    beige navy teal ivory cream tan maroon turquoise burgundy charcoal rose bronze copper
    multicolor transparent clear""".split()
)

_MATERIALS = frozenset(
    """cotton leather silk wool linen polyester nylon denim suede velvet satin fleece
    stainless steel aluminum plastic wood wooden bamboo glass ceramic marble rubber
    silicone titanium brass mesh canvas acrylic""".split()
)

_AUDIENCE = frozenset(
    """men mens women womens kid kids child children boy boys girl girl toddler baby
    infant teen adult unisex dog dogs cat cats pet pets senior""".split()
)

_PRICE_VALUE = frozenset(
    """cheap cheaper cheapest budget affordable inexpensive discount sale deal bargain
    best top rated premium luxury value economical""".split()
)

_COMPAT = frozenset(
    """compatible compatibility replacement adapter converter attachment refill
    cartridge charger cable case cover mount bracket""".split()
)

# Numeric-with-unit, bare dimensions, and garment sizes.
_SIZE_RE = re.compile(
    r"""(?x)
    ^(
        \d+(\.\d+)?(mm|cm|m|in|inch|inche|ft|foot|feet|oz|ounce|lb|lbs|pound|g|kg|ml|l|
                    liter|litre|gb|tb|mb|w|watt|v|volt|amp|mah|hz|mhz|ghz|pc|pk|pack|ct|count)
      | \d+x\d+(x\d+)?
      | xxs|xs|s|m|l|xl|xxl|xxxl|2xl|3xl|4xl
      | small|medium|large|mini|micro|compact|oversized|king|queen|twin|full
    )$
    """
)

_PRICE_PHRASE_RE = re.compile(r"(under|below|less than|over|above)\s*\$?\d+")

# Units that carry a size/spec signal when they follow a bare number ("55 inch tv").
_UNIT_WORDS = frozenset(
    """mm cm m in inch inche inches ft foot feet oz ounce ounces lb lbs pound pounds
    g kg ml l liter litre gallon gb tb mb w watt watts v volt volts amp amps mah hz
    mhz ghz pc pcs pack packs count ct piece pieces gauge ply thread""".split()
)


def _has_number_unit_bigram(toks: list[str]) -> bool:
    for first, second in zip(toks, toks[1:]):
        if first.replace(".", "", 1).isdigit() and second in _UNIT_WORDS:
            return True
    return False



def _facets_of_tokens(toks: list[str], brand_vocab: frozenset[str]) -> set[Facet]:
    found: set[Facet] = set()
    if _has_number_unit_bigram(toks):
        found.add(Facet.SIZE_SPEC)
    for tok in toks:
        if tok in brand_vocab:
            found.add(Facet.BRAND)
        if tok in _COLORS:
            found.add(Facet.COLOR)
        if tok in _MATERIALS:
            found.add(Facet.MATERIAL)
        if tok in _AUDIENCE:
            found.add(Facet.AUDIENCE_USE)
        if tok in _PRICE_VALUE:
            found.add(Facet.PRICE_VALUE)
        if tok in _COMPAT:
            found.add(Facet.COMPATIBILITY)
        if _SIZE_RE.match(tok):
            found.add(Facet.SIZE_SPEC)
    return found


def facets_added(q0: str, q1: str, brand_vocab: frozenset[str] = frozenset()) -> set[Facet]:
    """Facet types present in q1 but not in q0.

    `brand_vocab` should carry brands drawn from the products that actually surface for
    the seed query, so brand detection is grounded in the catalog rather than a guess.
    """
    t0, t1 = tokens(q0), tokens(q1)
    old_set = set(t0)
    new_tokens = [t for t in t1 if t not in old_set]
    added = _facets_of_tokens(new_tokens, brand_vocab)
    if _has_number_unit_bigram(t1) and not _has_number_unit_bigram(t0):
        added.add(Facet.SIZE_SPEC)
    if _PRICE_PHRASE_RE.search(normalize(q1)) and not _PRICE_PHRASE_RE.search(normalize(q0)):
        added.add(Facet.PRICE_VALUE)
    return added


# --------------------------------------------------------------------------------------
# The labeler
# --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class RefinementLabel:
    refinement: Refinement
    facets: frozenset[Facet] = field(default_factory=frozenset)
    spelling_correction: bool = False
    length_delta: int = 0

    def as_dict(self) -> dict:
        return {
            "refinement": self.refinement.value,
            "facets": sorted(f.value for f in self.facets),
            "spelling_correction": self.spelling_correction,
            "length_delta": self.length_delta,
        }


def align_tokens(t0: list[str], t1: list[str]) -> list[str]:
    """Rewrite t1's tokens to their near-duplicate in t0, where one exists.

    Without this, a single misspelled token destroys the lexical overlap and a pair like
    "food thermometer" -> "meat themometer" is labeled NEW (a whole new intent) rather
    than SUBSTITUTION. Query logs are full of typos, so this materially changes the human
    label distribution the benchmark scores against.
    """
    available = list(t0)
    aligned = []
    for tok in t1:
        if tok in available:
            aligned.append(tok)
            continue
        match = next((cand for cand in available if _near_duplicate(tok, cand)), None)
        aligned.append(match if match is not None else tok)
    return aligned


def label_pair(q0: str, q1: str, brand_vocab: frozenset[str] = frozenset()) -> RefinementLabel:
    """Label the transition q0 -> q1."""
    raw0, raw1 = tokens(q0), tokens(q1)
    delta = len(raw1) - len(raw0)
    facets = frozenset(facets_added(q0, q1, brand_vocab))

    exact0, exact1 = frozenset(raw0), frozenset(raw1)
    if exact0 == exact1:
        return RefinementLabel(Refinement.REPEAT, facets, False, delta)

    aligned1 = align_tokens(raw0, raw1)
    a0, a1 = frozenset(raw0), frozenset(aligned1)
    spelling = aligned1 != raw1

    if a0 == a1:
        # Same terms, different spelling: intent unchanged, surface form changed.
        refinement = Refinement.SUBSTITUTION
    elif not (a0 & a1):
        refinement = Refinement.NEW
    elif a0 < a1:
        refinement = Refinement.SPECIALIZATION
    elif a1 < a0:
        refinement = Refinement.GENERALIZATION
    else:
        refinement = Refinement.SUBSTITUTION

    return RefinementLabel(
        refinement=refinement,
        facets=facets,
        spelling_correction=spelling,
        length_delta=delta,
    )
