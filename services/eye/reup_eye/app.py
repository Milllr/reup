"""The eye itself: what it knows, one analysis step for one frame, and what it posts. No threads and no OpenCV in here."""
from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import numpy as np

from . import contracts as C
from .counting import ChangeGate, CountSmoother, SettleFilter, assign, blob_count, changed, gain, label_blobs, motion_energy, pocket_levels, pockets_full
from .frames import ReferenceStore, sample, small_colour
from .geometry import border_samples, cell_corners, cell_samples, grid_samples, hull, simplify
from .teach import TeachSpot, crop_quad, jpeg_under


@dataclass
class Layout:
    """Where to look in one camera's small picture. Rebuilt when the zones or the reference change."""

    key: str
    motion: np.ndarray
    border: np.ndarray
    ref_border: np.ndarray
    cells: dict[str, np.ndarray] = field(default_factory=dict)
    ref_cells: dict[str, np.ndarray] = field(default_factory=dict)
    grids: dict[str, np.ndarray] = field(default_factory=dict)
    ref_grids: dict[str, np.ndarray] = field(default_factory=dict)


class Eye:
    def __init__(self, config, hub, references: ReferenceStore, encode: Callable[[np.ndarray, int], bytes], data_dir: Path, log: Callable[[str], None] = print, wall: Callable[[], str] = C.now_iso):
        self.config = config
        self.hub = hub
        self.refs = references
        self.encode = encode
        self.data_dir = Path(data_dir)
        self.log = log
        self.wall = wall
        self.lock = threading.RLock()
        self.zones: list[dict] = []
        self.references: dict[str, Optional[np.ndarray]] = {cam: references.load(cam) for cam in config.cameras}
        self.small: dict[str, np.ndarray] = {}
        self.layouts: dict[str, Layout] = {}
        self.prev_motion: dict[str, np.ndarray] = {}
        self.settle = {cam: SettleFilter(config.settle.still_ms) for cam in config.cameras}
        self.settled: dict[str, bool] = {}
        self.counts: dict[str, tuple[int, Optional[tuple[bool, ...]]]] = {}
        self.levels: dict[str, list[float]] = {}
        self.gate = ChangeGate(config.settle.keepalive_s)
        self.smoother = CountSmoother(config.open.hold)
        self.outlines: dict[str, list[dict]] = {cam: [] for cam in config.cameras}
        self.detected: dict[str, list[dict]] = {}
        self.yolo_zones: set[str] = set()
        self.teach_spot = TeachSpot(config.teach.hold_s, config.teach.clear_s)
        self.pending_teach: Optional[dict] = None
        self.on_teach: Callable[[np.ndarray, str, tuple[float, float, float, float]], None] = self._post_teach
        self.on_prompts_changed: Callable[[], None] = lambda: None
        self.notes: dict[str, str] = {}

    # ---------- zones ----------

    def set_zones(self, snapshot: dict) -> None:
        """Takes the zones from a hub snapshot. A zone that fails its contract is skipped, never guessed at."""
        zones = []
        for raw in snapshot.get("zones", []):
            try:
                zones.append(C.Zone.model_validate(raw).model_dump())
            except Exception as err:  # noqa: BLE001
                self.log(f"Skipped a zone the contract does not accept: {err}")
        with self.lock:
            before = {z["id"]: z.get("productId") for z in self.zones}
            self.zones = zones
            for zone in zones:
                # A zone that changed hands starts its count again.
                if zone["id"] in before and before[zone["id"]] != zone["productId"]:
                    self.counts.pop(zone["id"], None)
                    self.gate.forget(zone["id"])
                    self.smoother.runs.pop(zone["id"], None)
                    self.smoother.stable.pop(zone["id"], None)
            self._adopt_teach(zones)

    def zones_for(self, camera_id: str) -> list[dict]:
        return [z for z in self.zones if z["camera"] == camera_id]

    def teach_zone(self) -> dict:
        """The teach spot: the hub's zone with that id when it has one, else the quad in config."""
        for zone in self.zones:
            if zone["id"] == self.config.teach.zone:
                return zone
        return {"id": None, "camera": self.config.teach.camera, "quad": self.config.teach.quad, "kind": "open", "productId": None, "rows": None, "cols": None, "name": "Teach spot"}

    # ---------- the empty board ----------

    def capture_reference(self, camera_id: str) -> bool:
        with self.lock:
            small = self.small.get(camera_id)
            if small is None:
                return False
            self.references[camera_id] = small.copy()
            self.refs.save(camera_id, small)
            self.layouts.pop(camera_id, None)
            self.log(f"Saved the empty board for the {camera_id} camera.")
            return True

    def _layout(self, camera_id: str, shape: tuple[int, int]) -> Optional[Layout]:
        ref = self.references.get(camera_id)
        if ref is None or ref.shape != tuple(shape):
            return None
        zones = self.zones_for(camera_id)
        teach = self.teach_zone()
        if teach["id"] is None and teach["camera"] == camera_id:
            zones = zones + [teach]
        key = json.dumps([[z["id"], z["quad"], z["rows"], z["cols"], z["kind"]] for z in zones]) + str(id(ref))
        have = self.layouts.get(camera_id)
        if have is not None and have.key == key:
            return have
        cam = self.config.cameras[camera_id]
        border = border_samples(cam.board, [z["quad"] for z in zones])
        layout = Layout(key=key, motion=grid_samples(cam.board, 48), border=border, ref_border=sample(ref, border) if len(border) else np.zeros(0))
        for zone in zones:
            zid = zone["id"] or "teach"
            try:
                if zone["kind"] == "pockets" and zone["rows"] and zone["cols"]:
                    layout.cells[zid] = cell_samples(zone["quad"], zone["rows"], zone["cols"], self.config.pockets.samples, self.config.pockets.inset)
                    layout.ref_cells[zid] = sample(ref, layout.cells[zid])
                else:
                    layout.grids[zid] = grid_samples(zone["quad"], self.config.open.grid)
                    layout.ref_grids[zid] = sample(ref, layout.grids[zid])
            except np.linalg.LinAlgError:
                self.log(f"Zone {zid} has a quad that is not a real four sided shape. It is not counted.")
        self.layouts[camera_id] = layout
        return layout

    # ---------- one frame ----------

    def analyse(self, camera_id: str, frame: np.ndarray, now: float) -> None:
        """Looks at one frame from one camera and updates the counts. now is seconds on a steady clock."""
        small = small_colour(frame, self.config.eye.small_factor)
        with self.lock:
            self.small[camera_id] = small
            cam = self.config.cameras[camera_id]
            motion_now = sample(small, grid_samples(cam.board, 48)) if camera_id not in self.layouts else sample(small, self.layouts[camera_id].motion)
            prev = self.prev_motion.get(camera_id)
            moving = prev is not None and motion_energy(motion_now, prev, self.config.settle.motion_pixel) > self.config.settle.motion_limit
            self.prev_motion[camera_id] = motion_now
            settled = self.settle[camera_id].update(moving, now)
            self.settled[camera_id] = settled
            layout = self._layout(camera_id, small.shape)
            if layout is None:
                self.notes[camera_id] = "No empty board saved yet. Clear the board and POST /reference/" + camera_id
                self.outlines[camera_id] = []
                return
            self.notes.pop(camera_id, None)
            g = gain(sample(small, layout.border), layout.ref_border) if len(layout.border) else 1.0
            items: list[dict] = []
            teach = self.teach_zone()
            for zone in self.zones_for(camera_id):
                zid = zone["id"]
                if zid in layout.cells:
                    levels = pocket_levels(sample(small, layout.cells[zid]), layout.ref_cells[zid], g)
                    self.levels[zid] = [round(float(v), 1) for v in levels]
                    previous = self.counts.get(zid, (0, None))[1]
                    full = pockets_full(levels, self.config.pockets.threshold, list(previous) if previous else None)
                    if settled:
                        self.counts[zid] = (sum(full), tuple(full))
                    shown = self.counts.get(zid, (0, tuple(full)))[1] or ()
                    for index, is_full in enumerate(shown):
                        if is_full:
                            items.append({"productId": zone["productId"], "points": cell_corners(zone["quad"], zone["rows"], zone["cols"], index, 0.08).round(4).tolist()})
                elif zid in layout.grids:
                    blobs, mask = self._blobs(small, layout, zid, g)
                    if zid == teach["id"] and zone["productId"] is None:
                        self._teach_step(frame, zone, mask, moving, now)
                        continue
                    if zid in self.yolo_zones:
                        continue
                    if settled and zone["productId"]:
                        stable = self.smoother.update(zid, blob_count(blobs, None))
                        if stable is not None:
                            self.counts[zid] = (stable, None)
                    for blob in blobs:
                        items.append({"productId": zone["productId"], "points": self._blob_outline(layout.grids[zid], blob)})
            if teach["id"] is None and teach["camera"] == camera_id and "teach" in layout.grids:
                _blobs, mask = self._blobs(small, layout, "teach", g)
                self._teach_step(frame, teach, mask, moving, now)
            items.extend(self.detected.get(camera_id, []))
            self.outlines[camera_id] = items

    def _blobs(self, small: np.ndarray, layout: Layout, zid: str, g: float):
        n = self.config.open.grid
        mask = changed(sample(small, layout.grids[zid]), layout.ref_grids[zid], g, self.config.open.blob_pixel).reshape(n, n)
        return label_blobs(mask, max(2, int(self.config.open.min_area * n * n))), mask

    def _blob_outline(self, grid: np.ndarray, blob: list[tuple[int, int]]) -> list[list[float]]:
        n = self.config.open.grid
        points = [grid[r * n + c] for r, c in blob]
        return [[round(x, 4), round(y, 4)] for x, y in simplify(hull(points), 24)]

    # ---------- teaching ----------

    def _teach_step(self, frame: np.ndarray, zone: dict, mask: np.ndarray, moving: bool, now: float) -> None:
        is_present = float(mask.mean()) > self.config.teach.share
        if not self.teach_spot.update(is_present, moving, now):
            return
        rows, cols = np.nonzero(mask)
        n = mask.shape[0]
        box = (max(0.0, cols.min() / n - 0.03), max(0.0, rows.min() / n - 0.03), min(1.0, (cols.max() + 1) / n + 0.03), min(1.0, (rows.max() + 1) / n + 0.03))
        self.on_teach(crop_quad(frame, zone["quad"]), zone["id"], box)

    def _post_teach(self, crop: np.ndarray, zone_id: Optional[str], box) -> None:
        jpeg = jpeg_under(crop, self.encode)
        result = self.hub.teach(jpeg, zone_id)
        if result is None:
            self.log(f"Could not tell the hub about the new part: {self.hub.last_error}")
            return
        self.pending_teach = {"id": result.get("id"), "crop": crop, "box": box, "zone": zone_id}
        self.log(f"A new part is on the teach spot. Sent a {len(jpeg) // 1000} kB picture to the hub.")

    def _adopt_teach(self, zones: list[dict]) -> None:
        """Once the taught part has a product, its picture becomes that product's example for the detector."""
        pending = self.pending_teach
        if not pending:
            return
        zone = next((z for z in zones if z["id"] == pending["zone"]), None)
        if zone and zone["productId"]:
            self.save_prompt(zone["productId"], pending["crop"], pending["box"])
            self.pending_teach = None

    def prompt_dir(self) -> Path:
        return self.data_dir / "prompts"

    def save_prompt(self, product_id: str, crop: np.ndarray, box) -> None:
        folder = self.prompt_dir()
        folder.mkdir(parents=True, exist_ok=True)
        np.save(folder / f"{product_id}.npy", crop)
        (folder / f"{product_id}.json").write_text(json.dumps({"box": [round(float(v), 4) for v in box]}), encoding="utf-8")
        self.log(f"Saved the example picture for {product_id}.")
        self.on_prompts_changed()

    def prompts(self) -> list[tuple[str, np.ndarray, tuple[float, float, float, float]]]:
        """Saved examples for products that still own an open zone."""
        out = []
        wanted = {z["productId"] for z in self.zones if z["kind"] != "pockets" and z["productId"]}
        for product_id in sorted(wanted):
            try:
                crop = np.load(self.prompt_dir() / f"{product_id}.npy")
                box = json.loads((self.prompt_dir() / f"{product_id}.json").read_text(encoding="utf-8"))["box"]
                out.append((product_id, crop, tuple(box)))
            except (OSError, ValueError, KeyError):
                continue
        return out

    # ---------- the detector's results ----------

    def take_detections(self, camera_id: str, instances: list[dict]) -> None:
        """Counts instances by the zone that holds their centre. Called from the detector thread."""
        with self.lock:
            zones = [z for z in self.zones_for(camera_id) if z["id"] in self.yolo_zones]
            lookup = [(z["id"], z["quad"]) for z in zones]
            product = {z["id"]: z["productId"] for z in zones}
            per_zone = {z["id"]: 0 for z in zones}
            shown = []
            for inst in instances:
                zid = assign(inst["centre"], lookup)
                if zid is None or product[zid] != inst["productId"]:
                    continue
                per_zone[zid] += 1
                shown.append({"productId": inst["productId"], "points": [[round(x, 4), round(y, 4)] for x, y in simplify(inst["points"], 24)]})
            for zid, n in per_zone.items():
                stable = self.smoother.update(zid, n)
                if stable is not None:
                    self.counts[zid] = (stable, None)
            self.detected[camera_id] = shown

    # ---------- posting ----------

    def due_counts(self, now: float) -> list[dict]:
        """Counts worth posting now: changed, or due a keepalive. Validated against the contract before they leave."""
        out = []
        with self.lock:
            for zone in self.zones:
                state = self.counts.get(zone["id"])
                if state is None or not zone["productId"]:
                    continue
                if not self.gate.due(zone["id"], state, now):
                    continue
                count, pockets = state
                out.append({"productId": zone["productId"], "zoneId": zone["id"], "count": int(count), "level": None, "pockets": list(pockets) if pockets is not None else None, "source": "eye", "ts": self.wall()})
        return out

    def flush(self, now: float, cameras: Optional[list[dict]] = None) -> bool:
        """Posts what is due. Returns True when something was sent and accepted."""
        counts = self.due_counts(now)
        if not counts and not cameras:
            return False
        body = C.IngestCountsBody.model_validate({"counts": counts, **({"cameras": cameras} if cameras else {})})
        if not self.hub.counts([c.model_dump(mode="json") for c in body.counts], [c.model_dump() for c in body.cameras] if body.cameras else None):
            return False
        with self.lock:
            for c in counts:
                self.gate.mark(c["zoneId"], self.counts.get(c["zoneId"]), now)
        return True

    def health(self) -> dict:
        with self.lock:
            return {
                "zones": len(self.zones),
                "reference": {cam: self.references.get(cam) is not None for cam in self.config.cameras},
                "settled": dict(self.settled),
                "counts": {zid: state[0] for zid, state in self.counts.items()},
                "levels": dict(self.levels),
                "notes": dict(self.notes),
                "detector": "yoloe" if self.yolo_zones else "blobs",
                "now": time.time(),
            }
