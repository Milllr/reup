import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from reup_eye.teach import MAX_JPEG_BYTES, TeachSpot, crop_quad, jpeg_under, present, view_quad

from .helpers import H, W, board, eye, fill, snapshot, still

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


def test_the_picture_of_a_new_part_keeps_the_spots_shape_and_shows_the_board_around_it():
    img = np.full((1080, 1920, 3), 150, np.uint8)
    spot = [[0.8, 0.6], [0.9, 0.6], [0.9, 0.8], [0.8, 0.8]]  # 192 by 216 pixels
    # A screw standing at the left edge of the spot, half of it outside, and something just beside the spot.
    img[660:860, 1530:1542] = 20
    img[700:760, 1500:1510] = 250
    view = view_quad(img, spot, 0.2, 640)
    assert view.shape == (640, 569, 3)
    # The spot is the middle of the picture, with a fifth of its size around it on every side.
    cols = np.where((view[:, :, 0] < 60).any(axis=0))[0]
    rows = np.where((view[:, :, 0] < 60).any(axis=1))[0]
    assert 66 < cols.min() < 74 and 90 < cols.max() < 98  # the whole screw, on both sides of the spot's edge at 81
    assert 110 < rows.min() < 124 and 532 < rows.max() < 548
    assert (view[:, :40, 0] > 240).any()  # what is beside the spot is in the picture too
    # With no margin it is the spot alone, and at the corner of the frame the picture is still whole.
    assert view_quad(img, spot, 0.0, 640).shape == (640, 569, 3)
    corner = view_quad(img, [[0.9, 0.85], [1.0, 0.85], [1.0, 1.0], [0.9, 1.0]], 0.2, 320)
    assert corner.shape[0] == 270 and corner.shape[1] == 320 and corner.dtype == np.uint8


def test_a_part_given_its_own_box_becomes_that_products_example(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    t = still(e, frame([ITEM]), t, 2.5)
    assert e.pending_teach["id"] == "t-1"
    assert e.config.teach.view == 0.15
    # The hub gave the part a new box, away from the teach spot. Its picture is the card's.
    snap = snapshot()
    snap["zones"].append({"id": "z-new", "name": "Tape", "kind": "open", "camera": "board", "quad": [[0.05, 0.6], [0.2, 0.6], [0.2, 0.9], [0.05, 0.9]], "rows": None, "cols": None, "productId": "p-tape"})
    snap["products"].append({"id": "p-tape", "name": "Blue tape", "zoneId": "z-new", "imageUrl": "/api/teach/t-1/crop.jpg"})
    snap["teach"] = None
    e.set_zones(snap)
    assert e.pending_teach is None
    assert (tmp_path / "prompts" / "p-tape.json").exists() and (tmp_path / "prompts" / "p-tape.npy").exists()
    assert [p[0] for p in e.prompts()] == ["p-tape"]
    assert "p-tape" in logs[-1]
    # A product made from another card is not this part.
    f, _hub, _ = eye(tmp_path / "other", TEACH, with_reference=False)
    t = still(f, frame(), 0.0, 2.5)
    still(f, frame([ITEM]), t, 2.5)
    snap["products"][-1]["imageUrl"] = "/api/teach/t-9/crop.jpg"
    snap["teach"] = {"id": "t-1"}
    f.set_zones(snap)
    assert f.pending_teach is not None and not (tmp_path / "other" / "prompts" / "p-tape.json").exists()


def test_a_new_part_on_the_teach_spot_is_sent_once_and_becomes_its_products_example(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    e.analyse("board", frame(), 0.0)
    e.capture_reference("board")
    t = still(e, frame(), 0.0, 2.5)
    assert hub.teaches == []
    t = still(e, frame([ITEM]), t, 2.5)
    assert len(hub.teaches) == 1 and hub.teaches[0][1] is None
    assert e.pending_teach["id"] == "t-1"
    # The part's box on the whole frame, a little wider than the part, and the frame it was seen in.
    x0, y0, x1, y1 = e.pending_teach["box"]
    assert 0.67 < x0 < 0.7 and 0.8 < x1 < 0.83 and 0.61 < y0 < 0.65 and 0.8 < y1 < 0.84
    assert e.pending_teach["frame"].shape == (H, W, 3)
    still(e, frame([ITEM]), t, 3)
    assert len(hub.teaches) == 1
    assert "teach spot" in logs[-1]


def test_the_teach_spot_needs_no_saved_empty_board_and_scattered_specks_are_not_a_part(tmp_path):
    e, hub, _ = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    assert e.references["board"] is None and e.teach_base is not None
    # A dozen specks, each far too small and none touching: together over 2 percent of the spot, and still not a part.
    specks = [[[0.62 + i * 0.022, 0.6 + (i % 4) * 0.07], [0.628 + i * 0.022, 0.6 + (i % 4) * 0.07], [0.628 + i * 0.022, 0.622 + (i % 4) * 0.07], [0.62 + i * 0.022, 0.622 + (i % 4) * 0.07]] for i in range(12)]
    t = still(e, frame(specks), t, 2.5)
    assert hub.teaches == []
    seen = e.health()["teach"]
    assert seen["learned"] and seen["waiting"] is None and seen["patch"] == 0.0
    t = still(e, frame(), t, 2.5)
    still(e, frame([ITEM]), t, 2.0)
    assert len(hub.teaches) == 1
    seen = e.health()["teach"]
    assert seen["waiting"] == "t-1" and not seen["armed"] and 0.05 < seen["patch"] <= seen["differs"] < 0.2


def wood(items=(), light=1.0, lamp=1.0):
    """Brown wood with parts on it. light dims or brightens the whole picture, lamp only the left half of the teach spot."""
    img = np.empty((H, W, 3), np.float32)
    img[:] = (52, 84, 128)  # blue, green, red
    for corners, colour in items:
        xs = (np.asarray(corners)[:, 0] * W).astype(int)
        ys = (np.asarray(corners)[:, 1] * H).astype(int)
        img[ys.min() : ys.max() + 1, xs.min() : xs.max() + 1] = colour
    img *= light
    img[int(0.55 * H) : int(0.92 * H), int(0.6 * W) : int(0.75 * W)] *= lamp
    return np.clip(img, 0, 255).astype(np.uint8)


def test_a_shadow_or_a_lamp_on_the_teach_spot_is_not_a_part_and_a_part_in_that_light_still_is(tmp_path):
    from reup_eye.counting import other_surface

    brown = np.array([[52.0, 84.0, 128.0]])
    assert not other_surface(brown * 0.6, brown).any() and not other_surface(brown * 1.7, brown).any()  # a shadow, a lamp
    assert other_surface(np.array([[120.0, 120.0, 120.0]]), brown).all()  # a zinc bolt: grey, about as bright
    assert other_surface(np.array([[14.0, 14.0, 14.0]]), brown).all()  # a black battery
    assert other_surface(np.array([[235.0, 235.0, 235.0]]), brown).all()  # a white label
    assert not other_surface(np.array([[60.0, 97.0, 147.0]]), brown).any()  # cardboard the colour of the board: not seen

    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, wood(), 0.0, 2.5)
    # Someone leans in and their shadow falls on half of the spot, at once, and they step back. A lamp is switched on.
    # Then the room goes dimmer. Nothing is announced.
    for light, lamp in ((1.0, 0.6), (1.0, 1.0), (1.0, 1.6), (0.7, 1.6), (0.7, 1.0)):
        t = still(e, wood(light=light, lamp=lamp), t, 3.0)
        assert hub.teaches == [] and e.teach_present_since is None
    # A grey bolt put down in the shadow is a part, once.
    bolt = (ITEM, (120, 120, 120))
    t = still(e, wood([bolt], light=0.7, lamp=0.6), t, 2.0)
    assert len(hub.teaches) == 1
    t = still(e, wood(light=0.7, lamp=0.6), t, 3.0)
    assert hub.cancelled == ["t-1"]
    # The hub cannot be reached when the next part goes down. After 20 seconds the part is no longer new. Taking it
    # away is not a part either, and putting it down again announces it.
    t = still(e, wood(), t, 3.0)
    real, hub.teach = hub.teach, lambda jpeg, zone_id: None
    t = still(e, wood([bolt]), t, 10.0)
    assert e.pending_teach is None and e.teach_present_since is not None and "Could not tell the hub" in logs[-1]
    t = still(e, wood([bolt]), t, 12.0)
    assert e.teach_present_since is None and "empty picture was taken again" in logs[-1]
    hub.teach = real
    t = still(e, wood(), t, 3.0)
    assert "taken away" in logs[-1] and len(hub.teaches) == 1 and hub.cancelled == ["t-1"]
    still(e, wood([bolt]), t, 2.0)
    assert len(hub.teaches) == 2


def test_a_part_lifted_off_before_it_is_named_takes_its_card_down(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    e.analyse("board", frame(), 0.0)
    e.capture_reference("board")
    t = still(e, frame(), 0.0, 2.5)
    t = still(e, frame([ITEM]), t, 2.0)
    assert len(hub.teaches) == 1 and e.pending_teach["id"] == "t-1"
    # Lifted for a moment: nothing yet. Gone for 2 seconds: the card is cancelled, once.
    t = still(e, frame(), t, 1.0)
    assert not getattr(hub, "cancelled", []) and e.pending_teach is not None
    t = still(e, frame(), t, 1.5)
    assert hub.cancelled == ["t-1"] and e.pending_teach is None and "taken off the teach spot" in logs[-1]
    t = still(e, frame(), t, 2.0)
    assert hub.cancelled == ["t-1"]
    # The next part put down is a new card.
    still(e, frame([ITEM]), t, 2.0)
    assert len(hub.teaches) == 2 and e.pending_teach["id"] == "t-2"


# An arm in front of the board: it comes in from the bottom of the picture, or from the ledge next door, and ends over the spot.
ARM_FROM_BELOW = [[0.7, 0.7], [0.8, 0.7], [0.8, 1.0], [0.7, 1.0]]
ARM_FROM_THE_SIDE = [[0.4, 0.68], [0.72, 0.68], [0.72, 0.8], [0.4, 0.8]]


def test_an_arm_held_over_the_teach_spot_is_not_a_part(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    # Someone takes a part from the ledge next door and holds still with it for five seconds, twice.
    for arm in (ARM_FROM_BELOW, ARM_FROM_THE_SIDE):
        t = still(e, frame([arm]), t, 5.0)
        seen = e.health()["teach"]
        assert hub.teaches == [] and e.pending_teach is None
        assert seen["reaching"] and seen["patch"] == 0.0 and seen["armed"]
        t = still(e, frame(), t, 2.5)
        assert hub.teaches == [] and not e.health()["teach"]["reaching"]
    assert not any("new part" in line.lower() for line in logs)
    # A hand puts a part down: nothing while the arm is there, one card once it is gone.
    t = still(e, frame([ITEM, ARM_FROM_BELOW]), t, 3.0)
    assert hub.teaches == []
    still(e, frame([ITEM]), t, 2.5)
    assert len(hub.teaches) == 1 and e.pending_teach["id"] == "t-1"
    # The picture of the part is the part, not the arm.
    x0, y0, x1, y1 = e.pending_teach["box"]
    assert 0.67 < x0 < 0.7 and 0.8 < x1 < 0.83 and 0.61 < y0 < 0.65 and 0.8 < y1 < 0.84


def test_an_arm_over_a_part_that_waits_for_its_name_does_not_take_its_card_down(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    t = still(e, frame([ITEM]), t, 2.5)
    assert len(hub.teaches) == 1 and e.pending_teach["id"] == "t-1"
    # A judge reaches across for the ledge next door, covering the part for five seconds.
    t = still(e, frame([ARM_FROM_THE_SIDE]), t, 5.0)
    assert not getattr(hub, "cancelled", []) and e.pending_teach is not None
    t = still(e, frame([ITEM]), t, 3.0)
    assert not getattr(hub, "cancelled", []) and len(hub.teaches) == 1
    # A hand lifts the part off: the card comes down once the spot has been empty for two seconds.
    t = still(e, frame([ARM_FROM_BELOW]), t, 1.0)
    still(e, frame(), t, 2.5)
    assert hub.cancelled == ["t-1"] and e.pending_teach is None and "taken off the teach spot" in logs[-1]


def screw(img, left=473, top=238, wide=5, tall=64):
    """A wood screw lying on the spot: 5 pixels wide, as the Facecam sees one. It sits across two of the eye's 4 pixel blocks."""
    img = img.copy()
    img[top : top + tall, left : left + wide] = 40
    return img


def test_a_thin_screw_on_the_teach_spot_is_a_part(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    t = still(e, screw(frame()), t, 2.5)
    assert len(hub.teaches) == 1 and e.pending_teach["id"] == "t-1"
    seen = e.health()["teach"]
    assert not seen["reaching"] and 0.004 < seen["patch"] < 0.03
    # Its box is the screw, a little wider.
    x0, y0, x1, y1 = e.pending_teach["box"]
    assert 0.72 < x0 < 0.745 and 0.745 < x1 < 0.77 and 0.63 < y0 < 0.67 and 0.83 < y1 < 0.87
    # Read from the small picture alone, the way it was, the same screw is not there at all.
    old, old_hub, _ = eye(tmp_path / "old", TEACH + "\nfine = 0\nshare = 0.004", with_reference=False)
    t = still(old, frame(), 0.0, 2.5)
    still(old, screw(frame()), t, 2.5)
    assert old.teach_n == old.config.open.grid and old_hub.teaches == []


def test_a_part_that_waits_for_its_name_stays_when_a_look_sees_less_of_it(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    t = still(e, screw(frame()), t, 2.5)
    assert len(hub.teaches) == 1 and e.pending_teach["id"] == "t-1"
    # For four seconds the camera sees a third of the screw: under the line for a new part, over the line for one that waits.
    t = still(e, screw(frame(), tall=22), t, 4.0)
    assert e.pending_teach is not None and not getattr(hub, "cancelled", [])
    # A third of a screw put down on an empty spot is not announced.
    f, f_hub, _ = eye(tmp_path / "fresh", TEACH, with_reference=False)
    u = still(f, frame(), 0.0, 2.5)
    still(f, screw(frame(), tall=22), u, 3.0)
    assert f_hub.teaches == []
    # Lifted off, the card comes down.
    still(e, frame(), t, 2.5)
    assert hub.cancelled == ["t-1"] and e.pending_teach is None


# On the ledge next door: inside the margin the eye watches around the spot, never on the spot.
NEXT_DOOR = [[0.45, 0.6], [0.585, 0.6], [0.585, 0.75], [0.45, 0.75]]


def test_something_moved_beside_the_teach_spot_does_not_blind_it(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    # A battery is pushed along the next ledge and left there. It is not an arm, and the spot is not waited on.
    t = still(e, frame([NEXT_DOOR]), t, 3.0)
    seen = e.health()["teach"]
    assert hub.teaches == [] and not seen["reaching"] and seen["armed"] and seen["patch"] == 0.0
    # A screw is put down a moment later, and found. Before, the spot stayed blind until its empty picture was taken again, screw and all.
    still(e, screw(frame([NEXT_DOOR])), t, 2.5)
    assert len(hub.teaches) == 1
    assert not any("empty picture was taken again" in line for line in logs)


def test_a_bumped_camera_does_not_raise_a_card_for_the_bare_spot(tmp_path):
    def ledge(shift: int):
        # The bare spot with a ledge across it. A bumped camera moves the ledge a few pixels in the picture.
        img = np.full((H, W, 3), 150, dtype=np.uint8)
        img[int(0.8 * H) + shift : int(0.86 * H) + shift, int(0.66 * W) : int(0.84 * W)] = 40
        return img

    # Without the relearn the shifted ledge reads as a patch of another surface on the spot, and a card goes up.
    plain, plain_hub, _ = eye(tmp_path / "plain", TEACH, with_reference=False)
    t = still(plain, ledge(0), 0.0, 2.5)
    still(plain, ledge(5), t, 2.5)
    assert len(plain_hub.teaches) == 1
    # The runtime says the picture was moved to line up: the eye learns the spot again and nothing is sent.
    e, hub, _ = eye(tmp_path / "bumped", TEACH, with_reference=False)
    t = still(e, ledge(0), 0.0, 2.5)
    e.teach_relearn("board")
    t = still(e, ledge(5), t, 4.0)
    assert hub.teaches == [] and e.health()["teach"]["learned"]
    # A real part set down afterwards is still found.
    with_part = ledge(5)
    fill(with_part, ITEM, 40)
    still(e, with_part, t, 3.0)
    assert len(hub.teaches) == 1
    # Another camera's move is not this spot's business, and a part waiting for its name keeps its card.
    e.teach_relearn("aux")
    e.teach_relearn("board")
    assert e.pending_teach is not None and e.teach_base is not None


def test_a_person_can_ask_for_what_is_on_the_teach_spot_to_be_named(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    assert "not looked" in e.teach_now()
    # A part the colour of the board: the eye sees nothing new on the spot.
    t = still(e, frame(), 0.0, 2.5)
    assert hub.teaches == [] and e.teach_now() is None
    assert len(hub.teaches) == 1 and hub.teaches[0][1] is None and e.pending_teach["id"] == "t-1"
    # With no patch to go by, the box is the middle of the spot.
    x0, y0, x1, y1 = e.pending_teach["box"]
    assert 0.63 < x0 < 0.66 and 0.84 < x1 < 0.87 and 0.59 < y0 < 0.62 and 0.89 < y1 < 0.91
    assert "already waiting" in e.teach_now() and len(hub.teaches) == 1
    # It is not then found a second time by itself, and the card stays up though the eye sees an empty spot.
    t = still(e, frame(), t, 4.0)
    assert len(hub.teaches) == 1 and e.pending_teach is not None and not getattr(hub, "cancelled", [])
    # The hub takes the card down when someone dismisses it, and the eye lets go of it.
    e.set_zones(snapshot())
    e.set_zones(snapshot())
    assert e.pending_teach is None
    # With a part in view the box is the part.
    f, f_hub, _ = eye(tmp_path / "second", TEACH + "\nhold_s = 60", with_reference=False)
    t = still(f, frame(), 0.0, 2.5)
    still(f, frame([ITEM]), t, 1.0)
    assert f_hub.teaches == [] and f.teach_now() is None
    x0, y0, x1, y1 = f.pending_teach["box"]
    assert 0.67 < x0 < 0.7 and 0.8 < x1 < 0.83 and 0.61 < y0 < 0.65 and 0.8 < y1 < 0.84


def test_with_no_margin_the_spot_is_read_alone(tmp_path):
    e, hub, _ = eye(tmp_path, TEACH + "\nreach = 0", with_reference=False)
    t = still(e, frame(), 0.0, 2.5)
    # One cell for every 2 pixels of the 192 pixel spot, and nothing around it.
    assert e.teach_n == 96 and e.teach_points.shape[0] == e.teach_n**2
    still(e, frame([ITEM]), t, 2.5)
    assert len(hub.teaches) == 1 and not e.health()["teach"]["reaching"]


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
    (product, saved, boxes), = e.prompts()
    assert product == "p-tape" and saved.shape == (H, W, 3) and len(boxes) == 1 and 0.67 < boxes[0][0] < 0.7
    t = still(e, frame([ITEM]), t, 1.5)
    assert e.counts["z-teach"] == (1, None)
    assert len(hub.teaches) == 1
    e.flush(t)
    assert {"productId": "p-tape", "zoneId": "z-teach", "count": 1} == {k: hub.posts[-1]["counts"][-1][k] for k in ("productId", "zoneId", "count")}
    # Outlines: one item on the teach spot, a handful of points, inside the zone.
    outline = [o for o in e.outlines["board"] if o["productId"] == "p-tape"]
    assert len(outline) == 1 and 3 <= len(outline[0]["points"]) <= 24
    assert all(0.6 <= x <= 0.9 and 0.55 <= y <= 0.92 for x, y in outline[0]["points"])


def pack(i: int, y0: float = 0.6, y1: float = 0.85, x0: float = 0.06, w: float = 0.08):
    """Pack number i on the glue ledge. Neighbours touch, as they do on the real board."""
    return [[x0 + i * w, y0], [x0 + (i + 1) * w, y0], [x0 + (i + 1) * w, y1], [x0 + i * w, y1]]


def test_touching_parts_are_one_patch_until_the_full_board_is_saved(tmp_path):
    e, hub, logs = eye(tmp_path, with_reference=False)
    e.analyse("board", frame(), 0.0)
    e.capture_reference("board")
    full = frame([pack(i) for i in range(4)])
    t = still(e, full, 0.0, 1.5)
    assert e.counts["z-glue"] == (1, None)  # four packs side by side look like one thing
    # The glue zone holds 4 (its part's capacity in the snapshot). Saving the full board teaches the size of one.
    result = e.capture_full("board")
    assert result["zones"]["z-glue"]["units"] == 4 and "z-discs" in result["skipped"] and "z-screws" not in result["zones"]
    assert "z-glue holds 4" in logs[-1]
    t = still(e, full, t, 1.0)
    assert e.counts["z-glue"] == (4, None)
    # Two taken from the middle, then one more, then the last.
    t = still(e, frame([pack(0), pack(3)]), t, 1.0)
    assert e.counts["z-glue"] == (2, None)
    t = still(e, frame([pack(0)]), t, 1.0)
    assert e.counts["z-glue"] == (1, None)
    t = still(e, frame(), t, 1.0)
    assert e.counts["z-glue"] == (0, None)
    # Restocked anywhere on the ledge, three in a row: three.
    t = still(e, frame([pack(i, x0=0.14) for i in range(3)]), t, 1.0)
    assert e.counts["z-glue"] == (3, None)
    e.flush(t)
    assert [c["count"] for c in hub.posts[-1]["counts"] if c["zoneId"] == "z-glue"] == [3]
    # One outline for the row, and none for a speck far smaller than a pack.
    speck = [[0.38, 0.6], [0.405, 0.6], [0.405, 0.66], [0.38, 0.66]]
    t = still(e, frame([pack(0), speck]), t, 1.0)
    assert e.counts["z-glue"] == (1, None) and len([o for o in e.outlines["board"] if o["productId"] == "p-glue"]) == 1


def test_the_size_of_one_unit_survives_a_restart_and_is_dropped_when_the_zone_changes_hands(tmp_path):
    e, _, _ = eye(tmp_path, with_reference=False)
    e.analyse("board", frame(), 0.0)
    e.capture_reference("board")
    still(e, frame([pack(i) for i in range(3)]), 0.0, 1.0)
    # The operator can say how many are there when it is not the capacity.
    assert e.capture_full("board", {"z-glue": 3})["zones"]["z-glue"]["units"] == 3
    again, _, _ = eye(tmp_path, with_reference=False)
    glue = next(z for z in again.zones if z["id"] == "z-glue")
    assert again.unit_cells(glue) == e.unit_cells(glue) and again.unit_cells(glue) > 0
    assert again.health()["units"] == {"z-glue": again.unit_cells(glue)}
    assert again.unit_cells({**glue, "productId": "p-other"}) is None


def test_the_full_board_needs_an_empty_board_first(tmp_path):
    e, _, _ = eye(tmp_path, with_reference=False)
    assert e.capture_full("board") is None
    e.analyse("board", frame(), 0.0)
    assert e.capture_full("board") is None
    e.capture_reference("board")
    assert e.capture_full("board") == {"zones": {}, "skipped": {"z-glue": "Nothing is in this zone.", "z-discs": "Nothing is in this zone."}}


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
    # While a hand is still moving, what the detector sees is drawn but is not a count.
    for _ in range(4):
        e.take_detections("board", seen)
    assert "z-glue" not in e.counts and len(e.detected["board"]) == 2
    t = still(e, board(), 0.0, 1.0)
    e.take_detections("board", seen)
    e.take_detections("board", seen)
    assert "z-glue" not in e.counts
    e.take_detections("board", seen)
    assert e.counts["z-glue"] == (2, None)
    assert len(e.detected["board"]) == 2
    # A hand comes in and hides one: two looks at one bottle are not enough once it moves again.
    e.take_detections("board", seen[:1])
    e.take_detections("board", seen[:1])
    e.analyse("board", board(extra=[([[0.5, 0.45], [0.7, 0.45], [0.7, 0.65], [0.5, 0.65]], 250)]), t + 0.1)
    e.take_detections("board", seen[:1])
    assert e.counts["z-glue"] == (2, None)


def test_a_part_in_another_parts_box_is_pointed_at_and_not_counted(tmp_path):
    snap = snapshot()
    snap["zones"] = [z for z in snap["zones"] if z["kind"] != "pockets"]
    e, hub, _ = eye(tmp_path, '[teach]\ncamera = "aux"\n[open]\nwrong_hold = 3', with_reference=False)
    e.set_zones(snap)
    e.yolo_zones = {"z-glue", "z-discs"}
    box = lambda cx, cy: [[cx - 0.03, cy - 0.05], [cx + 0.03, cy - 0.05], [cx + 0.03, cy + 0.05], [cx - 0.03, cy + 0.05]]  # noqa: E731
    glue = [{"productId": "p-glue", "centre": [0.1 + i * 0.08, 0.7], "points": box(0.1 + i * 0.08, 0.7), "conf": 0.9} for i in range(2)]
    stray = {"productId": "p-discs", "centre": [0.35, 0.8], "points": box(0.35, 0.8), "conf": 0.8}  # a disc on the glue ledge
    t = still(e, frame(), 0.0, 1.0)
    # It has to be there for three looks in a row before anything is said.
    e.take_detections("board", glue + [stray])
    e.take_detections("board", glue + [stray])
    assert e.misplaced["board"] == []
    e.take_detections("board", glue + [stray])
    assert [(m["productId"], m["zoneId"]) for m in e.misplaced["board"]] == [("p-discs", "z-glue")]
    # It is in no count: not glue's, and not the discs' own, which is empty.
    assert e.counts["z-glue"] == (2, None) and e.counts["z-discs"] == (0, None)
    still(e, frame(), t, 0.2)
    assert [o.get("zoneId") for o in e.outlines["board"]] == [None, None, "z-glue"]
    # While a hand is in the picture what was shown stays, and nothing new is added.
    e.analyse("board", board(extra=[([[0.5, 0.45], [0.7, 0.45], [0.7, 0.65], [0.5, 0.65]], 250)]), t + 0.3)
    e.take_detections("board", glue)
    assert len(e.misplaced["board"]) == 1
    # Taken out again: gone at the next still look.
    t = still(e, frame(), t + 0.4, 1.0)
    e.take_detections("board", glue)
    assert e.misplaced["board"] == []

    # Not said: one thing the model takes for two parts at once, a part it is not sure of, and one seen for a look or two.
    twin = {"productId": "p-discs", "centre": [0.1, 0.7], "points": box(0.11, 0.71), "conf": 0.9}
    unsure = {**stray, "conf": 0.35}
    for _ in range(5):
        e.take_detections("board", glue + [twin, unsure])
    assert e.misplaced["board"] == []
    e.take_detections("board", glue + [stray])
    e.take_detections("board", glue)
    e.take_detections("board", glue + [stray])
    e.take_detections("board", glue + [stray])
    assert e.misplaced["board"] == []
    # With wrong_hold = 0 the eye never points.
    off, _, _ = eye(tmp_path / "off", '[teach]\ncamera = "aux"\n[open]\nwrong_hold = 0', with_reference=False)
    off.set_zones(snap)
    off.yolo_zones = {"z-glue", "z-discs"}
    still(off, frame(), 0.0, 1.0)
    for _ in range(12):
        off.take_detections("board", glue + [stray])
    assert off.misplaced.get("board", []) == []


def test_parts_the_detector_counts_need_no_empty_board(tmp_path):
    snap = snapshot()
    snap["zones"] = [z for z in snap["zones"] if z["kind"] != "pockets"]
    e, hub, _ = eye(tmp_path, '[teach]\ncamera = "aux"', with_reference=False)
    e.set_zones(snap)
    e.yolo_zones = {"z-glue", "z-discs"}
    box = lambda cx, cy: [[cx - 0.03, cy - 0.05], [cx + 0.03, cy - 0.05], [cx + 0.03, cy + 0.05], [cx - 0.03, cy + 0.05]]  # noqa: E731
    seen = [{"productId": "p-glue", "centre": [0.1 + i * 0.07, 0.7], "points": box(0.1 + i * 0.07, 0.7)} for i in range(5)]
    t = still(e, frame(), 0.0, 1.0)
    for _ in range(3):
        e.take_detections("board", seen)
    still(e, frame(), t, 0.2)
    assert e.counts["z-glue"] == (5, None) and e.counts["z-discs"] == (0, None)
    assert "board" not in e.notes and len(e.outlines["board"]) == 5
    e.flush(t + 1)
    assert {c["zoneId"]: c["count"] for c in hub.posts[-1]["counts"]} == {"z-glue": 5, "z-discs": 0}


def test_the_detector_module_is_not_imported_unless_yoloe_is_asked_for():
    code = "import sys; import reup_eye.app, reup_eye.runtime, reup_eye.server, reup_eye.sim, reup_eye.config; print('reup_eye.detector' in sys.modules, 'ultralytics' in sys.modules, 'cv2' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, check=True)
    assert out.stdout.split() == ["False", "False", "False"]


def test_a_ledge_with_an_example_is_never_counted_as_blobs_while_the_detector_loads(tmp_path):
    # The real start on the board as built: an empty board was saved with the parts on it (only the teach spot was
    # clear), the examples are on disk, and the detector takes ten seconds to load. Nothing may read as zero meanwhile.
    snap = snapshot()
    snap["zones"] = [z for z in snap["zones"] if z["kind"] != "pockets"]
    full = frame([pack(i) for i in range(4)])
    e, hub, _ = eye(tmp_path, '[teach]\ncamera = "aux"', with_reference=False)
    e.set_zones(snap)
    e.save_prompt("p-glue", full, [tuple(np.array(pack(0))[[0, 2]].ravel())])
    e.analyse("board", full, 0.0)
    e.capture_reference("board")
    e.set_detector(True)
    assert e.yolo_zones == {"z-glue"}
    t = still(e, full, 0.0, 2.0)
    e.flush(t)
    assert "z-glue" not in e.counts and all(c["zoneId"] != "z-glue" for post in hub.posts for c in post["counts"])
    # The detector comes up knowing glue only. A look that was not for discs says nothing about discs.
    box = lambda cx, cy: [[cx - 0.03, cy - 0.05], [cx + 0.03, cy - 0.05], [cx + 0.03, cy + 0.05], [cx - 0.03, cy + 0.05]]  # noqa: E731
    seen = [{"productId": "p-glue", "centre": [0.1 + i * 0.08, 0.7], "points": box(0.1 + i * 0.08, 0.7)} for i in range(4)]
    e.save_prompt("p-discs", full, [(0.6, 0.6, 0.7, 0.7)])
    assert e.yolo_zones == {"z-glue", "z-discs"}
    e.counts["z-discs"] = (2, None)
    for _ in range(3):
        e.take_detections("board", seen, loaded=["p-glue"])
    assert e.counts == {"z-glue": (4, None), "z-discs": (2, None)}
    for _ in range(3):
        e.take_detections("board", seen, loaded=["p-discs", "p-glue"])
    assert e.counts == {"z-glue": (4, None), "z-discs": (0, None)}
    # No detector after all (ultralytics is not installed): the zones go back to the difference blobs.
    e.set_detector(False)
    assert e.yolo_zones == set()


def test_example_boxes_become_pixels_of_their_own_frame():
    from reup_eye.detector import pixel_boxes

    assert pixel_boxes((1080, 1920, 3), [(0.25, 0.5, 0.5, 1.0), (0.0, 0.0, 1.0, 1.0)]).tolist() == [[480, 540, 960, 1080], [0, 0, 1920, 1080]]
    assert pixel_boxes((720, 1280, 3), []).shape == (0, 4)


def test_an_example_is_the_whole_frame_and_the_boxes_of_the_part_in_it(tmp_path):
    e, _, logs = eye(tmp_path)
    changed = []
    e.on_prompts_changed = lambda: changed.append(True)
    picture = frame([ITEM])
    e.save_prompt("p-glue", picture, [(0.7, 0.65, 0.8, 0.8), (0.1, 0.6, 0.2, 0.75)])
    assert changed == [True] and "p-glue" in logs[-1]
    (product, saved, boxes), = e.prompts()
    assert product == "p-glue" and saved.shape == picture.shape and (saved == picture).all()
    assert boxes == [(0.7, 0.65, 0.8, 0.8), (0.1, 0.6, 0.2, 0.75)]
    # A part that no longer owns an open zone is not looked for, and a broken file is skipped, not guessed at.
    e.save_prompt("p-gone", picture, [(0.1, 0.1, 0.2, 0.2)])
    (tmp_path / "prompts" / "p-discs.json").write_text("{}", encoding="utf-8")
    assert [p[0] for p in e.prompts()] == ["p-glue"]


class Source:
    def __init__(self, picture):
        self.frame = picture


def test_the_operator_can_box_one_part_or_let_the_whole_zone_be_the_example(tmp_path):
    from reup_eye.config import load
    from reup_eye.runtime import Runtime

    runtime = Runtime(load(text=""), "http://localhost:1", "t", tmp_path, post=False, log=lambda _m: None)
    runtime.eye.set_zones(snapshot())
    assert runtime.capture_prompt("z-glue") == "No frame from that camera yet."
    runtime.sources["board"] = Source(frame([ITEM]))
    assert runtime.capture_prompt("z-nowhere") == "No zone z-nowhere with a part in it."
    assert runtime.capture_prompt("z-glue", [(0.3, 0.7, 0.2, 0.6)]) is None  # corners in any order
    assert runtime.eye.prompts()[0][2] == [(0.2, 0.6, 0.3, 0.7)]
    assert runtime.capture_prompt("z-glue", [(0.5, 0.5, 0.5, 0.9)]) == "That box is not a part of the picture."
    assert runtime.capture_prompt("z-glue") is None
    assert runtime.eye.prompts()[0][2] == [(0.04, 0.55, 0.45, 0.92)]



def test_the_detector_runs_in_a_process_of_its_own_and_answers_the_same_two_calls():
    from reup_eye.detector_proc import DetectorProcess

    det = DetectorProcess("any.pt", 960, 0.3, make="tests.helpers:FakeDetector", start_timeout=60)
    try:
        det.set_prompts([("p-glue", np.zeros((36, 64, 3), np.uint8), [(0.1, 0.1, 0.2, 0.2)])])
        picture = np.full((36, 64, 3), 150, np.uint8)
        found = det.detect(picture)
        assert len(found) == 3 and found[0]["productId"] == "p-glue" and found[0]["shape"] == [36, 64, 3]
        assert det.detect(np.zeros((36, 64, 3), np.uint8)) == []
        # A frame it chokes on is one failed look, said in words. The process is still there for the next one.
        with pytest.raises(RuntimeError, match="bad frame"):
            det.detect(np.full((36, 64, 3), 255, np.uint8))
        assert len(det.detect(picture)) == 3
    finally:
        det.close()
    assert not det.process.is_alive()


def test_a_detector_that_cannot_load_says_why():
    from reup_eye.detector_proc import DetectorProcess

    with pytest.raises(RuntimeError, match="No module named 'ultralytics'"):
        DetectorProcess("missing.pt", 960, 0.3, make="tests.helpers:FakeDetector", start_timeout=60)


def test_a_card_the_hub_took_down_is_let_go_and_what_stays_on_the_spot_stops_being_new(tmp_path):
    e, hub, logs = eye(tmp_path, TEACH, with_reference=False)
    t = still(e, wood(), 0.0, 2.5)
    bolt = (ITEM, (120, 120, 120))
    t = still(e, wood([bolt]), t, 2.0)
    assert len(hub.teaches) == 1 and e.pending_teach["id"] == "t-1"
    shown = {**snapshot(), "teach": {"id": "t-1", "status": "failed"}}
    e.set_zones(shown)
    e.set_zones({**snapshot(), "teach": None})  # one snapshot without it is not enough
    e.set_zones(shown)
    e.set_zones({**snapshot(), "teach": None})
    assert e.pending_teach is not None
    e.set_zones({**snapshot(), "teach": None})
    assert e.pending_teach is None and "took the new part card down" in logs[-1]
    # The bolt is still there. After 20 seconds it is part of the empty spot, and taking it away is not a new part either.
    t = still(e, wood([bolt]), t, 21.0)
    assert e.teach_present_since is None and len(hub.teaches) == 1
    t = still(e, wood(), t, 25.0)
    assert len(hub.teaches) == 1 and getattr(hub, "cancelled", []) == []
    # The next part is announced.
    t = still(e, wood([(ITEM, (20, 20, 20))]), t, 2.0)
    assert len(hub.teaches) == 2


def test_a_new_part_that_looks_like_an_old_one_does_not_take_it_out_of_its_count(tmp_path):
    """Sun Nov 22, 5 AM: a hook was taught, the detector read the leftmost bolt as a hook, and an order for bolts began."""
    snap = snapshot()
    snap["zones"] = [z for z in snap["zones"] if z["kind"] != "pockets"]
    logs: list[str] = []
    e, _hub, _ = eye(tmp_path, '[teach]\ncamera = "aux"\n[open]\nwrong_hold = 3', with_reference=False)
    e.log = logs.append
    e.set_zones(snap)
    e.yolo_zones = {"z-glue", "z-discs"}
    box = lambda cx, cy: [[cx - 0.03, cy - 0.05], [cx + 0.03, cy - 0.05], [cx + 0.03, cy + 0.05], [cx - 0.03, cy + 0.05]]  # noqa: E731
    glue = [{"productId": "p-glue", "centre": [0.1 + i * 0.08, 0.7], "points": box(0.1 + i * 0.08, 0.7), "conf": 0.9} for i in range(3)]
    old, new = ["p-discs", "p-glue"], ["p-discs", "p-glue", "p-hook"]
    t = still(e, frame(), 0.0, 1.0)
    for _ in range(3):
        e.take_detections("board", glue, old)
    assert e.counts["z-glue"] == (3, None)
    # The hook is taught. The same three bottles stand where they stood, and the first now carries the hook's name.
    as_hook = [{**glue[0], "productId": "p-hook", "conf": 0.96}] + glue[1:]
    for _ in range(4):
        e.take_detections("board", as_hook, new)
    assert e.counts["z-glue"] == (3, None)
    assert e.confused["board"] == {("z-glue", "p-hook")}
    assert e.misplaced["board"] == []
    assert [d["productId"] for d in e.detected["board"]] == ["p-glue"] * 3
    assert sum("still counts as p-glue" in line for line in logs) == 1
    # It flickers between the two names from look to look: the count does not.
    for seen in (glue, as_hook, glue, as_hook):
        e.take_detections("board", seen, new)
    assert e.counts["z-glue"] == (3, None)
    # A thing under the hook's name where nothing was at home before is a stranger, as ever: pointed at, in no count.
    stray = {"productId": "p-hook", "centre": [0.7, 0.8], "points": box(0.7, 0.8), "conf": 0.9}
    for _ in range(3):
        e.take_detections("board", as_hook + [stray], new)
    assert [(m["productId"], m["zoneId"]) for m in e.misplaced["board"]] == [("p-hook", "z-discs")]
    assert e.counts["z-discs"] == (0, None)
    # The eye is started again (the watchdog does that): what it learned is on disk.
    again, _hub2, _ = eye(tmp_path, '[teach]\ncamera = "aux"\n[open]\nwrong_hold = 3', with_reference=False)
    again.set_zones(snap)
    again.yolo_zones = {"z-glue", "z-discs"}
    still(again, frame(), 0.0, 1.0)
    for _ in range(3):
        again.take_detections("board", as_hook, new)
    assert again.counts["z-glue"] == (3, None)
    # The hook is removed from the board's parts: its name means nothing in any box now.
    for _ in range(3):
        e.take_detections("board", glue, old)
    assert e.confused["board"] == set()
    still(e, frame(), t, 0.2)


def test_a_part_that_was_always_known_is_never_excused_in_another_parts_box(tmp_path):
    snap = snapshot()
    snap["zones"] = [z for z in snap["zones"] if z["kind"] != "pockets"]
    e, _hub, _ = eye(tmp_path, '[teach]\ncamera = "aux"\n[open]\nwrong_hold = 3', with_reference=False)
    e.set_zones(snap)
    e.yolo_zones = {"z-glue", "z-discs"}
    box = lambda cx, cy: [[cx - 0.03, cy - 0.05], [cx + 0.03, cy - 0.05], [cx + 0.03, cy + 0.05], [cx - 0.03, cy + 0.05]]  # noqa: E731
    glue = [{"productId": "p-glue", "centre": [0.1 + i * 0.08, 0.7], "points": box(0.1 + i * 0.08, 0.7), "conf": 0.9} for i in range(3)]
    parts = ["p-discs", "p-glue"]
    still(e, frame(), 0.0, 1.0)
    for _ in range(3):
        e.take_detections("board", glue, parts)
    # A bottle is swapped for a disc in the same place. Both parts were known all along: it is a disc in the glue box.
    swapped = [{**glue[0], "productId": "p-discs"}] + glue[1:]
    for _ in range(3):
        e.take_detections("board", swapped, parts)
    assert e.counts["z-glue"] == (2, None)
    assert e.confused["board"] == set()
    assert [(m["productId"], m["zoneId"]) for m in e.misplaced["board"]] == [("p-discs", "z-glue")]


def test_a_box_that_is_gone_keeps_no_count(tmp_path):
    snap = snapshot()
    snap["zones"] = [z for z in snap["zones"] if z["kind"] != "pockets"]
    e, _hub, _ = eye(tmp_path, '[teach]\ncamera = "aux"', with_reference=False)
    e.set_zones(snap)
    e.counts["z-glue"] = (3, None)
    snap["zones"] = [z for z in snap["zones"] if z["id"] != "z-glue"]
    e.set_zones(snap)
    assert "z-glue" not in e.counts
