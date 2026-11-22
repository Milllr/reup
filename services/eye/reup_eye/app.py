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
from .config import FULL
from .counting import ChangeGate, CountSmoother, SettleFilter, assign, blob_count, changed, gain, label_blobs, motion_energy, other_surface, pocket_levels, pockets_full
from .frames import ReferenceStore, block_mean, sample, small_colour
from .geometry import apply, border_samples, cell_corners, cell_samples, grid_samples, hull, simplify, unit_to_quad
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
        self.motion: dict[str, float] = {}
        self.settle = {cam: SettleFilter(config.settle.still_ms) for cam in config.cameras}
        self.settled: dict[str, bool] = {}
        self.still: dict[str, bool] = {}
        self.counts: dict[str, tuple[int, Optional[tuple[bool, ...]]]] = {}
        self.levels: dict[str, list[float]] = {}
        self.gate = ChangeGate(config.settle.keepalive_s)
        self.smoother = CountSmoother(config.open.hold)
        self.outlines: dict[str, list[dict]] = {cam: [] for cam in config.cameras}
        self.detected: dict[str, list[dict]] = {}
        # Zones the detector counts. The runtime turns detector_on when a detector is meant to run. From then on a zone
        # whose part has an example is the detector's, even while the detector is still loading: the difference blobs
        # must never count it in the meantime, or a full ledge reads as empty for the first seconds after a start.
        self.detector_on = False
        self.yolo_zones: set[str] = set()
        self.teach_spot = TeachSpot(config.teach.hold_s, config.teach.clear_s)
        # What the empty teach spot looks like. The eye learns it by itself and keeps it up to date, so the spot needs
        # no saved empty board and a change in the light is not mistaken for a part.
        self.teach_key: Optional[str] = None
        self.teach_points: Optional[np.ndarray] = None
        self.teach_base: Optional[np.ndarray] = None
        self.teach_before: Optional[np.ndarray] = None  # the empty spot as it was before something was left on it
        self.teach_still_since: Optional[float] = None
        self.teach_present_since: Optional[float] = None
        self.teach_seen = {"differs": 0.0, "patch": 0.0}  # for the health page: how much of the spot differs, and its largest patch
        self.pending_teach: Optional[dict] = None
        self.on_teach: Callable[..., None] = self._post_teach
        self.on_prompts_changed: Callable[[], None] = lambda: None
        self.notes: dict[str, str] = {}
        self.capacity: dict[str, int] = {}
        # Set by the runtime's camera alignment. While a camera is held nothing it sees is a count: the board is hidden,
        # or something just moved and the eye has not yet checked that the camera is where it should be.
        self.pose_check = False
        self.unverified: set[str] = set()
        self.hidden: dict[str, str] = {}
        self.units: dict[str, dict] = self._load_units()

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
            self.capacity = {p["zoneId"]: int(p["capacity"]) for p in snapshot.get("products", []) if p.get("zoneId") and p.get("capacity")}
            for zone in zones:
                # A zone that changed hands starts its count again.
                if zone["id"] in before and before[zone["id"]] != zone["productId"]:
                    self.counts.pop(zone["id"], None)
                    self.gate.forget(zone["id"])
                    self.smoother.runs.pop(zone["id"], None)
                    self.smoother.stable.pop(zone["id"], None)
            self._adopt_teach(zones, snapshot.get("teach"))
            self.refresh_detector_zones()

    def refresh_detector_zones(self) -> None:
        """Works out again which zones are the detector's: open zones whose part has a saved example."""
        with self.lock:
            if not self.detector_on:
                return
            have = {z["productId"] for z in self.zones if z["kind"] != "pockets" and z["productId"] and (self.prompt_dir() / f"{z['productId']}.json").exists()}
            self.yolo_zones = {z["id"] for z in self.zones if z["kind"] != "pockets" and z["productId"] in have}

    def set_detector(self, on: bool) -> None:
        """Called by the runtime: a detector is meant to run, or it is not there and the difference blobs count instead."""
        with self.lock:
            self.detector_on = on
            if on:
                self.refresh_detector_zones()
            else:
                self.yolo_zones = set()
                self.detected = {}

    def pose_verified(self, camera_id: str) -> None:
        """The runtime looked after the last motion and the camera is where it should be."""
        with self.lock:
            self.unverified.discard(camera_id)

    def set_hidden(self, camera_id: str, reason: Optional[str]) -> None:
        with self.lock:
            if reason:
                self.hidden[camera_id] = reason
            else:
                self.hidden.pop(camera_id, None)

    def zones_for(self, camera_id: str) -> list[dict]:
        return [z for z in self.zones if z["camera"] == camera_id]

    def teach_zone(self) -> dict:
        """The teach spot: the hub's zone with that id when it has one, else the quad in config."""
        for zone in self.zones:
            if zone["id"] == self.config.teach.zone:
                return zone
        return {"id": None, "camera": self.config.teach.camera, "quad": self.config.teach.quad, "kind": "open", "productId": None, "rows": None, "cols": None, "name": "Teach spot"}

    def board_quad(self, camera_id: str) -> list:
        """Where motion is watched and the room's brightness is read: the board, not what is beside it.

        config.toml can name the board's corners. When it does not, it is a box around this camera's zones with a
        little wood to spare, so a laptop screen or a person beside the board never holds the counts.
        """
        cam = self.config.cameras[camera_id]
        if cam.board != FULL:
            return cam.board
        quads = [z["quad"] for z in self.zones_for(camera_id)]
        teach = self.teach_zone()
        if teach["id"] is None and teach["camera"] == camera_id:
            quads.append(teach["quad"])
        if not quads:
            return cam.board
        xs, ys = [p[0] for q in quads for p in q], [p[1] for q in quads for p in q]
        pad = self.config.eye.board_pad
        x0, x1, y0, y1 = max(0.0, min(xs) - pad), min(1.0, max(xs) + pad), max(0.0, min(ys) - pad), min(1.0, max(ys) + pad)
        return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]

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

    # ---------- the full board ----------

    def units_path(self) -> Path:
        return self.data_dir / "units.json"

    def _load_units(self) -> dict[str, dict]:
        try:
            raw = json.loads(self.units_path().read_text(encoding="utf-8"))
            return {zid: {"productId": u["productId"], "cells": float(u["cells"])} for zid, u in raw.items() if float(u["cells"]) > 0}
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return {}

    def unit_cells(self, zone: dict) -> Optional[float]:
        """The size of one unit in this open zone, once the full board was saved for the part that is in it now."""
        unit = self.units.get(zone["id"])
        return unit["cells"] if unit and unit["productId"] == zone["productId"] else None

    def capture_full(self, camera_id: str, counts: Optional[dict[str, int]] = None) -> Optional[dict]:
        """The board is full now: learns how big one unit looks in every open zone of this camera.

        Parts that stand side by side on a ledge touch, and touching parts are one patch of difference. Knowing the size
        of one unit turns that patch back into a count. A zone holds its part's capacity unless counts says otherwise.
        Returns None when there is no frame or no empty board to compare with.
        """
        with self.lock:
            small = self.small.get(camera_id)
            layout = self._layout(camera_id, small.shape) if small is not None else None
            if layout is None:
                return None
            g = gain(sample(small, layout.border), layout.ref_border) if len(layout.border) else 1.0
            learned, skipped = {}, {}
            for zone in self.zones_for(camera_id):
                zid = zone["id"]
                if zid not in layout.grids or not zone["productId"]:
                    continue
                units = (counts or {}).get(zid) or self.capacity.get(zid)
                if not units:
                    skipped[zid] = "No capacity for this part, so the eye cannot tell how many a full zone holds."
                    continue
                blobs, _mask = self._blobs(small, layout, zid, g)
                cells = sum(len(b) for b in blobs)
                if cells == 0:
                    skipped[zid] = "Nothing is in this zone."
                    continue
                self.units[zid] = {"productId": zone["productId"], "cells": round(cells / units, 2)}
                learned[zid] = {"units": int(units), "cells": cells}
            if learned:
                self.data_dir.mkdir(parents=True, exist_ok=True)
                self.units_path().write_text(json.dumps(self.units, indent=2), encoding="utf-8")
                self.log("Saved the full board for the " + camera_id + " camera: " + ", ".join(f"{zid} holds {v['units']}" for zid, v in learned.items()) + ".")
            return {"zones": learned, "skipped": skipped}

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
        board = self.board_quad(camera_id)
        border = border_samples(board, [z["quad"] for z in zones])
        layout = Layout(key=key, motion=grid_samples(board, 48), border=border, ref_border=sample(ref, border) if len(border) else np.zeros(0))
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
            # Motion is read from a coarser picture: in a dim room single pixels flicker by more than a hand's worth.
            coarse = block_mean(small, self.config.settle.motion_block)
            motion_now = sample(coarse, grid_samples(self.board_quad(camera_id), 48)) if camera_id not in self.layouts else sample(coarse, self.layouts[camera_id].motion)
            prev = self.prev_motion.get(camera_id)
            share = motion_energy(motion_now, prev, self.config.settle.motion_pixel) if prev is not None else 0.0
            self.motion[camera_id] = round(share, 4)
            moving = share > self.config.settle.motion_limit
            self.prev_motion[camera_id] = motion_now
            if moving and self.pose_check:
                self.unverified.add(camera_id)
            still = self.settle[camera_id].update(moving, now)
            self.still[camera_id] = still
            settled = still and camera_id not in self.unverified and camera_id not in self.hidden
            self.settled[camera_id] = settled
            teach = self.teach_zone()
            if teach["camera"] == camera_id and teach["productId"] is None:
                busy = moving or camera_id in self.unverified or camera_id in self.hidden
                self._teach_watch(frame, small, teach, busy, now)
            layout = self._layout(camera_id, small.shape)
            if layout is None:
                # Parts the detector counts need no empty board, and the teach spot learns its own. Pockets and difference blobs do.
                needs = [z for z in self.zones_for(camera_id) if z["productId"] and z["id"] not in self.yolo_zones]
                if needs:
                    self.notes[camera_id] = "No empty board saved yet. Clear the board and POST /reference/" + camera_id
                else:
                    self.notes.pop(camera_id, None)
                self.outlines[camera_id] = list(self.detected.get(camera_id, []))
                return
            self.notes.pop(camera_id, None)
            g = gain(sample(small, layout.border), layout.ref_border) if len(layout.border) else 1.0
            items: list[dict] = []
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
                    if zid in self.yolo_zones and zone["productId"]:
                        continue  # the detector counts this one, so the difference from the empty board is not worked out
                    if not zone["productId"]:
                        continue  # the teach spot while it is free: _teach_watch looks after it
                    blobs, mask = self._blobs(small, layout, zid, g)
                    unit, floor = self.unit_cells(zone), self.config.open.unit_floor
                    if settled and zone["productId"]:
                        stable = self.smoother.update(zid, blob_count(blobs, unit, floor))
                        if stable is not None:
                            self.counts[zid] = (stable, None)
                    for blob in blobs:
                        if unit and len(blob) < unit * floor:
                            continue
                        items.append({"productId": zone["productId"], "points": self._blob_outline(layout.grids[zid], blob)})
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

    def _teach_watch(self, frame: np.ndarray, small: np.ndarray, zone: dict, moving: bool, now: float) -> None:
        """Looks at the free teach spot: is something new on it?

        The first second of stillness is taken as the empty spot. After that the empty picture follows slow changes,
        and a part is one connected patch of another surface: another colour, or far darker or brighter than a shadow
        or a lamp makes the wood (see other_surface). A patch that stays for rebase_s with no part announced is not a
        new part: something was there from the start, or was left behind, and the empty picture is taken again.
        """
        n = self.config.open.grid
        key = json.dumps(zone["quad"])
        if key != self.teach_key:
            self.teach_key, self.teach_base, self.teach_before, self.teach_still_since, self.teach_present_since = key, None, None, None, None
            try:
                self.teach_points = grid_samples(zone["quad"], n)
            except np.linalg.LinAlgError:
                self.teach_points = None
        if self.teach_points is None:
            return
        now_look = sample(small, self.teach_points)
        if self.teach_base is None:
            self.teach_still_since = None if moving else (self.teach_still_since if self.teach_still_since is not None else now)
            if self.teach_still_since is not None and now - self.teach_still_since >= 1.0:
                self.teach_base = now_look.copy()
            self._teach_step(frame, zone, None, moving, now)
            return
        # A part, not a shadow: points whose colour changed, or that are far darker or brighter than light alone makes them.
        blobs = self._teach_blobs(now_look, self.teach_base, note=True)
        if blobs and not moving and self.teach_before is not None and not self._teach_blobs(now_look, self.teach_before):
            # What had been left on the spot was taken away: the spot looks the way it did before. That is not a part.
            self.teach_base, self.teach_before, blobs = now_look.copy(), None, []
            self.log("What was left on the teach spot was taken away. The spot is empty again.")
        if not blobs:
            self.teach_present_since = None
            if not moving:
                self.teach_base += 0.08 * (now_look - self.teach_base)
        else:
            self.teach_present_since = self.teach_present_since if self.teach_present_since is not None else now
            if self.pending_teach is None and not moving and now - self.teach_present_since >= self.config.teach.rebase_s:
                self.teach_before = self.teach_base
                self.teach_base = now_look.copy()
                self.teach_present_since = None
                blobs = []
                self.log(f"The teach spot looked different for {self.config.teach.rebase_s:.0f} seconds with no new part put down. Its empty picture was taken again.")
        self._teach_step(frame, zone, blobs[0] if blobs else None, moving, now)

    def _teach_blobs(self, look: np.ndarray, empty: np.ndarray, note: bool = False) -> list:
        """Connected patches of another surface than the empty spot, each over teach.share of the spot, largest first."""
        n = self.config.open.grid
        mask = other_surface(look, empty, self.config.teach.hue, self.config.teach.darker, self.config.teach.brighter).reshape(n, n)
        blobs = sorted(label_blobs(mask, max(2, int(self.config.teach.share * n * n))), key=len, reverse=True)
        if note:
            self.teach_seen = {"differs": round(float(mask.mean()), 4), "patch": round(len(blobs[0]) / (n * n), 4) if blobs else 0.0}
        return blobs

    def _teach_step(self, frame: np.ndarray, zone: dict, blob: Optional[list], moving: bool, now: float) -> None:
        """blob is the cells of the part on the spot, or None when the spot is empty."""
        is_present = blob is not None
        fire = self.teach_spot.update(is_present, moving, now)
        pending = self.pending_teach
        if pending is not None and not is_present and self.teach_spot.armed:
            # The part was lifted off again before anyone named it: the card comes down, and the next part starts fresh.
            self.pending_teach = None
            if pending.get("id"):
                self.hub.cancel_teach(pending["id"])
            self.log("The new part was taken off the teach spot before it was named.")
        if not fire or blob is None:
            return
        n = self.config.open.grid
        rows, cols = [r for r, _c in blob], [c for _r, c in blob]
        inside = (max(0.0, min(cols) / n - 0.03), max(0.0, min(rows) / n - 0.03), min(1.0, (max(cols) + 1) / n + 0.03), min(1.0, (max(rows) + 1) / n + 0.03))
        # The part's box on the whole frame: the detector learns a part from the frame it was seen in.
        corners = apply(unit_to_quad(zone["quad"]), np.array([[inside[0], inside[1]], [inside[2], inside[1]], [inside[2], inside[3]], [inside[0], inside[3]]]))
        box = (float(corners[:, 0].min()), float(corners[:, 1].min()), float(corners[:, 0].max()), float(corners[:, 1].max()))
        self.on_teach(crop_quad(frame, zone["quad"]), zone["id"], box, frame)

    def _post_teach(self, crop: np.ndarray, zone_id: Optional[str], box, frame: np.ndarray) -> None:
        jpeg = jpeg_under(crop, self.encode)
        result = self.hub.teach(jpeg, zone_id)
        if result is None:
            self.log(f"Could not tell the hub about the new part: {self.hub.last_error}")
            return
        self.pending_teach = {"id": result.get("id"), "frame": frame.copy(), "box": box, "zone": zone_id}
        self.log(f"A new part is on the teach spot. Sent a {len(jpeg) // 1000} kB picture to the hub.")

    def _adopt_teach(self, zones: list[dict], card: Optional[dict] = None) -> None:
        """Once the taught part has a product, the frame it was seen in becomes that product's example for the detector.

        card is the hub's new part card, or None when it shows none. A card the hub took down (nobody named the part,
        or someone said it is not a part) is let go here too, so whatever is still on the spot stops counting as new.
        """
        pending = self.pending_teach
        if not pending:
            return
        zone = next((z for z in zones if z["id"] == pending["zone"]), None)
        if zone and zone["productId"]:
            self.save_prompt(zone["productId"], pending["frame"], [pending["box"]])
            self.pending_teach = None
            return
        if pending.get("id") and (card or {}).get("id") != pending["id"]:
            # Two snapshots in a row without the card: one alone may have been read just before the card went up.
            pending["gone"] = pending.get("gone", 0) + 1
            if pending["gone"] >= 2:
                self.pending_teach = None
                self.log("The hub took the new part card down. What is on the teach spot is not treated as new.")
        else:
            pending["gone"] = 0

    def prompt_dir(self) -> Path:
        return self.data_dir / "prompts"

    def save_prompt(self, product_id: str, frame: np.ndarray, boxes) -> None:
        """Keeps an example of a part: a whole frame and the boxes of that part in it, each x0, y0, x1, y1 from 0 to 1."""
        folder = self.prompt_dir()
        folder.mkdir(parents=True, exist_ok=True)
        np.save(folder / f"{product_id}.npy", frame)
        (folder / f"{product_id}.json").write_text(json.dumps({"boxes": [[round(float(v), 4) for v in box] for box in boxes]}), encoding="utf-8")
        self.log(f"Saved the example picture for {product_id}.")
        self.refresh_detector_zones()
        self.on_prompts_changed()

    def prompts(self) -> list[tuple[str, np.ndarray, list]]:
        """Saved examples for products that still own an open zone: (productId, frame, boxes)."""
        out = []
        wanted = {z["productId"] for z in self.zones if z["kind"] != "pockets" and z["productId"]}
        for product_id in sorted(wanted):
            try:
                frame = np.load(self.prompt_dir() / f"{product_id}.npy")
                boxes = json.loads((self.prompt_dir() / f"{product_id}.json").read_text(encoding="utf-8"))["boxes"]
                if frame.ndim == 3 and len(boxes) > 0 and all(len(b) == 4 for b in boxes):
                    out.append((product_id, frame, [tuple(b) for b in boxes]))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return out

    # ---------- the detector's results ----------

    def take_detections(self, camera_id: str, instances: list[dict], loaded: Optional[list[str]] = None) -> None:
        """Counts instances by the zone that holds their centre. Called from the detector thread.

        loaded is the parts the detector was looking for in this look. A zone whose part it does not know yet is left
        alone: seeing none of a part it was not looking for is not a count of zero.
        """
        with self.lock:
            zones = [z for z in self.zones_for(camera_id) if z["id"] in self.yolo_zones and (loaded is None or z["productId"] in loaded)]
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
            still = self.settled.get(camera_id, False)
            for zid, n in per_zone.items():
                if not still:
                    # A hand in the picture hides parts. What is seen then is not a count, and the run starts again.
                    self.smoother.runs.pop(zid, None)
                    continue
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
                "motion": dict(self.motion),
                "counts": {zid: state[0] for zid, state in self.counts.items()},
                "levels": dict(self.levels),
                "units": {zid: u["cells"] for zid, u in self.units.items()},
                "notes": {**self.notes, **self.hidden},
                "detector": "yoloe" if self.yolo_zones else "blobs",
                "teach": {"learned": self.teach_base is not None, "armed": self.teach_spot.armed, "waiting": (self.pending_teach or {}).get("id"), **self.teach_seen},
                "now": time.time(),
            }
