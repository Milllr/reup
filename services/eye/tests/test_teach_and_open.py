import subprocess
import sys
from pathlib import Path

import numpy as np

from reup_eye.teach import MAX_JPEG_BYTES, TeachSpot, crop_quad, jpeg_under, present

from .helpers import H, W, eye, fill, snapshot, still

TEACH = "[teach]\ncamera = \"board\"\nquad = [[0.6, 0.55], [0.9, 0.55], [0.9, 0.92], [0.6, 0.92]]\nzone = \"z-none\""
ITEM = [[0.7, 0.65], [0.8, 0.65], [0.8, 0.8], [0.7, 0.8]]


def frame(items=()):
    img = np.full((H, W, 3), 150, dtype=np.uint8)
    for corners in items:
        fill(img, corners, 40)
    return img


def test_presence_against_the_empty_teach_spot():
    ref = np.full(400, 150.0)
    cur = ref.copy()
    assert not present(cur, ref)
    cur[:60] = 60
    assert present(cur, ref)
    assert not present(ref * 0.67, ref, g=1.5)  # darker room, nothing there
    cur = ref.copy()
    cur[:4] = 60
    assert not present(cur, ref)  # a speck


def test_one_teach_for_each_placement():
    spot = TeachSpot(hold_s=1.0, clear_s=2.0)
    # Something is already there at start: not a new placement.
    assert not any(spot.update(True, False, t / 10) for t in range(30))
    # Empty for 2 seconds arms it.
    assert not any(spot.update(False, False, 3 + t / 10) for t in range(21))
    # Placed, still wobbling: nothing. Then still for 1 second: one teach.
    assert not spot.update(True, True, 5.2)
    fired = [spot.update(True, False, 5.3 + t / 10) for t in range(30)]
    assert fired.count(True) == 1 and fired.index(True) == 10
    # Lifted for a moment and put back: the spot was not empty for 2 seconds, so no second teach.
    assert not spot.update(False, False, 8.4)
    assert not any(spot.update(True, False, 8.5 + t / 10) for t in range(30))
    # Empty for 2 seconds, then a new item: a new teach.
    assert not any(spot.update(False, False, 11.5 + t / 10) for t in range(21))
    assert any(spot.update(True, False, 13.6 + t / 10) for t in range(12))


def test_the_jpeg_is_encoded_again_at_lower_quality_until_it_is_under_400_kb():
    calls = []

    def encode(frame, quality):
        calls.append((frame.shape[0], quality))
        return bytes(int(frame.shape[0] * frame.shape[1] * quality * 0.02))

    out = jpeg_under(np.zeros((640, 640, 3), np.uint8), encode)
    assert len(out) <= MAX_JPEG_BYTES
    assert calls == [(640, 88), (640, 78), (640, 68), (640, 58), (640, 48)]
    calls.clear()
    assert len(jpeg_under(np.zeros((2000, 2000, 3), np.uint8), encode)) <= MAX_JPEG_BYTES
    assert calls[-1] == (500, 78)  # quality alone was not enough, so it halved the picture, twice


def test_the_crop_is_the_inside_of_the_quad():
    img = np.zeros((100, 200, 3), np.uint8)
    img[20:60, 50:150] = 200
    crop = crop_quad(img, [[0.25, 0.2], [0.75, 0.2], [0.75, 0.6], [0.25, 0.6]], 64, 64)
    assert crop.shape == (64, 64, 3) and crop.min() == 200


def test_a_new_part_on_the_teach_spot_is_sent_once_and_becomes_its_products_example(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    e.analyse("board", frame(), 0.0)
    e.capture_reference("board")
    t = still(e, frame(), 0.0, 2.5)
    assert hub.teaches == []
    t = still(e, frame([ITEM]), t, 2.5)
    assert len(hub.teaches) == 1 and hub.teaches[0][1] is None
    assert e.pending_teach["id"] == "t-1"
    x0, y0, x1, y1 = e.pending_teach["box"]
    assert 0.25 < x0 < 0.4 and 0.6 < x1 < 0.75 and 0.2 < y0 < 0.35 and 0.6 < y1 < 0.75
    still(e, frame([ITEM]), t, 3)
    assert len(hub.teaches) == 1
    assert "teach spot" in logs[-1]


def test_after_the_hub_confirms_the_picture_is_saved_and_the_zone_is_counted(tmp_path):
    snap = snapshot()
    snap["zones"].append({"id": "z-teach", "name": "Teach spot", "kind": "open", "camera": "board", "quad": [[0.6, 0.55], [0.9, 0.55], [0.9, 0.92], [0.6, 0.92]], "rows": None, "cols": None, "productId": None})
    snap["zones"] = [z for z in snap["zones"] if z["id"] != "z-discs"]
    e, hub, _ = eye(tmp_path, with_reference=False)
    e.set_zones(snap)
    e.analyse("board", frame(), 0.0)
    e.capture_reference("board")
    t = still(e, frame(), 0.0, 2.5)
    t = still(e, frame([ITEM]), t, 2.0)
    assert [z for _, z in hub.teaches] == ["z-teach"]
    assert "z-teach" not in e.counts
    changed = []
    e.on_prompts_changed = lambda: changed.append(True)
    snap["zones"][-1]["productId"] = "p-tape"
    e.set_zones(snap)
    assert (tmp_path / "prompts" / "p-tape.npy").exists() and changed == [True] and e.pending_teach is None
    assert [p[0] for p in e.prompts()] == ["p-tape"]
    t = still(e, frame([ITEM]), t, 1.5)
    assert e.counts["z-teach"] == (1, None)
    assert len(hub.teaches) == 1
    e.flush(t)
    assert {"productId": "p-tape", "zoneId": "z-teach", "count": 1} == {k: hub.posts[-1]["counts"][-1][k] for k in ("productId", "zoneId", "count")}
    # Outlines: one item on the teach spot, a handful of points, inside the zone.
    outline = [o for o in e.outlines["board"] if o["productId"] == "p-tape"]
    assert len(outline) == 1 and 3 <= len(outline[0]["points"]) <= 24
    assert all(0.6 <= x <= 0.9 and 0.55 <= y <= 0.92 for x, y in outline[0]["points"])


def test_detections_are_counted_by_zone_and_product_and_smoothed(tmp_path):
    e, _, _ = eye(tmp_path)
    e.yolo_zones = {"z-glue"}
    box = lambda cx, cy: [[cx - 0.03, cy - 0.05], [cx + 0.03, cy - 0.05], [cx + 0.03, cy + 0.05], [cx - 0.03, cy + 0.05]]  # noqa: E731
    seen = [
        {"productId": "p-glue", "centre": [0.1, 0.7], "points": box(0.1, 0.7)},
        {"productId": "p-glue", "centre": [0.3, 0.7], "points": box(0.3, 0.7)},
        {"productId": "p-glue", "centre": [0.7, 0.7], "points": box(0.7, 0.7)},  # in the discs zone: not glue's
        {"productId": "p-discs", "centre": [0.2, 0.8], "points": box(0.2, 0.8)},  # wrong part for this zone
    ]
    e.take_detections("board", seen)
    e.take_detections("board", seen)
    assert "z-glue" not in e.counts
    e.take_detections("board", seen)
    assert e.counts["z-glue"] == (2, None)
    assert len(e.detected["board"]) == 2


def test_the_detector_module_is_not_imported_unless_yoloe_is_asked_for():
    code = "import sys; import reup_eye.app, reup_eye.runtime, reup_eye.server, reup_eye.sim, reup_eye.config; print('reup_eye.detector' in sys.modules, 'ultralytics' in sys.modules, 'cv2' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, check=True)
    assert out.stdout.split() == ["False", "False", "False"]


def test_the_reference_canvas_tiles_the_examples_with_one_box_each():
    from reup_eye.detector import TILE, reference_canvas

    a = np.full((100, 200, 3), 10, np.uint8)
    b = np.full((640, 640, 3), 250, np.uint8)
    canvas, boxes, classes = reference_canvas([("p-a", a, (0.25, 0.25, 0.75, 0.75)), ("p-b", b, (0.0, 0.0, 1.0, 1.0))])
    assert canvas.shape == (TILE, TILE * 2, 3) and canvas[0, 0, 0] == 10 and canvas[0, TILE, 0] == 250
    assert boxes.tolist() == [[TILE * 0.25, TILE * 0.25, TILE * 0.75, TILE * 0.75], [TILE, 0, TILE * 2, TILE]]
    assert classes.tolist() == [0, 1]
