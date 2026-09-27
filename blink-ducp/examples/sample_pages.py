"""Render sample ducP pages with placeholder content.

The codebook does not exist yet, so these pages use placeholder characters:
ranks drawn from a Zipf distribution and mapped to paths in canonical order,
so that short characters are common and long ones rare, as RFC 5 specifies.
The layout, glyph forms and reserved forms are real.
"""
import random, sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from reportlab.pdfgen import canvas
from reportlab.lib.colors import black
from ducp.paths import all_paths
from ducp.render import ACK, END, RESERVED, PAGE, render_pdf, _draw_glyph, PAGE_W, PAGE_H

PATHS = all_paths()
rng = random.Random(26)
weights = [1 / (r + 3) ** 1.07 for r in range(len(PATHS))]

def segment(n):
    return [("path", p) for p in rng.choices(PATHS, weights=weights, k=n)]

items = []
for doc_len in (540, 380):            # two short "documents", each opening a new page
    items += [ACK] + segment(doc_len // 2) + [END] + segment(doc_len // 2) + [END, PAGE]
pages, cols, rows = render_pdf(items, "sample_pages.pdf", first_page_number=13)
print(f"{pages} pages, {cols} x {rows} characters per page")

# Specimen sheet: reserved forms and the overlap case the curved strokes resolve.
c = canvas.Canvas("glyph_specimens.pdf", pagesize=(PAGE_W, PAGE_H))
specimens = [
    ("Acknowledgment (empty grid)", ACK),
    ("End of segment", END),
    ("Reserved", RESERVED),
    ("Path 5", ("path", (5,))),
    ("Path 1-2-3", ("path", (1, 2, 3))),
    ("Path 2-1-3", ("path", (2, 1, 3))),
    ("Path 2-3-1", ("path", (2, 3, 1))),
    ("Path 7-5-3-6-9-8-4", ("path", (7, 5, 3, 6, 9, 8, 4))),
]
s = 72
for i, (label, item) in enumerate(specimens):
    col, row = i % 2, i // 2
    x, y = 60 + col * 170, PAGE_H - 70 - row * 130
    _draw_glyph(c, item, x, y, s)
    c.setFont("Helvetica", 9); c.setFillColor(black)
    c.drawString(x, y - s - 14, label)
c.save()
