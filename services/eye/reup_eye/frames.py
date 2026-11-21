"""Frames: the small grey picture the counting works on, sampling it, camera health, and the saved empty board."""
from __future__ import annotations

import time
from collections import deque
from pathlib import Path
from typing import Callable, Optional

import numpy as np


# The runtime sets this to an OpenCV resize, which is much faster on 1080p. The numpy version below gives the same picture.
FAST_SHRINK: Optional[Callable[[np.ndarray, int], np.ndarray]] = None


def small_colour(frame: np.ndarray, factor: int = 4) -> np.ndarray:
    """A BGR frame averaged down by factor. The averaging is the blur. float32, 0 to 255, shape (h, w, 3).

    Colour is kept on purpose: a red box on brown wood can be exactly as bright as the wood.
    """
    if frame.ndim == 2:
        frame = np.repeat(frame[..., None], 3, axis=2)
    if FAST_SHRINK is not None:
        return FAST_SHRINK(frame, factor)
    h, w = frame.shape[0] // factor, frame.shape[1] // factor
    sums = frame[: h * factor, : w * factor, :3].reshape(h, factor, w, factor, 3).sum(axis=(1, 3), dtype=np.uint32)
    return (sums / float(factor * factor)).astype(np.float32)


def sample(img: np.ndarray, points: np.ndarray) -> np.ndarray:
    """Values at normalized points, read between pixels. Keeps the shape of points without its last axis, plus the colour axis if img has one."""
    h, w = img.shape[:2]
    x = np.clip(points[..., 0] * (w - 1), 0, w - 1)
    y = np.clip(points[..., 1] * (h - 1), 0, h - 1)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    x1, y1 = np.minimum(x0 + 1, w - 1), np.minimum(y0 + 1, h - 1)
    fx, fy = x - x0, y - y0
    if img.ndim == 3:
        fx, fy = fx[..., None], fy[..., None]
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bottom = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bottom * fy


class FpsMeter:
    """Frames a second over the last window seconds."""

    def __init__(self, window: float = 2.0):
        self.window = window
        self.ticks: deque[float] = deque()

    def tick(self, now: float) -> None:
        self.ticks.append(now)
        self._trim(now)

    def _trim(self, now: float) -> None:
        while self.ticks and now - self.ticks[0] > self.window:
            self.ticks.popleft()

    def fps(self, now: float) -> float:
        self._trim(now)
        return round(len(self.ticks) / self.window, 1)


class FrameSource:
    """One camera. Opens it, reads it, and when it goes away keeps trying to open it again.

    opener(index) returns something with read() -> (ok, frame) and release(), or None when the camera will not open.
    Call step() in a loop. Nothing here needs OpenCV, so a test can pass a fake opener.
    """

    def __init__(self, camera_id: str, indexes: list[int], opener: Callable[[int], Optional[object]], clock: Callable[[], float] = time.monotonic, retry_s: float = 1.0, stale_s: float = 1.5):
        self.id = camera_id
        self.indexes = indexes
        self.opener = opener
        self.clock = clock
        self.retry_s = retry_s
        self.stale_s = stale_s
        self.capture: Optional[object] = None
        self.frame: Optional[np.ndarray] = None
        self.seq = 0
        self.last_frame_at: Optional[float] = None
        self.next_try = 0.0
        self.meter = FpsMeter()
        self.opened_index: Optional[int] = None

    def _open(self, now: float) -> None:
        if now < self.next_try:
            return
        for index in self.indexes:
            capture = self.opener(index)
            if capture is not None:
                self.capture, self.opened_index = capture, index
                return
        self.next_try = now + self.retry_s

    def _drop(self, now: float) -> None:
        try:
            if self.capture is not None:
                self.capture.release()
        finally:
            self.capture = None
            self.next_try = now + self.retry_s

    def step(self) -> bool:
        """Reads one frame. Returns True when a new frame arrived."""
        now = self.clock()
        if self.capture is None:
            self._open(now)
            if self.capture is None:
                return False
        try:
            ok, frame = self.capture.read()
        except Exception:
            ok, frame = False, None
        if not ok or frame is None:
            # A camera that stops answering is released and opened again, which is what brings back an unplugged one.
            if self.last_frame_at is None or now - self.last_frame_at > self.stale_s:
                self._drop(now)
            return False
        self.frame = frame
        self.seq += 1
        self.last_frame_at = now
        self.meter.tick(now)
        return True

    @property
    def online(self) -> bool:
        return self.last_frame_at is not None and self.clock() - self.last_frame_at <= self.stale_s

    def fps(self) -> float:
        return self.meter.fps(self.clock()) if self.online else 0.0


class ReferenceStore:
    """The empty board, one small grey picture per camera, kept on disk so it survives a restart."""

    def __init__(self, folder: Path):
        self.folder = Path(folder)

    def path(self, camera_id: str) -> Path:
        return self.folder / f"reference-{camera_id}.npy"

    def save(self, camera_id: str, img: np.ndarray) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        np.save(self.path(camera_id), img.astype(np.float32))

    def load(self, camera_id: str) -> Optional[np.ndarray]:
        try:
            return np.load(self.path(camera_id))
        except (OSError, ValueError):
            return None
