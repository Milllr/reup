"""Shapes on the board: quads, pocket cells, sample points and outlines. Pure numpy, no camera needed.

Every point is normalized: x and y run from 0 to 1 across the camera frame, as in the Zone contract.
"""
from __future__ import annotations

import numpy as np

UNIT = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))


def homography(src, dst) -> np.ndarray:
    """The 3 by 3 matrix that maps four src points onto four dst points."""
    a, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        a.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        b.append(u)
        a.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        b.append(v)
    h = np.linalg.solve(np.array(a, dtype=float), np.array(b, dtype=float))
    return np.append(h, 1.0).reshape(3, 3)


def unit_to_quad(quad) -> np.ndarray:
    """Maps the flat rectangle (0..1 by 0..1) onto a zone's quad. Corners go clockwise from the top left."""
    return homography(UNIT, quad)


def apply(h: np.ndarray, points) -> np.ndarray:
    pts = np.asarray(points, dtype=float).reshape(-1, 2)
    xyw = np.c_[pts, np.ones(len(pts))] @ h.T
    return xyw[:, :2] / xyw[:, 2:3]


def cell_rect(rows: int, cols: int, index: int) -> tuple[float, float, float, float]:
    """Pocket index to its rectangle in the flat zone. Pockets are numbered row by row from the top left."""
    r, c = divmod(index, cols)
    return c / cols, r / rows, (c + 1) / cols, (r + 1) / rows


def cell_corners(quad, rows: int, cols: int, index: int, inset: float = 0.0) -> np.ndarray:
    """The four corners of one pocket in the camera frame, clockwise from the top left."""
    u0, v0, u1, v1 = cell_rect(rows, cols, index)
    du, dv = (u1 - u0) * inset, (v1 - v0) * inset
    flat = [(u0 + du, v0 + dv), (u1 - du, v0 + dv), (u1 - du, v1 - dv), (u0 + du, v1 - dv)]
    return apply(unit_to_quad(quad), flat)


def cell_samples(quad, rows: int, cols: int, n: int = 12, inset: float = 0.18) -> np.ndarray:
    """n by n sample points inside every pocket, away from its walls. Shape: (rows * cols, n * n, 2)."""
    h = unit_to_quad(quad)
    steps = (np.arange(n) + 0.5) / n
    out = []
    for index in range(rows * cols):
        u0, v0, u1, v1 = cell_rect(rows, cols, index)
        us = u0 + (u1 - u0) * (inset + (1 - 2 * inset) * steps)
        vs = v0 + (v1 - v0) * (inset + (1 - 2 * inset) * steps)
        uu, vv = np.meshgrid(us, vs)
        out.append(apply(h, np.c_[uu.ravel(), vv.ravel()]))
    return np.array(out)


def grid_samples(quad, n: int) -> np.ndarray:
    """An n by n grid of points across a whole quad, row by row. Shape: (n * n, 2)."""
    steps = (np.arange(n) + 0.5) / n
    uu, vv = np.meshgrid(steps, steps)
    return apply(unit_to_quad(quad), np.c_[uu.ravel(), vv.ravel()])


def point_in_quad(point, quad) -> bool:
    """True when the point is inside a convex quad, whichever way its corners wind."""
    x, y = point
    signs = []
    for i in range(4):
        x1, y1 = quad[i]
        x2, y2 = quad[(i + 1) % 4]
        signs.append((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1))
    return all(s >= 0 for s in signs) or all(s <= 0 for s in signs)


def expand(quad, factor: float) -> list[list[float]]:
    """The quad scaled about its centre. 1.1 is 10 percent bigger."""
    q = np.asarray(quad, dtype=float)
    c = q.mean(axis=0)
    return (c + (q - c) * factor).tolist()


def border_samples(board_quad, zone_quads, n: int = 28, margin: float = 1.12) -> np.ndarray:
    """Points on bare board: inside the board, outside every zone. They show how bright the room is."""
    pts = grid_samples(board_quad, n)
    grown = [expand(q, margin) for q in zone_quads]
    keep = [p for p in pts if not any(point_in_quad(p, q) for q in grown)]
    return np.array(keep, dtype=float).reshape(-1, 2)


def _rdp(points: list, eps: float) -> list:
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = (dx * dx + dy * dy) ** 0.5 or 1e-12
    best, where = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        d = abs(dy * (px - x1) - dx * (py - y1)) / norm
        if d > best:
            best, where = d, i
    if best <= eps:
        return [points[0], points[-1]]
    return _rdp(points[: where + 1], eps)[:-1] + _rdp(points[where:], eps)


def simplify(points, max_points: int = 24) -> list[list[float]]:
    """A closed outline with at most max_points corners, keeping its shape."""
    pts = [[float(x), float(y)] for x, y in points]
    if len(pts) <= max_points:
        return pts
    # A closed outline has no first and last point to draw a line between, so it is cut at the point furthest from the start.
    far = max(range(len(pts)), key=lambda i: (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2)
    eps = 0.0005
    for _ in range(40):
        out = _rdp(pts[: far + 1], eps)[:-1] + _rdp(pts[far:] + [pts[0]], eps)[:-1]
        if len(out) <= max_points:
            return out
        eps *= 1.6
    step = len(pts) / max_points
    return [pts[int(i * step)] for i in range(max_points)]


def hull(points) -> list[list[float]]:
    """The convex outline of a set of points, counter clockwise (Andrew's monotone chain)."""
    pts = sorted({(float(x), float(y)) for x, y in points})
    if len(pts) < 3:
        return [list(p) for p in pts]

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower: list = []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    upper: list = []
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return [list(p) for p in lower[:-1] + upper[:-1]]


def bounds(points) -> tuple[float, float, float, float]:
    """The box around an outline: x0, y0, x1, y1."""
    xs, ys = [float(p[0]) for p in points], [float(p[1]) for p in points]
    return min(xs), min(ys), max(xs), max(ys)


def overlap(a, b) -> float:
    """How much of the smaller of two outlines' boxes lies inside the other, from 0 to 1."""
    ax0, ay0, ax1, ay1 = bounds(a)
    bx0, by0, bx1, by1 = bounds(b)
    w, h = min(ax1, bx1) - max(ax0, bx0), min(ay1, by1) - max(ay0, by0)
    if w <= 0 or h <= 0:
        return 0.0
    least = min((ax1 - ax0) * (ay1 - ay0), (bx1 - bx0) * (by1 - by0))
    return float(w * h / least) if least > 0 else 0.0
