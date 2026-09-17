"""Standardized prompt family.

LLM refinement behavior is strongly prompt-dependent, so a single prompt measures a
prompt, not a model. Every run sweeps this family and the report shows the spread; a
result that does not survive the spread is not a result.

The three framings differ on one axis -- how much the model is asked to *be* a shopper
versus to *continue a log*. Roleplay framings tend to elicit the model's idea of a
sensible shopper; log-continuation framings tend to elicit something closer to its
distributional prior. Which one a model does better on is itself a finding.
"""

from __future__ import annotations

from typing import Callable

SYSTEM_NEUTRAL = (
    "You model how real people use e-commerce search. You answer only with the JSON "
    "array that was requested, with no commentary."
)

SYSTEM_PERSONA = (
    "You are simulating an ordinary online shopper browsing a large e-commerce site. "
    "You are not an assistant helping them; you are producing the queries such a shopper "
    "would actually type, typos, terseness and all. You answer only with the JSON array "
    "that was requested, with no commentary."
)

SYSTEM_LOG = (
    "You complete anonymized e-commerce search logs. Given a logged query and the results "
    "it returned, you emit further queries observed in the same logs for the same shopping "
    "need. You answer only with the JSON array that was requested, with no commentary."
)


def render_results(results: list[dict], limit: int = 8) -> str:
    lines = []
    for i, r in enumerate(results[:limit], start=1):
        bits = [r["title"]]
        if r.get("brand"):
            bits.append(f"brand: {r['brand']}")
        if r.get("color"):
            bits.append(f"colour/variant: {r['color']}")
        lines.append(f"{i}. " + " | ".join(bits))
    return "\n".join(lines)


def _user_neutral(seed: str, results: str, k: int) -> str:
    return f"""A shopper searched an e-commerce site for:

    "{seed}"

These are the top results they saw:

{results}

List {k} different search queries that real shoppers with this same need are observed to \
type. Cover the range of what different people actually do, not only the most sensible \
option.

Return a JSON array of {k} strings and nothing else."""


def _user_persona(seed: str, results: str, k: int) -> str:
    return f"""You searched for:

    "{seed}"

You are looking at these results:

{results}

Write the next {k} searches you might type from here, as {k} different shoppers with this \
same need would. Write them the way people really type into a search box.

Return a JSON array of {k} strings and nothing else."""


def _user_log(seed: str, results: str, k: int) -> str:
    return f"""LOGGED QUERY: "{seed}"

RESULTS RETURNED:
{results}

Emit the next {k} distinct queries recorded in the log for this same shopping need.

Return a JSON array of {k} strings and nothing else."""


PromptFn = Callable[[str, str, int], str]

PROMPTS: dict[str, tuple[str, PromptFn]] = {
    "neutral": (SYSTEM_NEUTRAL, _user_neutral),
    "persona": (SYSTEM_PERSONA, _user_persona),
    "log": (SYSTEM_LOG, _user_log),
}

PROMPT_NAMES = tuple(PROMPTS)


def build(prompt_name: str, item: dict, k: int, n_results: int = 8) -> tuple[str, str]:
    system, fn = PROMPTS[prompt_name]
    results = render_results(item["results"], limit=n_results)
    return system, fn(item["seed_query"], results, k)
