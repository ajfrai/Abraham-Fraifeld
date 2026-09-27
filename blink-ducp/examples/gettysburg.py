"""Encode the Gettysburg Address in recoverable writing (RFC 9, Section 5),
read it back, and render it.

    pip install numpy reportlab safetensors huggingface_hub tokenizers
    python -m examples.gettysburg                      # stand-in codebook
    python -m examples.gettysburg --codebook out/      # real codebook (RFC 5)

--codebook expects codebook.f16.npy, mean.npy and paths.json from the build.
Without it, a STAND-IN codebook is used: the unit of each of the 50,257 tokens
taken alone (RFC 5's initialization), with paths in canonical order. The
stand-in shows the mechanism; its characters are not ducP.

Every position costs one batched pass over all 50,257 candidate tokens through
six blocks. On a laptop CPU that is tens of seconds per position, so expect
hours for writing and again for reading. Results are cached in --cache;
reading uses a separate cache by default so that it checks the writing
independently.
"""

import argparse
import json
import os
import time

import numpy as np

from ducp.paths import all_paths
from ducp.recoverable import GPT2, Analyzer, Codebook, cell_count, read, to_items, write
from ducp.render import render_pdf

TEXT = (
    "Four score and seven years ago our fathers brought forth on this continent, a new nation, "
    "conceived in Liberty, and dedicated to the proposition that all men are created equal.\n\n"
    "Now we are engaged in a great civil war, testing whether that nation, or any nation so "
    "conceived and so dedicated, can long endure. We are met on a great battle-field of that war. "
    "We have come to dedicate a portion of that field, as a final resting place for those who here "
    "gave their lives that that nation might live. It is altogether fitting and proper that we "
    "should do this.\n\n"
    "But, in a larger sense, we can not dedicate—we can not consecrate—we can not "
    "hallow—this ground. The brave men, living and dead, who struggled here, have consecrated "
    "it, far above our poor power to add or detract. The world will little note, nor long remember "
    "what we say here, but it can never forget what they did here. It is for us the living, rather, "
    "to be dedicated here to the unfinished work which they who fought here have thus far so nobly "
    "advanced. It is rather for us to be here dedicated to the great task remaining before "
    "us—that from these honored dead we take increased devotion to that cause for which they "
    "gave the last full measure of devotion—that we here highly resolve that these dead shall "
    "not have died in vain—that this nation, under God, shall have a new birth of "
    "freedom—and that government of the people, by the people, for the people, shall not "
    "perish from the earth."
)


def standin_codebook(m: GPT2):
    kv, _, _ = m.context([m.prefix_id])
    units = m.candidate_units(kv, 1, np.arange(m.vocab))
    mean = units.mean(0)
    return Codebook(units, mean, paths=[all_paths()[i] for i in range(m.vocab)])


def load_codebook(d):
    cw = np.load(os.path.join(d, "codebook.f16.npy")).astype(np.float32)
    mean = np.load(os.path.join(d, "mean.npy")).astype(np.float32)
    paths = [tuple(p) for p in json.load(open(os.path.join(d, "paths.json")))]
    return Codebook(cw, mean, paths=paths)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--codebook")
    ap.add_argument("--cache", default="cache/gettysburg")
    ap.add_argument("--out", default="examples/gettysburg")
    ap.add_argument("--reuse-cache-for-reading", action="store_true")
    ap.add_argument("--greedy-check", action="store_true",
                    help="quick: how far GPT-2's own continuation matches the text")
    a = ap.parse_args()

    from tokenizers import Tokenizer
    _t = Tokenizer.from_pretrained("openai-community/gpt2")

    class tok:  # the original GPT-2 byte-level BPE
        encode = staticmethod(lambda s: _t.encode(s).ids)
        decode = staticmethod(lambda ids: _t.decode(list(ids)))

    m = GPT2.from_hf()
    if a.greedy_check:
        ids = tok.encode(TEXT)
        ctx, run, runs = [m.prefix_id], 0, []
        for i, t in enumerate(ids):
            _, logits, _ = m.context(ctx)
            g = int(np.argsort(-logits, kind="stable")[0])
            if g == t:
                run += 1
            else:
                if run:
                    runs.append((run, i - run))
                run = 0
            ctx.append(t)
        if run:
            runs.append((run, len(ids) - run))
        runs.sort(reverse=True)
        print(f"{len(ids)} tokens; {sum(r for r, _ in runs)} are GPT-2's first guess")
        for r, s0 in runs[:8]:
            print(f"  run of {r:3d} from token {s0}: {tok.decode(ids[s0:s0 + r])!r}")
        return
    cb = load_codebook(a.codebook) if a.codebook else standin_codebook(m)
    label = "real codebook" if a.codebook else "STAND-IN codebook (not ducP)"

    ids = tok.encode(TEXT)
    assert len(ids) <= 1023, "one segment only"
    print(f"{len(ids)} tokens; {label}")

    t0 = time.time()
    tick = lambda i, n: print(f"  analyzed {i}/{n}  {time.time() - t0:.0f}s", flush=True)
    cells = write(ids, Analyzer(m, cb, a.cache + "/write"), log=tick)

    rcache = a.cache + ("/write" if a.reuse_cache_for_reading else "/read")
    back = read(cells, Analyzer(m, cb, rcache))
    exact = back == ids
    print("exact recovery:", exact)

    rows = []
    for i, c in enumerate(cells, 1):
        text = tok.decode(c.tokens)
        kind = "phrase" if c.kind == "phrase" else "quotation"
        rows.append(dict(cell=i, kind=kind, codeword=c.codeword, skips=c.skips,
                         tokens=len(c.tokens), text=text))
        print(f"{i:4d}  {kind:9s} skips={c.skips}  {len(c.tokens):3d} tok  {text!r}")
    n_cells = cell_count(cells)
    longest = sorted((r for r in rows if r["kind"] == "phrase"), key=lambda r: -r["tokens"])[:5]
    print(f"\n{len(ids)} tokens -> {n_cells} cells ({n_cells / len(ids):.2f} per token)")
    print("longest phrases:")
    for r in longest:
        print(f"  {r['tokens']:3d} tokens: {r['text']!r}")

    os.makedirs(os.path.dirname(a.out) or ".", exist_ok=True)
    json.dump(dict(label=label, tokens=len(ids), cells=n_cells, exact=exact, rows=rows),
              open(a.out + ".json", "w"), indent=1)
    pages, _, _ = render_pdf(to_items(cells, cb), a.out + ".pdf")
    print(f"wrote {a.out}.json and {a.out}.pdf ({pages} page(s))")


if __name__ == "__main__":
    main()
