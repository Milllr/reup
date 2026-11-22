import numpy as np
import pytest

from reup_eye import contracts as C
from reup_eye.counting import ChangeGate, CountSmoother, SettleFilter, assign, blob_count, gain, label_blobs, motion_energy, pocket_levels, pockets_full

from .helpers import board, eye, snapshot, still


def test_occupancy_on_synthetic_cells_empty_full_and_half_covered():
    ref = np.full((3, 100), 150.0)
    cur = ref.copy()
    cur[1] = 60  # a box
    cur[2, :50] = 60  # half covered
    levels = pocket_levels(cur, ref)
    assert levels == pytest.approx([0, 90, 45])
    assert pockets_full(levels, 18) == [False, True, True]
    sliver = ref.copy()
    sliver[0, :10] = 60
    assert pockets_full(pocket_levels(sliver, ref), 18) == [False, False, False]


def test_a_full_pocket_does_not_flicker_near_the_threshold():
    assert pockets_full([17], 18) == [False]
    assert pockets_full([17], 18, previous=[True]) == [True]
    assert pockets_full([12], 18, previous=[True]) == [False]


def test_gain_correction_cancels_a_uniform_brightness_change():
    rng = np.random.default_rng(3)
    ref_border, ref_cells = rng.uniform(120, 180, 400), rng.uniform(120, 180, (4, 100))
    cur_cells = ref_cells.copy()
    cur_cells[2] = 40
    dim = 2 / 3
    g = gain(ref_border * dim, ref_border)
    assert g == pytest.approx(1.5, rel=0.01)
    before = pocket_levels(cur_cells, ref_cells)
    after = pocket_levels(cur_cells * dim, ref_cells, g)
    assert after == pytest.approx(before, abs=0.5)
    assert pockets_full(after, 18) == [False, False, True, False]
    # Without the correction every pocket would look full.
    assert pockets_full(pocket_levels(cur_cells * dim, ref_cells), 18) == [True, True, True, True]
    assert gain(np.zeros(0), np.zeros(0)) == 1.0


def test_the_settle_filter_holds_while_moving_and_releases_after_500_ms():
    f = SettleFilter(500)
    assert f.update(False, 0.0) is False  # not enough stillness seen yet
    assert f.update(False, 0.5) is True
    assert f.update(True, 1.0) is False
    assert f.update(False, 1.4) is False
    assert f.update(True, 1.45) is False
    assert f.update(False, 1.9) is False
    assert f.update(False, 1.96) is True
    assert motion_energy(np.array([10.0, 10, 10, 10]), np.array([10.0, 10, 40, 10])) == 0.25
    assert motion_energy(np.array([10.0, 12]), np.array([11.0, 9])) == 0.0


def test_changed_only_posting_with_a_30_second_keepalive():
    gate = ChangeGate(30)
    assert gate.due("z", (4, None), 0.0)
    gate.mark("z", (4, None), 0.0)
    assert not gate.due("z", (4, None), 10.0)
    assert gate.due("z", (3, None), 10.0)
    assert not gate.due("z", (4, None), 29.9)
    assert gate.due("z", (4, None), 30.0)


def test_a_count_must_hold_for_3_detections_in_a_row():
    s = CountSmoother(3)
    assert [s.update("z", n) for n in (2, 2)] == [None, None]
    assert s.update("z", 2) == 2
    assert [s.update("z", n) for n in (3, 3)] == [2, 2]
    assert s.update("z", 2) == 2  # the run of 3s was broken
    assert [s.update("z", n) for n in (3, 3, 3)] == [2, 2, 3]


def test_instances_are_assigned_to_the_zone_that_contains_their_centre():
    zones = [(z["id"], z["quad"]) for z in snapshot()["zones"]]
    assert assign((0.2, 0.7), zones) == "z-glue"
    assert assign((0.7, 0.7), zones) == "z-discs"
    assert assign((0.48, 0.7), zones) is None


def test_blobs_are_found_and_small_specks_ignored():
    mask = np.zeros((20, 20), dtype=bool)
    mask[2:8, 2:8] = True
    mask[12:16, 10:18] = True
    mask[19, 19] = True
    blobs = label_blobs(mask, min_cells=4)
    assert [len(b) for b in blobs] == [36, 32]
    assert blob_count(blobs, None) == 2
    assert blob_count([blobs[0] + blobs[1]], 34) == 2  # two touching items, known size
    # Four packs side by side are one patch. Half a unit rounds up, and a patch under the floor is not a part.
    patch = lambda n: [(0, i) for i in range(n)]  # noqa: E731
    assert blob_count([patch(400)], 100) == 4 and blob_count([patch(250)], 100) == 3 and blob_count([patch(249)], 100) == 2
    assert blob_count([patch(100), patch(25)], 100, floor=0.3) == 1 and blob_count([patch(100), patch(35)], 100, floor=0.3) == 2


def test_the_eye_counts_the_board_and_posts_a_body_the_contract_accepts(tmp_path):
    e, hub, _ = eye(tmp_path)
    t = still(e, board({"z-screws": [0, 1, 2, 3, 4, 5], "z-brackets": [0, 1, 2, 3, 4]}), 0.0)
    assert e.counts["z-screws"] == (6, (True,) * 6 + (False,) * 6)
    assert e.flush(t)
    body = C.IngestCountsBody.model_validate(hub.posts[-1])
    by_zone = {c.zoneId: c for c in body.counts}
    assert by_zone["z-screws"].count == 6 and by_zone["z-screws"].productId == "p-screws" and by_zone["z-screws"].source == "eye"
    assert by_zone["z-screws"].pockets == [True] * 6 + [False] * 6
    assert by_zone["z-brackets"].count == 5
    # Open zones with nothing in them count zero as blobs.
    assert by_zone["z-glue"].count == 0 and by_zone["z-glue"].pockets is None


def test_nothing_is_posted_while_a_hand_moves_and_the_new_count_goes_out_after_it_leaves(tmp_path):
    e, hub, _ = eye(tmp_path)
    t = still(e, board({"z-screws": [0, 1, 2, 3, 4, 5]}), 0.0)
    e.flush(t)
    hub.posts.clear()
    hand = lambda x: [([[x, 0.05], [x + 0.12, 0.05], [x + 0.12, 0.6], [x, 0.6]], 90)]  # noqa: E731
    # A hand sweeps over the pockets and takes two boxes.
    for i in range(8):
        t += 0.1
        e.analyse("board", board({"z-screws": [0, 1, 2, 3]}, extra=hand(0.1 + i * 0.04)), t)
        assert e.counts["z-screws"][0] == 6
        assert not e.flush(t)
    left = t
    while t < left + 1.5 and not hub.posts:
        t += 0.1
        e.analyse("board", board({"z-screws": [0, 1, 2, 3]}), t)
        e.flush(t)
    assert 0.5 <= t - left <= 1.5
    assert [c["count"] for c in hub.posts[-1]["counts"]] == [4]
    assert hub.posts[-1]["counts"][0]["pockets"] == [True] * 4 + [False] * 8
    # Unchanged: quiet, until the keepalive.
    hub.posts.clear()
    t = still(e, board({"z-screws": [0, 1, 2, 3]}), t, 5)
    assert not e.flush(t)
    assert e.flush(t + 30)
    assert len(hub.posts[-1]["counts"]) == 4


def test_motion_beside_the_board_does_not_hold_the_counts_and_motion_on_it_does(tmp_path):
    e, _, _ = eye(tmp_path)
    assert e.board_quad("board") == pytest.approx(np.array([[0.0, 0.06], [0.96, 0.06], [0.96, 0.96], [0.0, 0.96]]))
    beside = [[0.965, 0.0], [1.0, 0.0], [1.0, 1.0], [0.965, 1.0]]  # a laptop screen at the edge of the frame
    t = 0.0
    for i in range(20):
        t += 0.1
        e.analyse("board", board({"z-screws": [0, 1, 2]}, extra=[(beside, 250 if i % 2 else 20)]), t)
    assert e.settled["board"] and e.counts["z-screws"][0] == 3
    on_it = [[0.57, 0.44], [0.67, 0.44], [0.67, 0.54], [0.57, 0.54]]  # a hand between the zones
    for i in range(20):
        t += 0.1
        e.analyse("board", board({"z-screws": [0]}, extra=[(on_it, 250 if i % 2 else 20)]), t)
    assert not e.settled["board"] and e.counts["z-screws"][0] == 3
    # config.toml can still name the board's corners itself.
    named, _, _ = eye(tmp_path, "[cameras.board]\nboard = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]")
    assert named.board_quad("board") == [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]


def test_dimming_the_room_by_a_third_changes_no_pocket(tmp_path):
    e, _, _ = eye(tmp_path)
    full = {"z-screws": [0, 1, 2, 3], "z-brackets": [1, 4]}
    t = still(e, board(full), 0.0)
    before = dict(e.counts)
    still(e, board(full, brightness=2 / 3), t, 2)
    assert e.counts["z-screws"] == before["z-screws"] and e.counts["z-brackets"] == before["z-brackets"]
    assert e.counts["z-screws"][0] == 4


def test_a_failed_post_is_sent_again_and_camera_health_can_go_alone(tmp_path):
    e, hub, _ = eye(tmp_path)
    t = still(e, board({"z-screws": [0]}), 0.0)
    hub.ok = False
    assert not e.flush(t)
    hub.ok = True
    assert e.flush(t + 0.1) and len(hub.posts[-1]["counts"]) == 4
    cameras = [{"id": "board", "online": True, "fps": 29.5, "streamUrl": "http://localhost:8089/stream/board.mjpg"}]
    assert e.flush(t + 0.2, cameras)
    assert hub.posts[-1] == {"counts": [], "cameras": cameras}
    C.IngestCountsBody.model_validate(hub.posts[-1])


def test_without_an_empty_board_nothing_is_counted_and_the_eye_says_what_to_do(tmp_path):
    e, hub, _ = eye(tmp_path, with_reference=False)
    t = still(e, board({"z-screws": [0, 1]}), 0.0)
    assert e.counts == {} and not e.flush(t)
    assert "POST /reference/board" in e.notes["board"]


def test_zones_parse_from_the_snapshot_mock_and_a_broken_one_is_skipped(tmp_path):
    e, _, logs = eye(tmp_path)
    assert [z["id"] for z in e.zones] == ["z-screws", "z-brackets", "z-glue", "z-discs"]
    bad = snapshot()
    bad["zones"][0]["quad"] = [[0, 0]]
    e.set_zones(bad)
    assert len(e.zones) == 3 and "Skipped a zone" in logs[-1]
