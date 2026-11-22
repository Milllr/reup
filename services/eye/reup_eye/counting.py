"""Counting: full or empty pockets, the settle rule, changed only posting, and blobs for open zones. Pure numpy."""
from __future__ import annotations

from typing import Hashable, Optional

import numpy as np


def _spread(diff: np.ndarray, flat_ndim: int) -> np.ndarray:
    """With colour samples (one more axis, of 3), the biggest difference of the three channels is the difference."""
    return diff.max(axis=-1) if diff.ndim > flat_ndim else diff


def gain(current_border: np.ndarray, reference_border: np.ndarray) -> float:
    """How much brighter the reference is than now, measured on bare board. Multiply the current frame by it."""
    if current_border.size < 8:
        return 1.0
    now = float(np.median(current_border))
    if now < 1.0:
        return 1.0
    return float(np.clip(float(np.median(reference_border)) / now, 0.4, 2.5))


def pocket_levels(current_cells: np.ndarray, reference_cells: np.ndarray, g: float = 1.0) -> np.ndarray:
    """Mean absolute difference from the empty board for each pocket. Shape (pockets,). Cells are (pockets, samples) or (pockets, samples, 3)."""
    return _spread(np.abs(current_cells * g - reference_cells), 2).mean(axis=1)


def changed(current: np.ndarray, reference: np.ndarray, g: float = 1.0, pixel: float = 26.0) -> np.ndarray:
    """Which sample points look different from the empty board. Samples are (n,) or (n, 3)."""
    return _spread(np.abs(current * g - reference), 1) > pixel


def other_surface(current: np.ndarray, reference: np.ndarray, hue: float = 0.06, darker: float = 0.35, brighter: float = 2.5) -> np.ndarray:
    """Which sample points show something else, not the same surface in other light. Samples are (n, 3).

    A shadow or a lamp makes wood darker or brighter and leaves its colour alone. A part has another colour, or is far
    darker or far brighter than any shadow or lamp makes wood. So a point counts when the share of each colour in it
    moved by more than hue, or when it is under darker times or over brighter times as bright as it was. A part of
    the very colour of the board, about as bright as the board, is not seen.
    """
    cur, ref = np.asarray(current, dtype=np.float64), np.asarray(reference, dtype=np.float64)
    cur_sum, ref_sum = cur.sum(axis=-1), ref.sum(axis=-1)
    ratio = (cur_sum + 3.0) / (ref_sum + 3.0)
    moved = np.abs(cur / (cur_sum[..., None] + 1e-6) - ref / (ref_sum[..., None] + 1e-6)).max(axis=-1)
    # In a point that is nearly black either way, the colour is noise.
    lit = (cur_sum > 36.0) & (ref_sum > 36.0)
    return (lit & (moved > hue)) | (ratio < darker) | (ratio > brighter)


def pockets_full(levels, threshold: float, previous: Optional[list[bool]] = None, hysteresis: float = 0.7) -> list[bool]:
    """A pocket is full over the threshold. One that was full stays full until it drops well under it, so it cannot flicker."""
    out = []
    for i, level in enumerate(levels):
        was = previous[i] if previous is not None and i < len(previous) else False
        out.append(bool(level > threshold * (hysteresis if was else 1.0)))
    return out


def motion_energy(current: np.ndarray, previous: np.ndarray, pixel: float = 10.0) -> float:
    """The share of sample points that changed by more than pixel grey levels since the last look."""
    if current.size == 0 or current.shape != previous.shape:
        return 0.0
    return float((_spread(np.abs(current - previous), 1) > pixel).mean())


class SettleFilter:
    """Counts are held while anything moves, and released after still_ms of stillness."""

    def __init__(self, still_ms: float = 500.0):
        self.still_s = still_ms / 1000.0
        self.last_motion: Optional[float] = None
        self.started: Optional[float] = None

    def update(self, moving: bool, now: float) -> bool:
        if self.started is None:
            self.started = now
        if moving:
            self.last_motion = now
        since = now - (self.last_motion if self.last_motion is not None else self.started)
        return since >= self.still_s


class ChangeGate:
    """Says when a value is worth posting: when it changed, or once every keepalive_s if it did not."""

    def __init__(self, keepalive_s: float = 30.0):
        self.keepalive_s = keepalive_s
        self.sent: dict[Hashable, tuple[object, float]] = {}

    def due(self, key: Hashable, value: object, now: float) -> bool:
        last = self.sent.get(key)
        return last is None or last[0] != value or now - last[1] >= self.keepalive_s

    def mark(self, key: Hashable, value: object, now: float) -> None:
        self.sent[key] = (value, now)

    def forget(self, key: Hashable) -> None:
        self.sent.pop(key, None)


class CountSmoother:
    """A count must be seen hold times in a row before it is believed."""

    def __init__(self, hold: int = 3):
        self.hold = hold
        self.runs: dict[Hashable, tuple[int, int]] = {}
        self.stable: dict[Hashable, int] = {}

    def update(self, key: Hashable, count: int) -> Optional[int]:
        value, seen = self.runs.get(key, (count, 0))
        seen = seen + 1 if value == count else 1
        self.runs[key] = (count, seen)
        if seen >= self.hold:
            self.stable[key] = count
        return self.stable.get(key)


def assign(centre, zones) -> Optional[str]:
    """The id of the zone that contains a point. zones is a list of (id, quad)."""
    from .geometry import point_in_quad

    for zone_id, quad in zones:
        if point_in_quad(centre, quad):
            return zone_id
    return None


def label_blobs(mask: np.ndarray, min_cells: int = 1) -> list[list[tuple[int, int]]]:
    """Groups of touching True cells (up, down, left, right) with at least min_cells cells. Biggest first."""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    blobs = []
    for r0, c0 in zip(*np.nonzero(mask)):
        if seen[r0, c0]:
            continue
        stack, cells = [(int(r0), int(c0))], []
        seen[r0, c0] = True
        while stack:
            r, c = stack.pop()
            cells.append((r, c))
            for rr, cc in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)):
                if 0 <= rr < h and 0 <= cc < w and mask[rr, cc] and not seen[rr, cc]:
                    seen[rr, cc] = True
                    stack.append((rr, cc))
        if len(cells) >= min_cells:
            blobs.append(cells)
    return sorted(blobs, key=len, reverse=True)


def blob_count(blobs: list[list[tuple[int, int]]], unit_cells: Optional[float], floor: float = 0.0) -> int:
    """Items in an open zone. With a known size for one item, a blob of touching items counts as that many,
    and a patch smaller than floor of one item is not an item."""
    if not unit_cells or unit_cells <= 0:
        return len(blobs)
    return sum(max(1, int(len(b) / unit_cells + 0.5)) for b in blobs if len(b) >= unit_cells * floor)
