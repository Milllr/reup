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
