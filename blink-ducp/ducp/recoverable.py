"""Recoverable writing (RFC 9, Section 5): phrases, skip marks, quotation.

Everything here is deterministic given (weights, codebook, mean, backend).
Writer and reader MUST use the same backend and dtype: floating-point
differences can move a unit across a codeword boundary.

Model: GPT-2 small, implemented directly from its weights so that the layer-6
unit of every candidate next token can be computed in one batch from a cached
context. A unit is hidden_states[6] in Hugging Face terms: the residual stream
after the 6th of 12 blocks, before any final layer norm.

Positions: position 0 holds the prefix <|endoftext|> (50256). Text token i is
at position i + 1.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass, field

import numpy as np

UNIT_LAYER = 6          # hidden_states index: blocks 0..5 applied
MAX_SKIPS = 3           # RFC 9, Section 5.5
PREFIX_ID = 50256


# ---------------------------------------------------------------- model ---
def _ln(x, g, b, eps=1e-5):
    mu = x.mean(-1, keepdims=True)
    var = ((x - mu) ** 2).mean(-1, keepdims=True)
    return (x - mu) / np.sqrt(var + eps) * g + b


def _gelu(x):
    return 0.5 * x * (1.0 + np.tanh(np.sqrt(2.0 / np.pi) * (x + 0.044715 * x ** 3)))


def _softmax(x, axis=-1):
    x = x - x.max(axis=axis, keepdims=True)
    e = np.exp(x)
    return e / e.sum(axis=axis, keepdims=True)


class GPT2:
    """Minimal float32 NumPy GPT-2 with the two operations RFC 9 needs."""

    def __init__(self, params: dict, n_head: int, prefix_id: int = PREFIX_ID):
        self.p = params
        self.n_head = n_head
        self.prefix_id = prefix_id
        self.vocab, self.d = params["wte"].shape
        self.n_layer = len(params["blocks"])
        assert self.n_layer > UNIT_LAYER

    # -- loading ---------------------------------------------------------
    @classmethod
    def from_hf(cls, name: str = "openai-community/gpt2"):
        """Load the original GPT-2 small weights (safetensors; no torch needed)."""
        import json
        from huggingface_hub import hf_hub_download
        from safetensors.numpy import load_file
        cfg = json.load(open(hf_hub_download(name, "config.json")))
        raw = load_file(hf_hub_download(name, "model.safetensors"))
        sd = {k[len("transformer."):] if k.startswith("transformer.") else k: v.astype(np.float32)
              for k, v in raw.items()}
        blocks = []
        for i in range(cfg["n_layer"]):
            f = lambda k: sd[f"h.{i}.{k}"]
            blocks.append(dict(
                ln1_g=f("ln_1.weight"), ln1_b=f("ln_1.bias"),
                attn_w=f("attn.c_attn.weight"), attn_b=f("attn.c_attn.bias"),
                proj_w=f("attn.c_proj.weight"), proj_b=f("attn.c_proj.bias"),
                ln2_g=f("ln_2.weight"), ln2_b=f("ln_2.bias"),
                fc_w=f("mlp.c_fc.weight"), fc_b=f("mlp.c_fc.bias"),
                mproj_w=f("mlp.c_proj.weight"), mproj_b=f("mlp.c_proj.bias")))
        params = dict(wte=sd["wte.weight"], wpe=sd["wpe.weight"],
                      lnf_g=sd["ln_f.weight"], lnf_b=sd["ln_f.bias"], blocks=blocks)
        return cls(params, cfg["n_head"], prefix_id=cfg.get("eos_token_id", PREFIX_ID))

    @classmethod
    def random(cls, vocab=200, d=32, n_head=2, n_layer=8, n_ctx=128, seed=0):
        """Tiny random model with GPT-2's shape, for tests only."""
        r = np.random.default_rng(seed)
        n = lambda *s: (r.standard_normal(s) * 0.2).astype(np.float32)
        blocks = [dict(ln1_g=np.ones(d, np.float32), ln1_b=n(d), attn_w=n(d, 3 * d), attn_b=n(3 * d),
                       proj_w=n(d, d), proj_b=n(d), ln2_g=np.ones(d, np.float32), ln2_b=n(d),
                       fc_w=n(d, 4 * d), fc_b=n(4 * d), mproj_w=n(4 * d, d), mproj_b=n(d))
                  for _ in range(n_layer)]
        params = dict(wte=n(vocab, d) * 5, wpe=n(n_ctx, d), lnf_g=np.ones(d, np.float32),
                      lnf_b=n(d), blocks=blocks)
        return cls(params, n_head, prefix_id=vocab - 1)

    def fingerprint(self) -> str:
        h = hashlib.sha256()
        h.update(self.p["wte"].tobytes()[:1 << 20])
        h.update(self.p["blocks"][0]["attn_w"].tobytes()[:1 << 20])
        return h.hexdigest()[:16]

    # -- forward pieces ---------------------------------------------------
    def _heads(self, x):  # [T, D] -> [H, T, dh]
        T = x.shape[0]
        return x.reshape(T, self.n_head, -1).transpose(1, 0, 2)

    def context(self, ids):
        """Full forward over ids (prefix included).

        Returns (kv, logits_last, units) where kv[l] = (K, V), each [H, T, dh],
        for layers 0..UNIT_LAYER-1, and units = hidden_states[6] for all positions.
        """
        p = self.p
        T = len(ids)
        x = p["wte"][ids] + p["wpe"][:T]
        mask = np.triu(np.full((T, T), -np.inf, np.float32), 1)
        kv, units = [], None
        for l, b in enumerate(p["blocks"]):
            a = _ln(x, b["ln1_g"], b["ln1_b"])
            qkv = a @ b["attn_w"] + b["attn_b"]
            q, k, v = np.split(qkv, 3, axis=-1)
            q, k, v = self._heads(q), self._heads(k), self._heads(v)
            if l < UNIT_LAYER:
                kv.append((k, v))
            att = _softmax(q @ k.transpose(0, 2, 1) / np.sqrt(q.shape[-1]) + mask)
            o = (att @ v).transpose(1, 0, 2).reshape(T, -1)
            x = x + o @ b["proj_w"] + b["proj_b"]
            m = _ln(x, b["ln2_g"], b["ln2_b"])
            x = x + _gelu(m @ b["fc_w"] + b["fc_b"]) @ b["mproj_w"] + b["mproj_b"]
            if l == UNIT_LAYER - 1:
                units = x.copy()
        h = _ln(x[-1], p["lnf_g"], p["lnf_b"])
        logits = h @ p["wte"].T
        return kv, logits, units

    def candidate_units(self, kv, pos, cand, chunk=2048):
        """Layer-6 unit of each candidate token placed at position `pos`,
        given the cached context of length pos. Returns [len(cand), D]."""
        p = self.p
        out = np.empty((len(cand), self.d), np.float32)
        H = self.n_head
        for s in range(0, len(cand), chunk):
            c = cand[s:s + chunk]
            B = len(c)
            x = p["wte"][c] + p["wpe"][pos]
            for l in range(UNIT_LAYER):
                b = p["blocks"][l]
                a = _ln(x, b["ln1_g"], b["ln1_b"])
                qkv = a @ b["attn_w"] + b["attn_b"]
                q, k, v = (t.reshape(B, H, -1) for t in np.split(qkv, 3, axis=-1))
                Kc, Vc = kv[l]                                   # [H, T, dh]
                scale = 1.0 / np.sqrt(q.shape[-1])
                s_ctx = np.einsum("bhd,htd->bht", q, Kc) * scale
                s_self = (q * k).sum(-1, keepdims=True) * scale  # [B, H, 1]
                att = _softmax(np.concatenate([s_ctx, s_self], -1))
                o = np.einsum("bht,htd->bhd", att[..., :-1], Vc) + att[..., -1:] * v
                x = x + o.reshape(B, -1) @ b["proj_w"] + b["proj_b"]
                m = _ln(x, b["ln2_g"], b["ln2_b"])
                x = x + _gelu(m @ b["fc_w"] + b["fc_b"]) @ b["mproj_w"] + b["mproj_b"]
            out[s:s + B] = x
        return out


# ------------------------------------------------------------- codebook ---
class Codebook:
    """Codewords compared by cosine after subtracting the corpus mean (RFC 1)."""

    def __init__(self, codewords, mean, paths=None):
        self.mean = mean.astype(np.float32)
        c = codewords.astype(np.float32) - self.mean
        self.c = c / np.linalg.norm(c, axis=1, keepdims=True)
        self.paths = paths  # list: codeword index -> tuple of grid points

    def __len__(self):
        return len(self.c)

    def nearest(self, units, chunk=512):
        u = units - self.mean
        u = u / np.linalg.norm(u, axis=1, keepdims=True)
        out = np.empty(len(u), np.int64)
        for s in range(0, len(u), chunk):
            out[s:s + chunk] = np.argmax(u[s:s + chunk] @ self.c.T, axis=1)  # ties: lower index
        return out

    def fingerprint(self) -> str:
        return hashlib.sha256(self.c.tobytes()[:1 << 22]).hexdigest()[:16]


# ------------------------------------------------------ per-position data ---
@dataclass
class Position:
    first_guess: int
    order: np.ndarray        # token ids, most likely first (ties: lower id)
    bucket: np.ndarray       # bucket[v] = codeword of token v placed here
    counts: np.ndarray       # counts[c] = how many tokens land in codeword c

    def listed(self, c):
        o = self.order
        return o[self.bucket[o] == c]


class Analyzer:
    """Computes, for a context, the reference model's ranking and the codeword
    every possible next token would land in. Optionally caches to disk."""

    def __init__(self, model: GPT2, codebook: Codebook, cache_dir: str | None = None):
        self.m, self.cb, self.cache_dir = model, codebook, cache_dir
        self.all_tokens = np.arange(model.vocab)
        self.tag = model.fingerprint() + codebook.fingerprint()
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)

    def at(self, ctx_ids) -> Position:
        key = None
        if self.cache_dir:
            key = hashlib.sha1((self.tag + ",".join(map(str, ctx_ids))).encode()).hexdigest()
            f = os.path.join(self.cache_dir, key + ".npz")
            if os.path.exists(f):
                z = np.load(f)
                return Position(int(z["g"]), z["order"], z["bucket"], z["counts"])
        kv, logits, _ = self.m.context(list(ctx_ids))
        order = np.argsort(-logits, kind="stable").astype(np.int32)
        units = self.m.candidate_units(kv, len(ctx_ids), self.all_tokens)
        bucket = self.cb.nearest(units).astype(np.int32)
        counts = np.bincount(bucket, minlength=len(self.cb)).astype(np.int32)
        pos = Position(int(order[0]), order, bucket, counts)
        if key:
            np.savez(os.path.join(self.cache_dir, key + ".npz"), g=pos.first_guess,
                     order=order, bucket=bucket, counts=counts)
        return pos


# ------------------------------------------------------------- writing ---
@dataclass
class Cell:
    kind: str                  # "phrase" or "quote"
    codeword: int = -1         # phrase: codeword index
    skips: int = 0             # phrase: skip marks
    tokens: list = field(default_factory=list)   # tokens covered


def write(tokens, an: Analyzer, force_quote=frozenset(), max_phrase=None, log=None):
    """Fewest-cell recoverable writing of `tokens` (one segment).

    Cost: a phrase is one cell; a quotation run costs its tokens plus two ticks.
    `force_quote` holds token positions that MUST be quoted (names, numbers).
    """
    n = len(tokens)
    prefix = [an.m.prefix_id]
    P = []
    for i in range(n):
        P.append(an.at(prefix + list(tokens[:i])))
        if log:
            log(i + 1, n)
    INF = 1 << 30
    A = [INF] * (n + 1)   # best cost ending after a phrase (or at start)
    Q = [INF] * (n + 1)   # best cost ending inside/after a quotation run
    A[0] = 0
    backA, backQ = [None] * (n + 1), [None] * (n + 1)
    for s in range(n):
        base = min(A[s], Q[s])
        if base >= INF:
            continue
        # quotation of token s
        for prev, cost in (("Q", Q[s] + 1), ("A", A[s] + 3)):
            if cost < Q[s + 1]:
                Q[s + 1], backQ[s + 1] = cost, (prev, s)
        # phrases s..e
        e = s
        while e < n and (max_phrase is None or e - s < max_phrase):
            if e in force_quote:
                break
            c = int(P[e].bucket[tokens[e]])
            skips = sum(int(P[j].counts[c]) for j in range(s, e))
            if skips <= MAX_SKIPS:
                L = P[e].listed(c)
                rank = int(np.nonzero(L == tokens[e])[0][0])
                skips += rank
                if skips <= MAX_SKIPS and base + 1 < A[e + 1]:
                    A[e + 1] = base + 1
                    backA[e + 1] = ("A" if A[s] <= Q[s] else "Q", s, c, skips)
            if tokens[e] != P[e].first_guess:
                break          # the reader could not continue past e
            e += 1
    # trace back
    cells, i, state = [], n, "A" if A[n] <= Q[n] else "Q"
    while i > 0:
        if state == "A":
            prev, s, c, k = backA[i]
            cells.append(Cell("phrase", c, k, list(tokens[s:i])))
        else:
            prev, s = backQ[i]
            if cells and cells[-1].kind == "quote":
                cells[-1].tokens[:0] = [tokens[s]]
            else:
                cells.append(Cell("quote", tokens=[tokens[s]]))
        i, state = s, prev
    cells.reverse()
    return cells


# ------------------------------------------------------------- reading ---
def read(cells, an: Analyzer, max_len=1023):
    """Recover tokens from cells. Quotations need no model."""
    out = []
    prefix = [an.m.prefix_id]
    for cell in cells:
        if cell.kind == "quote":
            out.extend(cell.tokens)
            continue
        r = cell.skips
        while True:
            if len(out) >= max_len:
                raise ValueError("segment overrun while reading a phrase")
            pos = an.at(prefix + out)
            L = pos.listed(cell.codeword)
            if r < len(L):
                out.append(int(L[r]))
                break
            r -= len(L)
            out.append(pos.first_guess)
    return out


def cell_count(cells):
    n = 0
    for c in cells:
        n += 1 if c.kind == "phrase" else len(c.tokens) + 2
    return n


def to_items(cells, codebook: Codebook):
    """Render items (see render.py): acknowledgment, cells, end of segment."""
    from .paths import all_paths
    from .render import ACK, END, RESERVED
    items = [ACK]
    for c in cells:
        if c.kind == "phrase":
            items.append(("path", tuple(codebook.paths[c.codeword]), {"faint": False, "skips": c.skips}))
        else:
            items.append(RESERVED)
            items += [("path", all_paths()[t], {"faint": False}) for t in c.tokens]
            items.append(RESERVED)
    items.append(END)
    return items
