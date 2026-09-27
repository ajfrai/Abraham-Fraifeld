# blink-ducp (starter)

Reference tools for written ducP, the script in the back half of *Blink*.

- `ducp/paths.py`: the 108,089 valid grid paths (RFC 5 §2). Run it to self-check the counts.
- `ducp/render.py`: glyph and page renderer (RFC 5 §5–6), with curved strokes, 18 pt, 16 × 22 per page.
- `examples/sample_pages.py`: placeholder pages and a glyph specimen sheet.

Start with `BUILD_BRIEF.md`.

Requires Python 3.10+ and `reportlab`.
