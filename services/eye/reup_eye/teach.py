"""The teach spot: notice a new item, wait for it to hold still, crop it once, and keep the JPEG small."""
from __future__ import annotations

from typing import Callable, Optional

import numpy as np

MAX_JPEG_BYTES = 400_000


def present(current: np.ndarray, reference: np.ndarray, g: float = 1.0, pixel: float = 26.0, share: float = 0.02) -> bool:
    """Something is on the spot when enough of it looks different from the empty spot."""
    if current.size == 0:
        return False
    from .counting import changed

    return float(changed(current, reference, g, pixel).mean()) > share


class TeachSpot:
    """One teach for each placement: the item must hold still for hold_s, and the spot must be empty for clear_s before the next."""

    def __init__(self, hold_s: float = 1.0, clear_s: float = 2.0):
        self.hold_s = hold_s
        self.clear_s = clear_s
        self.armed = False
        self.empty_since: Optional[float] = None
        self.still_since: Optional[float] = None

    def update(self, is_present: bool, moving: bool, now: float) -> bool:
        """Returns True at the moment a crop should be taken."""
        if not is_present:
            self.still_since = None
            if self.empty_since is None:
                self.empty_since = now
            if now - self.empty_since >= self.clear_s:
                self.armed = True
            return False
        self.empty_since = None
        if moving:
            self.still_since = None
            return False
        if self.still_since is None:
            self.still_since = now
        if self.armed and now - self.still_since >= self.hold_s:
            self.armed = False
            return True
        return False


def jpeg_under(frame: np.ndarray, encode: Callable[[np.ndarray, int], bytes], limit: int = MAX_JPEG_BYTES) -> bytes:
    """Encodes at falling quality, then at half size, until the JPEG is under the limit."""
    data = b""
    for _ in range(4):
        for quality in (88, 78, 68, 58, 48, 38, 28):
            data = encode(frame, quality)
            if len(data) <= limit:
                return data
        frame = frame[::2, ::2]
    return data


def crop_quad(frame: np.ndarray, quad, width: int = 640, height: int = 640) -> np.ndarray:
    """The inside of a quad as a flat picture, read straight from the full frame."""
    from .geometry import apply, unit_to_quad

    us = (np.arange(width) + 0.5) / width
    vs = (np.arange(height) + 0.5) / height
    uu, vv = np.meshgrid(us, vs)
    pts = apply(unit_to_quad(quad), np.c_[uu.ravel(), vv.ravel()])
    h, w = frame.shape[:2]
    x = np.clip(np.rint(pts[:, 0] * (w - 1)).astype(int), 0, w - 1)
    y = np.clip(np.rint(pts[:, 1] * (h - 1)).astype(int), 0, h - 1)
    return frame[y, x].reshape(height, width, *frame.shape[2:])


def view_size(frame_shape, quad, long_side: int = 640) -> tuple[int, int]:
    """Width and height of the picture of a quad: the quad's own shape in the frame, with its long side long_side."""
    h, w = frame_shape[:2]
    pts = np.asarray(quad, dtype=float) * [w, h]
    across = (np.linalg.norm(pts[1] - pts[0]) + np.linalg.norm(pts[2] - pts[3])) / 2
    down = (np.linalg.norm(pts[3] - pts[0]) + np.linalg.norm(pts[2] - pts[1])) / 2
    if not (across > 0 and down > 0):
        return long_side, long_side
    scale = long_side / max(across, down)
    return max(8, int(round(across * scale))), max(8, int(round(down * scale)))


def view_quad(frame: np.ndarray, quad, margin: float = 0.15, long_side: int = 640) -> np.ndarray:
    """The picture of a new part that a person and the namer look at: the quad and a margin of board around it.

    crop_quad stretched the spot to a square and stopped at its edges, so a part near an edge was cut and nothing
    around it was seen. This picture keeps the spot's own shape, reaches margin times its size past every edge, and
    is read between pixels so it is not blocky when the spot is small in the frame. Past the edge of the frame the
    last row or column repeats.
    """
    from .geometry import apply, unit_to_quad

    width, height = view_size(frame.shape, quad, long_side)
    span = 1.0 + 2.0 * margin
    us = (np.arange(width) + 0.5) / width * span - margin
    vs = (np.arange(height) + 0.5) / height * span - margin
    uu, vv = np.meshgrid(us, vs)
    pts = apply(unit_to_quad(quad), np.c_[uu.ravel(), vv.ravel()])
    h, w = frame.shape[:2]
    fx = np.clip(pts[:, 0] * (w - 1), 0, w - 1)
    fy = np.clip(pts[:, 1] * (h - 1), 0, h - 1)
    x0, y0 = np.floor(fx).astype(int), np.floor(fy).astype(int)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    ax, ay = fx - x0, fy - y0
    if frame.ndim == 3:
        ax, ay = ax[:, None], ay[:, None]
    grid = frame.astype(np.float32)
    top = grid[y0, x0] * (1 - ax) + grid[y0, x1] * ax
    bottom = grid[y1, x0] * (1 - ax) + grid[y1, x1] * ax
    out = top * (1 - ay) + bottom * ay
    return np.clip(np.rint(out), 0, 255).astype(frame.dtype).reshape(height, width, *frame.shape[2:])
