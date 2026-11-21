"""A drawn board for development: no cameras needed. Never the demo. Start it with: python -m reup_eye --sim

It draws the zones the hub knows, with a box in every full pocket, and a hand that reaches in when a box is taken.
Control it with: POST /sim/take?zone=z-screws&n=2   /sim/put?zone=z-screws&n=2   /sim/teach?on=1   /sim/dim?to=0.67
"""
from __future__ import annotations

import threading
import time
from typing import Optional

import numpy as np

from .geometry import cell_corners

W, H = 1280, 720
WOOD = np.array([96, 142, 178], dtype=np.float32)  # BGR
COLOURS = [(40, 60, 200), (190, 120, 30), (60, 170, 70), (30, 30, 30), (160, 60, 150)]


class SimBoard:
    def __init__(self, eye, fps: int = 20):
        self.eye = eye
        self.fps = fps
        self.lock = threading.Lock()
        self.full: dict[str, list[bool]] = {}
        self.items: dict[str, int] = {}
        self.teach_item = False
        self.brightness = 1.0
        self.hand: Optional[tuple[float, str]] = None
        self.pending: list[tuple[float, str, int]] = []
        rng = np.random.default_rng(7)
        grain = rng.normal(0, 3.0, (H, W, 1)).astype(np.float32) + np.linspace(-6, 6, W, dtype=np.float32)[None, :, None]
        self.wood = np.clip(WOOD + grain, 0, 255)

    def seed(self, snapshot: dict) -> None:
        """Starts with what the hub thinks is on the board, so the picture and the numbers agree."""
        with self.lock:
            for zone in snapshot.get("zones", []):
                count = next((c["count"] for c in snapshot.get("counts", []) if c["zoneId"] == zone["id"]), 0)
                if zone["kind"] == "pockets" and zone["rows"] and zone["cols"]:
                    total = zone["rows"] * zone["cols"]
                    self.full.setdefault(zone["id"], [i < count for i in range(total)])
                elif zone["productId"]:
                    self.items.setdefault(zone["id"], count)

    def command(self, name: str, query: dict) -> dict:
        zone, n = query.get("zone", ""), int(query.get("n", "1"))
        with self.lock:
            if name in ("take", "put"):
                # The hand comes in first. The boxes change while it is over the board.
                self.hand = (time.monotonic() + 0.9, zone)
                self.pending.append((time.monotonic() + 0.45, zone, -n if name == "take" else n))
            elif name == "teach":
                self.teach_item = query.get("on", "1") != "0"
            elif name == "dim":
                self.brightness = float(query.get("to", "1"))
            elif name == "set":
                self._change(zone, n, absolute=True)
            return {"full": {k: sum(v) for k, v in self.full.items()}, "items": dict(self.items), "teach": self.teach_item}

    def _change(self, zone: str, n: int, absolute: bool = False) -> None:
        if zone in self.full:
            cells = self.full[zone]
            target = max(0, min(len(cells), n if absolute else sum(cells) + n))
            self.full[zone] = [i < target for i in range(len(cells))]
        else:
            self.items[zone] = max(0, n if absolute else self.items.get(zone, 0) + n)

    def _fill(self, img: np.ndarray, corners, colour) -> None:
        xs = np.clip((np.asarray(corners)[:, 0] * W).astype(int), 0, W - 1)
        ys = np.clip((np.asarray(corners)[:, 1] * H).astype(int), 0, H - 1)
        img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] = colour

    def render(self, camera_id: str, empty: bool = False) -> np.ndarray:
        now = time.monotonic()
        with self.lock:
            for due in [p for p in self.pending if p[0] <= now]:
                self._change(due[1], due[2])
                self.pending.remove(due)
            img = self.wood.copy()
            zones = self.eye.zones_for(camera_id)
            for k, zone in enumerate(zones):
                self._fill(img, zone["quad"], np.clip(WOOD * 0.9, 0, 255))
                if empty:
                    continue
                colour = COLOURS[k % len(COLOURS)]
                if zone["id"] in self.full:
                    for index, is_full in enumerate(self.full[zone["id"]]):
                        if is_full:
                            self._fill(img, cell_corners(zone["quad"], zone["rows"], zone["cols"], index, 0.14), colour)
                elif zone["id"] == self.eye.config.teach.zone:
                    if self.teach_item:
                        self._fill(img, cell_corners(zone["quad"], 1, 1, 0, 0.3), COLOURS[4])
                else:
                    for i in range(min(self.items.get(zone["id"], 0), 8)):
                        self._fill(img, cell_corners(zone["quad"], 2, 4, i, 0.2), colour)
            if not empty and self.hand is not None:
                until, zone_id = self.hand
                zone = next((z for z in zones if z["id"] == zone_id), None)
                if now < until and zone is not None:
                    q = np.asarray(zone["quad"])
                    cx, cy = q.mean(axis=0)
                    t = 1 - abs((until - now) / 0.9 * 2 - 1)  # in, then out again
                    x0 = int((cx - 0.05) * W)
                    y1 = int((1 - t * (1 - cy)) * H)
                    img[max(0, y1) : H, max(0, x0) : x0 + int(0.1 * W)] = (150, 170, 215)
                elif now >= until:
                    self.hand = None
            return np.clip(img * (1.0 if empty else self.brightness), 0, 255).astype(np.uint8)


class SimCamera:
    """Looks like an OpenCV capture: read() gives (True, frame) at a steady rate."""

    def __init__(self, board: SimBoard, camera_id: str):
        self.board = board
        self.camera_id = camera_id
        self.next = time.monotonic()

    def read(self):
        delay = self.next - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        self.next = max(self.next, time.monotonic() - 1) + 1 / self.board.fps
        return True, self.board.render(self.camera_id)

    def release(self) -> None:
        return
