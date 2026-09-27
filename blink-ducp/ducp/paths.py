"""Grid paths for written ducP (RFC 5, Section 2).

The grid has nine points numbered 1..9, left to right, top to bottom:

    1 2 3
    4 5 6
    7 8 9

A character is an ordered sequence of distinct points. A segment may not
pass over a point that has not yet been visited; it may pass over one that
has. Paths have 1 to 7 points, giving 108,089 characters in total.
"""

from functools import lru_cache

POINTS = tuple(range(1, 10))

# Position of each point: (column, row), each in {0, 1, 2}.
POS = {p: ((p - 1) % 3, (p - 1) // 3) for p in POINTS}

# The point lying exactly between two others, if any (e.g. 1-3 passes over 2).
_BETWEEN = {}
for a in POINTS:
    for b in POINTS:
        if a == b:
            continue
        (ax, ay), (bx, by) = POS[a], POS[b]
        if (ax + bx) % 2 == 0 and (ay + by) % 2 == 0:
            mid = ((ax + bx) // 2, (ay + by) // 2)
            _BETWEEN[(a, b)] = 1 + mid[0] + 3 * mid[1]

MAX_POINTS = 7
EXPECTED_COUNTS = {1: 9, 2: 56, 3: 320, 4: 1624, 5: 7152, 6: 26016, 7: 72912}
TOTAL = 108089


def can_move(frm, to, visited):
    """True if a segment from `frm` to `to` is valid given the visited set."""
    if to in visited:
        return False
    mid = _BETWEEN.get((frm, to))
    return mid is None or mid in visited


def is_valid(path):
    """Check a path against RFC 5, Section 2."""
    if not 1 <= len(path) <= MAX_POINTS:
        return False
    if any(p not in POS for p in path) or len(set(path)) != len(path):
        return False
    visited = {path[0]}
    for a, b in zip(path, path[1:]):
        if not can_move(a, b, visited):
            return False
        visited.add(b)
    return True


@lru_cache(maxsize=1)
def all_paths():
    """Every valid path, ordered by length, then lexicographically.

    This canonical order is used for placeholder content and indexing only.
    The assignment of paths to codewords is defined by RFC 5, Section 4.
    """
    out = []

    def extend(path, visited):
        out.append(tuple(path))
        if len(path) == MAX_POINTS:
            return
        for nxt in POINTS:
            if can_move(path[-1], nxt, visited):
                path.append(nxt)
                visited.add(nxt)
                extend(path, visited)
                visited.remove(nxt)
                path.pop()

    for start in POINTS:
        extend([start], {start})
    out.sort(key=lambda p: (len(p), p))
    return tuple(out)


def counts():
    c = {}
    for p in all_paths():
        c[len(p)] = c.get(len(p), 0) + 1
    return c


if __name__ == "__main__":
    c = counts()
    print(c, sum(c.values()))
    assert c == EXPECTED_COUNTS and sum(c.values()) == TOTAL
    print("OK: counts match RFC 5, Section 2.4")
