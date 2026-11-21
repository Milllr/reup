"""A drawn board for the tests: flat colour, boxes in pockets, no camera and no OpenCV."""
import json
from pathlib import Path

import numpy as np

from reup_eye.app import Eye
from reup_eye.config import load
from reup_eye.frames import ReferenceStore
from reup_eye.geometry import cell_corners

MOCKS = Path(__file__).resolve().parents[3] / "contracts" / "mocks"
W, H = 640, 360


def snapshot() -> dict:
    return json.loads((MOCKS / "snapshot.json").read_text(encoding="utf-8"))


def fill(img, corners, value) -> None:
    xs = np.clip((np.asarray(corners)[:, 0] * W).astype(int), 0, W - 1)
    ys = np.clip((np.asarray(corners)[:, 1] * H).astype(int), 0, H - 1)
    img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] = value


def board(full: dict[str, list[int]] | None = None, brightness: float = 1.0, extra=None) -> np.ndarray:
    """A BGR frame of the mock board. full maps a pocket zone id to the pocket indexes that hold a box."""
    img = np.full((H, W, 3), 150, dtype=np.float32)
    zones = {z["id"]: z for z in snapshot()["zones"]}
    for zone_id, indexes in (full or {}).items():
        z = zones[zone_id]
        for index in indexes:
            fill(img, cell_corners(z["quad"], z["rows"], z["cols"], index, 0.1), 60)
    for corners, value in extra or []:
        fill(img, corners, value)
    return np.clip(img * brightness, 0, 255).astype(np.uint8)


class FakeHub:
    def __init__(self):
        self.posts = []
        self.teaches = []
        self.ok = True
        self.last_error = None

    def counts(self, counts, cameras=None):
        if not self.ok:
            self.last_error = "down"
            return False
        self.posts.append({"counts": counts, "cameras": cameras})
        return True

    def teach(self, jpeg, zone_id):
        self.teaches.append((jpeg, zone_id))
        return {"id": f"t-{len(self.teaches)}"}


def eye(tmp_path, config_text: str = "", with_reference: bool = True):
    config = load(text=config_text)
    hub = FakeHub()
    logs: list[str] = []
    e = Eye(config, hub, ReferenceStore(tmp_path), lambda frame, quality: bytes(1000), tmp_path, logs.append, wall=lambda: "2026-11-21T09:14:03-05:00")
    e.set_zones(snapshot())
    if with_reference:
        e.analyse("board", board(), 0.0)
        assert e.capture_reference("board")
    return e, hub, logs


def still(e, frame, start: float, seconds: float = 1.0, camera: str = "board") -> float:
    """Shows the same frame ten times a second. Returns the time after the last one."""
    t = start
    for _ in range(int(seconds * 10)):
        t += 0.1
        e.analyse(camera, frame, t)
    return t
