"""Reference renderer for written ducP (RFC 5, Sections 5 and 6).

A message is a list of items:
    ("path", (p1, p2, ...))   a character, as a grid path (see paths.py)
    ("path", (p1, ...), opts) opts: {"faint": False} draws no faint points
                               (recoverable writing, RFC 9 Section 5.9);
                               {"skips": n} draws n skip marks beneath (5.5)
    ACK                        the acknowledgment: an empty grid (RFC 3)
    END                        end of segment: a tick to the left of the grid
    RESERVED                   reserved form: a tick to the right of the grid
    PAGE                       start a new page (layout instruction, not ducP)

Glyph geometry is defined on a unit square with y pointing down. Each
segment is drawn as a slight arc that bulges to the left of its direction of
travel, so the order of a path can be read from its shape even where
segments overlap (RFC 5, Section 6.1).
"""

from reportlab.lib.colors import Color, black, white
from reportlab.pdfgen import canvas

from .paths import POS, is_valid

ACK, END, RESERVED, PAGE = "ACK", "END", "RESERVED", "PAGE"

# --- glyph geometry (unit square, y down) ---------------------------------
GRID = (1 / 6, 1 / 2, 5 / 6)
R_POINT = 0.08        # first point (filled) and other path points (open)
R_FAINT = 0.03        # points not on the path
STROKE = 0.05         # segment width
RING = 0.02           # outline width of open points
BULGE = 0.25          # arc offset as a fraction of segment length
FAINT = Color(0.7, 0.7, 0.7)  # 30% ink
SKIP_Y = (1.03, 1.15)  # skip marks sit in the line spacing below the square
SKIP_X = {1: (0.5,), 2: (0.42, 0.58), 3: (0.34, 0.5, 0.66)}


def _opts(item):
    if isinstance(item, tuple) and len(item) > 2:
        return item[2]
    return {}

# --- page layout (RFC 5, Section 6; points = 1/72 in) ----------------------
PAGE_W, PAGE_H = 5.5 * 72, 8.5 * 72
MARGIN = 0.75 * 72
SIZE = 18.0           # default character size, RFC 5 Section 6.2
LEADING = 1.25        # line spacing, RFC 5 Section 6.3


def xy(point):
    c, r = POS[point]
    return GRID[c], GRID[r]


def arc(a, b):
    """Quadratic arc from point a to point b, bulging left of travel.

    Returns (start, control, end) in unit coordinates, y down. With y down,
    the left-hand normal of direction (dx, dy) is (dy, -dx).
    """
    (x0, y0), (x1, y1) = xy(a), xy(b)
    dx, dy = x1 - x0, y1 - y0
    length = (dx * dx + dy * dy) ** 0.5
    nx, ny = dy / length, -dx / length
    mx, my = (x0 + x1) / 2, (y0 + y1) / 2
    off = BULGE * length
    return (x0, y0), (mx + nx * off, my + ny * off), (x1, y1)


# --- SVG (for the website and previews) -----------------------------------
def glyph_svg(item, size=48, ink="#111", faint="#b3b3b3", paper="#fff"):
    s = size
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{s}" height="{s}" '
             f'viewBox="0 0 1 1" overflow="visible">']
    path = item[1] if isinstance(item, tuple) else ()
    opts = _opts(item)
    on = set(path)
    for p in POS:
        if p not in on and opts.get("faint", True):
            x, y = xy(p)
            parts.append(f'<circle cx="{x:.4f}" cy="{y:.4f}" r="{R_FAINT}" fill="{faint}"/>')
    for a, b in zip(path, path[1:]):
        (x0, y0), (cx, cy), (x1, y1) = arc(a, b)
        parts.append(f'<path d="M{x0:.4f},{y0:.4f} Q{cx:.4f},{cy:.4f} {x1:.4f},{y1:.4f}" '
                     f'fill="none" stroke="{ink}" stroke-width="{STROKE}" stroke-linecap="round"/>')
    for i, p in enumerate(path):
        x, y = xy(p)
        if i == 0:
            parts.append(f'<circle cx="{x:.4f}" cy="{y:.4f}" r="{R_POINT}" fill="{ink}"/>')
        else:
            parts.append(f'<circle cx="{x:.4f}" cy="{y:.4f}" r="{R_POINT - RING / 2}" '
                         f'fill="{paper}" stroke="{ink}" stroke-width="{RING}"/>')
    if item in (END, RESERVED):
        x = 0.03 if item == END else 0.97
        parts.append(f'<line x1="{x}" y1="0.35" x2="{x}" y2="0.65" stroke="{ink}" '
                     f'stroke-width="{STROKE}" stroke-linecap="round"/>')
    for x in SKIP_X.get(opts.get("skips", 0), ()):
        parts.append(f'<line x1="{x}" y1="{SKIP_Y[0]}" x2="{x}" y2="{SKIP_Y[1]}" stroke="{ink}" '
                     f'stroke-width="{STROKE}" stroke-linecap="round"/>')
    parts.append("</svg>")
    return "".join(parts)


# --- PDF -------------------------------------------------------------------
def _draw_glyph(c, item, ox, oy, s):
    """Draw one glyph with its top-left corner at (ox, oy) in PDF space."""
    def P(u, v):  # unit coords (y down) -> PDF coords (y up)
        return ox + u * s, oy - v * s

    path = item[1] if isinstance(item, tuple) else ()
    opts = _opts(item)
    on = set(path)
    c.setFillColor(FAINT)
    for p in POS:
        if p not in on and opts.get("faint", True):
            c.circle(*P(*xy(p)), R_FAINT * s, stroke=0, fill=1)
    c.setStrokeColor(black)
    c.setLineWidth(STROKE * s)
    c.setLineCap(1)
    for a, b in zip(path, path[1:]):
        p0, q, p1 = arc(a, b)
        c1 = (p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1]))
        c2 = (p1[0] + 2 / 3 * (q[0] - p1[0]), p1[1] + 2 / 3 * (q[1] - p1[1]))
        pa = c.beginPath()
        pa.moveTo(*P(*p0))
        pa.curveTo(*P(*c1), *P(*c2), *P(*p1))
        c.drawPath(pa, stroke=1, fill=0)
    for i, p in enumerate(path):
        x, y = P(*xy(p))
        if i == 0:
            c.setFillColor(black)
            c.circle(x, y, R_POINT * s, stroke=0, fill=1)
        else:
            c.setFillColor(white)
            c.setLineWidth(RING * s)
            c.circle(x, y, (R_POINT - RING / 2) * s, stroke=1, fill=1)
    if item in (END, RESERVED):
        u = 0.03 if item == END else 0.97
        c.setLineWidth(STROKE * s)
        c.line(*P(u, 0.35), *P(u, 0.65))
    for u in SKIP_X.get(opts.get("skips", 0), ()):
        c.setStrokeColor(black)
        c.setLineWidth(STROKE * s)
        c.line(*P(u, SKIP_Y[0]), *P(u, SKIP_Y[1]))


def layout(items, size=SIZE):
    """Assign items to (page, row, col). Returns pages as lists of (item, row, col)."""
    cols = int((PAGE_W - 2 * MARGIN) // size)
    rows = int((PAGE_H - 2 * MARGIN) // (size * LEADING))
    pages, cur, i = [], [], 0
    for item in items:
        if item == PAGE:
            if cur:
                pages.append(cur)
            cur, i = [], 0
            continue
        if i == cols * rows:
            pages.append(cur)
            cur, i = [], 0
        cur.append((item, i // cols, i % cols))
        i += 1
    if cur:
        pages.append(cur)
    return pages, cols, rows


def render_pdf(items, out_path, size=SIZE, first_page_number=None):
    for item in items:
        if isinstance(item, tuple) and not is_valid(item[1]):
            raise ValueError(f"invalid path: {item[1]}")
    pages, cols, rows = layout(items, size)
    c = canvas.Canvas(out_path, pagesize=(PAGE_W, PAGE_H))
    grid_w = cols * size
    left = (PAGE_W - grid_w) / 2
    top = PAGE_H - MARGIN
    for n, page in enumerate(pages):
        for item, r, col in page:
            _draw_glyph(c, item, left + col * size, top - r * size * LEADING, size)
        if first_page_number is not None:
            c.setFont("Times-Roman", 9)
            c.setFillColor(black)
            c.drawCentredString(PAGE_W / 2, MARGIN / 2, str(first_page_number + n))
        c.showPage()
    c.save()
    return len(pages), cols, rows
