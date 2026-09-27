"""Round-trip tests for RFC 9 recoverable writing on a tiny random model.

Run: python -m tests.test_recoverable   (from the repo root)
"""

import numpy as np

from ducp.paths import all_paths, is_valid
from ducp.recoverable import GPT2, Analyzer, Codebook, cell_count, read, to_items, write


def setup(seed=0, K=40):
    m = GPT2.random(seed=seed)
    r = np.random.default_rng(seed + 1)
    cb = Codebook(r.standard_normal((K, m.d)).astype(np.float32),
                  np.zeros(m.d, np.float32), paths=[all_paths()[i] for i in range(K)])
    return m, cb


def greedy(m, n, start=()):
    ids = [m.prefix_id] + list(start)
    for _ in range(n):
        _, logits, _ = m.context(ids)
        ids.append(int(np.argsort(-logits, kind="stable")[0]))
    return ids[1:]


def test_candidate_units_match_full_forward():
    m, _ = setup()
    ids = [m.prefix_id, 3, 17, 42, 5]
    kv, _, _ = m.context(ids[:-1])
    cand = m.candidate_units(kv, len(ids) - 1, np.array([ids[-1]]))[0]
    _, _, units = m.context(ids)
    assert np.allclose(cand, units[-1], atol=1e-4), np.abs(cand - units[-1]).max()


def roundtrip(tokens, m, cb, **kw):
    an = Analyzer(m, cb)
    cells = write(tokens, an, **kw)
    back = read(cells, Analyzer(m, cb))   # fresh analyzer: nothing shared
    assert back == list(tokens), (back, tokens)
    for it in to_items(cells, cb):
        if isinstance(it, tuple):
            assert is_valid(it[1])
    return cells


def test_random_text():
    m, cb = setup()
    r = np.random.default_rng(5)
    toks = [int(t) for t in r.integers(0, m.vocab - 1, 40)]
    cells = roundtrip(toks, m, cb)
    print(f"random text: {len(toks)} tokens -> {cell_count(cells)} cells "
          f"({sum(c.kind == 'quote' for c in cells)} quotation runs)")


def test_predictable_text():
    m, cb = setup()
    toks = greedy(m, 40, start=[7])
    cells = roundtrip(toks, m, cb)
    longest = max(len(c.tokens) for c in cells if c.kind == "phrase")
    print(f"predictable text: {len(toks)} tokens -> {cell_count(cells)} cells, "
          f"longest phrase {longest} tokens")
    assert cell_count(cells) < len(toks)


def test_forced_quotes():
    m, cb = setup()
    toks = greedy(m, 20, start=[9])
    cells = roundtrip(toks, m, cb, force_quote={5, 6})
    covered = []
    for c in cells:
        if c.kind == "quote":
            covered += c.tokens
    assert toks[5] in covered and toks[6] in covered


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_"):
            f()
            print("ok", name)
