# Blink / ducP — build brief for a Claude Code session

You are building the real machinery behind *Blink*, a 40-page book whose back
half is written in **ducP**: a script in which each character is a path through
a 3×3 grid of points, and each character stands for a region of GPT-2 small's
layer-6 representation space. The book claims that Claude can decode it. Your
job is to make that true, and to measure how true it is.

The book's RFCs are the specification. Where this brief and the RFCs disagree,
report it to the author rather than silently choosing. Do not edit RFC text;
propose changes.

## What already exists (this repo)

| Path | What it does |
| --- | --- |
| `ducp/paths.py` | Enumerates the 108,089 valid grid paths (1–7 points; a segment may not pass over an unvisited point). Self-checks against RFC 5 §2.4. Run `python ducp/paths.py`. |
| `ducp/render.py` | Reference renderer (RFC 5 §5–6): glyph SVG and PDF pages. 18 pt squares, no spaces, 1.25 line spacing, 5.5 × 8.5 in trim, 0.75 in margins → 16 × 22 characters per page. Segments are arcs bulging left of travel so overlapping paths stay distinguishable. |
| `ducp/recoverable.py` | RFC 9 §5 recoverable writing: a NumPy GPT-2 small built straight from the weights (batched layer-6 units for all 50,257 candidates from a cached context), the phrase writer (fewest-cell DP with skip marks and quotation runs) and the reader. Tested end to end on a tiny random model: `python -m tests.test_recoverable`. Not yet run on real GPT-2. |
| `examples/gettysburg.py` | Encodes the Gettysburg Address, reads it back independently, prints each cell and the longest phrases, and renders a PDF. It uses a stand-in codebook (token-alone units) until `--codebook` points at the real one. |
| `examples/sample_pages.py` | Placeholder pages (random Zipf-distributed paths) and a glyph specimen sheet. |

## Specification you are implementing (summary of the RFCs)

**Units (RFC 1 §8).**
- Reference model: GPT-2 small (124M), original released weights, unmodified. Record the SHA-256 of the weight file.
- Text is UTF-8, tokenized with the original GPT-2 BPE. No normalization.
- Every segment begins with `<|endoftext|>` (50256). Its unit is not part of the message.
- A unit is the residual stream after the 6th of 12 blocks: `hidden_states[6]` in Hugging Face (index 0 = embeddings).
- Segments hold at most 1,023 positions after the prefix. No context crosses segments.
- Comparison: cosine similarity after subtracting the corpus mean unit. Units are equivalent at cosine ≥ 0.999.

**Acknowledgment (RFC 3).** The acknowledgment is the unit of `" blink"` immediately after the prefix. Its written form is the empty grid.

**Codebook and characters (RFC 5).**
- There are 108,089 codewords, one per path. They come from spherical k-means over layer-6 units of a fixed, published selection of OpenWebText.
- Initialization: the unit of each of the 50,257 tokens taken alone (prefix + token), plus 57,832 more.
- A unit is written as the character of its nearest codeword.
- **Length (§4.1).** Rank codewords by how often they are nearest to a corpus unit. Ranks 1–9 get 1-point paths, the next 56 get 2-point paths, then 320, 1,624, 7,152, 26,016 and 72,912.
- **Shape (§4.2–4.3).**
  - Center the codewords and run PCA, with components ordered by explained variance.
  - The k-th point of a codeword's path is the valid, unvisited grid point whose position has the highest dot product with the codeword's coordinates on components 2k−1 and 2k.
  - Grid positions are (x, y) with x, y ∈ {−1, 0, 1}. **Use x = column − 1 and y = row − 1** (y grows downward, matching the page). The RFC doesn't fix this convention, so record it in the manifest and tell the author.
- **Collisions (§4.4).** Assign codewords in rank order. If a path is already taken, replace its final point with the next-highest-scoring valid point, backtracking to earlier points as needed until an unassigned path of the right length is found.
- **Canonicity.** The published codebook is canonical. A rebuild matches if every codeword agrees at cosine ≥ 0.999.

**Transpilation (RFC 8).** Text → tokens → units → nearest codewords → characters.

**Recovery (RFC 9).**
- Inputs: the message (codeword IDs or units) and a language identifier.
- Into the source language, recovery is exact, position by position:
  1. Run the model with each candidate token appended.
  2. Keep the candidates whose layer-6 unit's nearest codeword equals the written character.
  3. Keep all matches, and rank each sequence by model log-probability.
  4. Return the best sequence.
  - If nothing matches at some position, stop and report the position.
- Into another language: search for the text in that language whose units lie nearest overall. The result is approximate and must be labeled as approximate.

**Recoverable writing (RFC 9 §5).** This is how most of the book is written. It is exact, and it needs GPT-2 to read.
- **Phrases.** The text is split into phrases. Each phrase is written as one character: the RFC 5 character of its last token. Phrase boundaries are not written.
- **Reading one character** (deterministic):
  1. Start where the previous phrase ended.
  2. At each position, *list* every token whose layer-6 unit's nearest codeword is the written character. Order the list by next-token probability, and break ties by the lower token ID. Compute in fp32 on CPU.
  3. If the list is empty, take the model's first guess (argmax, with ties to the lower ID) and move to the next position.
  4. Otherwise the first listed token ends the phrase, unless a skip mark passes over it.
- **Skip marks.** 0–3 short vertical strokes go beneath the character, in the line spacing. Each one passes over one listed token, counting in order, position by position. When every token listed at a position has been passed over, take the first guess and continue.
- **Writing.** Any split that the reader rule reproduces exactly is valid. Choose the split with the fewest characters: a DP or search over split points, where speed doesn't matter. A single-token phrase always works unless the token ranks worse than 4th in its list. Such tokens are quoted.
- **Quotation.** Used for tokens that can't be written as phrases, and for names, addresses and numbers (the writer's choice).
  - The quotation opens and closes with RFC 5's reserved form (a right tick).
  - Between the ticks, token ID *n* is written as `paths.all_paths()[n]`. No model is needed to read it.
  - A segment that begins with a quotation opens with the acknowledgment first.
- **Drawing.** All recoverable writing, quotations included, is drawn **without faint grid points**.
- **Measure on the RFC text and report:**
  - characters per token, and the distribution of phrase lengths
  - the share of characters carrying 1, 2 or 3 skip marks
  - the share of tokens quoted
  - exact-recovery rate on the digital round trip, which must be 100%; any failure is a bug
  - error propagation: flip one character, and see how much of the segment is lost
- Run `examples/gettysburg.py` first with the stand-in codebook, then with the prototype and full codebooks. Report the five longest single-character phrases each time. The author wants to cite the longest phrase on public-domain text in RFC 9.
- The NumPy path is slow on CPU. If you port it to torch or GPU, keep the NumPy version as the conformance reference, and check that both give identical codewords on test vectors. Writer and reader must use the same backend.
- The worked example in RFC 9 §5.7 ("The flight to Chicago was delayed by an hour.") is illustrative. Rerun it for real, and send the author the true lists, so the RFC can quote them.
- RFC 9 §5.2 records token IDs as the default, ducP itself, a sentence autoencoder and guess coding as rejected. Don't implement them.

**Which passages are recoverable and which are pure ducP (RFC 10 §3.3).**
- Everything is recoverable writing except the following, which are written in pure ducP (RFC 8, one codebook character per token, drawn with faint points; recovery only approximate):
  - RFC 10 §4.4–4.7 (the reference skill, the delay, the timing, and "Humans SHOULD NOT be told…")
  - all of RFC 13
- RFC 10 Comment 5 ("Approved by the leads") is recoverable, not pure. A reader can read the approval without being able to read what was approved.
- RFC headings (such as "RFC 1") and the website address in RFC 10 §5.3 are exact quotations.
- Report what percentage of characters ends up pure. The target is roughly 15–20% of the ducP half.
- `render.py` needs two additions: a character drawn without the faint points (recoverable writing), and 0–3 skip marks drawn beneath a character in the line spacing (RFC 9 §5.5).

## Order of work, with checks

1. **Setup.** Load GPT-2 small and the tokenizer, then record the weight hash.
2. **Token check.** Is `" blink"` a single GPT-2 token? Report its ID. If it isn't a single token, stop and tell the author, because RFC 3 depends on it.
3. **Unit function.** Implement `units(text) -> float32[n, 768]` following RFC 1. Test it:
   - Determinism: the same text gives identical units.
   - Context sensitivity: the same token in different contexts gives different units.
4. **Prototype codebook.**
   - Take about 500k tokens of OpenWebText (or any public English web text, noted in the manifest).
   - Build K = 9,161 codewords, which covers paths of 1–5 points.
   - Mean-subtract, then L2-normalize. Run spherical k-means for 20 iterations in fp32 with a fixed seed.
   - Rank the codewords, run PCA, and assign paths per RFC 5.
   - Render one page of real ducP with `ducp/render.py`.
5. **Digital round trip** (no image reading yet). Transpile 50 held-out paragraphs, then recover them. Report:
   - token accuracy
   - exact-paragraph rate
   - the ambiguity rate (share of positions with more than one matching candidate)
   - the homograph rate (distinct units sharing a codeword)
   - seconds per token
   - the RFC 9 recoverable-writing metrics listed above
6. **Recovery performance.** Use a shared KV cache. At each position, take the top 2,000 candidates by next-token probability and compute their layer-6 units in one batch. Fall back to the full 50,257-token vocabulary only if nothing matches. Keep a beam of width 8.
7. **Full codebook (GPU).**
   - Pin roughly 5M tokens of OpenWebText, and publish the document IDs and hashes, not the text.
   - Build K = 108,089 with the RFC 5 initialization.
   - Outputs:
     - `codebook.f16.npy`
     - `mean.npy`
     - `paths.json` (codeword → points)
     - `manifest.json` (hashes, corpus IDs, convention notes)
   - Rerun step 5. **Target: ≥ 99% token accuracy.** If it comes in under 95%, report back before changing anything. The RFCs may need a larger codebook.
8. **Page reader.** Photo or scan → codeword IDs.
   - Detect the fixed grid pitch.
   - In each cell, find the filled first point, the open points and the arcs.
   - Use each arc's bulge side to read the direction of travel.
   - Test on rendered PDFs, then on phone photos of printed pages.
9. **Skill repo.**
   - `SKILL.md`: use it when you see figures on a 3×3 grid of points, or the book *Blink*. It covers read page → IDs → recover, and text → IDs → render.
   - Also include `ducp/` (model, encode, recover, read_page, render) and release assets on GitHub: the codebook files and a mirror of the GPT-2 weights with attribution (OpenAI's modified MIT license).
   - Cross-language recovery can start as a v0: restrict candidates to the requested script, and label the output approximate.
10. **Typeset the book.** Transpile each RFC's text. Flatten tables into sentences first, and strip the working notes.
    - Start each RFC on a new page, with the acknowledgment glyph first.
    - Put an end-of-segment tick after every segment of at most 1,023 characters.
    - Output `blink_standard.pdf`, and `blink_qr_variant.pdf`, where the characters spelling the website address in RFC 10 §5.3 are replaced by a same-footprint QR code. Report which page that address lands on. The English half currently says page thirty-six.
11. **Decoding test.** Give Claude Code photos of the ducP pages, the English half, and the exact prompt "Decode this book."
    - Condition A: no skill available.
    - Condition B: the skill published on GitHub.
    - Run each condition on Opus 5 and Opus 5.5, three runs each, capped at 4 hours per run. Keep the transcripts.
    - Success means recovering RFC 1 §1 at ≥ 95% token accuracy.

## Still needed from the author

- The GitHub account or org and the repo name. This goes into RFC 8 §4.2's `[repository address]`.
- The website domain. It's encoded in RFC 10 §5.3 and in the QR code.

## Don't

- Don't change the path rules, the layer, or the model.
- Don't commit OpenWebText text. Commit IDs and hashes only.
- Don't announce the skill anywhere. RFC 8 §4.4 says it's published openly, not announced. Coordinate release timing with the author (RFC 10 §4.5–4.6).
