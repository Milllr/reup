import numpy as np
import pytest

from reup_eye.align import HEIGHT, IDENTITY, WIDTH, Steady, for_frame, moved, turn


def slide(dx, dy, degrees=0.0):
    c, s = np.cos(np.radians(degrees)), np.sin(np.radians(degrees))
    return np.array([[c, -s, dx], [s, c, dy]])


def sure(matrix, phase=0.5, match=0.7):
    return {"matrix": matrix, "phase": phase, "match": match}


def test_how_far_a_move_moves_the_picture():
    assert moved(IDENTITY) == 0
    assert moved(slide(5, -3)) == pytest.approx(5)
    assert moved(slide(0, 0, 1.0)) == pytest.approx(WIDTH * np.sin(np.radians(1.0)), rel=0.1)
    assert turn(slide(3, 3, 1.5)) == pytest.approx(1.5)
    # On the full frame the slide is four times as long and the turn is the same.
    big = for_frame(slide(5, -3, 1.0), 1920)
    assert big[:, 2].tolist() == [20, -12] and turn(big) == pytest.approx(1.0)


def test_a_bump_is_taken_up_after_two_looks_agree_and_one_bad_look_changes_nothing():
    s = Steady()
    assert not s.update(sure(slide(12, -6)))
    assert not s.is_moved()
    assert s.update(sure(slide(12.3, -6.2)))
    assert s.is_moved() and moved(s.matrix) == pytest.approx(12.3)
    # A wild estimate, once: ignored. The same wild estimate twice would be believed.
    assert not s.update(sure(slide(40, 30)))
    assert not s.update(sure(slide(12.1, -6.0)))
    assert moved(s.matrix) == pytest.approx(12.3)
    # The camera is put back: the picture is left alone again.
    assert not s.update(sure(slide(0.4, 0.2)))
    assert s.update(sure(slide(0.3, -0.1)))
    assert not s.is_moved() and (s.matrix == IDENTITY).all()


def test_a_move_smaller_than_the_room_the_zones_have_is_no_move():
    s = Steady(dead=2.0)
    for _ in range(5):
        assert not s.update(sure(slide(1.2, -0.8)))
    assert (s.matrix == IDENTITY).all()


def test_an_unsure_look_changes_nothing_and_a_hidden_board_is_said_to_be_hidden():
    s = Steady()
    s.update(sure(slide(10, 0)))
    s.update(sure(slide(10, 0)))
    # A hand over a third of the board: still the board, just not sure enough to move anything.
    assert not s.update(sure(slide(30, 9), phase=0.18, match=0.1))
    assert not s.hidden and moved(s.matrix) == pytest.approx(10)
    # Someone stands in front of it.
    assert not s.update(sure(slide(170, 90), phase=0.01, match=0.28))
    assert not s.hidden  # once is not enough
    assert not s.update(None)
    assert s.hidden and moved(s.matrix) == pytest.approx(10)
    # They step away.
    assert not s.update(sure(slide(10, 0)))
    assert not s.hidden


def test_a_camera_moved_too_far_is_not_followed():
    s = Steady(max_shift=0.2, max_turn=4.0)
    for _ in range(3):
        assert not s.update(sure(slide(WIDTH * 0.3, 0)))
    assert s.too_far and (s.matrix == IDENTITY).all()
    for _ in range(3):
        assert not s.update(sure(slide(5, 5, 6.0)))
    assert s.too_far
    s.update(sure(slide(8, 0)))
    assert not s.too_far


def board_picture(rng):
    """A drawn board for OpenCV: wood with knots, two ledges with screws, a strip of tape, dark around it."""
    cv2 = pytest.importorskip("cv2")
    img = np.full((1080, 1920), 28, np.uint8)
    wood = np.clip(110 + rng.normal(0, 7, (1080, 1)) * np.ones((1, 1480)) + rng.normal(0, 3, (1080, 1480)), 0, 255)
    img[:, 300:1780] = wood.astype(np.uint8)
    for x, y, r in [(520, 120, 16), (1310, 240, 22), (640, 560, 14), (1500, 610, 18), (900, 980, 20), (1180, 470, 12)]:
        cv2.circle(img, (x, y), r, 70, -1)
    for y in (350, 870):
        cv2.rectangle(img, (310, y), (1790, y + 16), 190, -1)
        cv2.rectangle(img, (310, y + 16), (1790, y + 180), 128, -1)
        for x in (380, 990, 1420, 1730):
            cv2.circle(img, (x + (y % 97), y + 100), 9, 60, -1)
    cv2.rectangle(img, (990, 0), (1090, 345), 170, -1)
    return cv2.GaussianBlur(img, (0, 0), 1.2)


def test_a_bumped_camera_is_found_and_put_back_even_with_parts_taken_off():
    cv2 = pytest.importorskip("cv2")
    from reup_eye.align import edges, estimate

    rng = np.random.default_rng(5)
    home = board_picture(rng)
    for x in (540, 700, 860):
        cv2.circle(home, (x, 290), 55, 200, 22)
    for x in (400, 552, 722, 880):  # packs side by side, not quite evenly: people put them down by hand
        cv2.rectangle(home, (x, 700), (x + 140, 865), 175, -1)
        cv2.rectangle(home, (x + 20, 720), (x + 120, 760), 90, -1)
    anchor = edges(cv2, home)
    kept = anchor.copy()
    now = home.copy()
    cv2.rectangle(now, (700, 690), (1030, 868), 110, -1)  # two packs taken
    cv2.circle(now, (860, 290), 80, 110, -1)  # and a washer
    now = np.clip(now.astype(float) * 0.8 + rng.normal(0, 3, now.shape), 0, 255).astype(np.uint8)  # a dimmer, noisier room
    for dx, dy, degrees in [(0, 0, 0.0), (24, -16, 0.0), (-60, 36, 0.6), (120, 60, -1.0)]:
        bump = cv2.getRotationMatrix2D((960, 540), degrees, 1.0)
        bump[:, 2] += (dx, dy)
        seen = cv2.warpAffine(now, bump, (1920, 1080), borderMode=cv2.BORDER_REPLICATE)
        found = estimate(cv2, anchor, edges(cv2, seen))
        assert found is not None and found["phase"] > 0.15 and found["match"] > 0.3, (dx, dy, degrees, found)
        back = for_frame(found["matrix"], 1920)
        # Putting the picture back undoes the bump to within a few pixels of a 1920 wide frame.
        undone = np.vstack([back, [0, 0, 1]]) @ np.vstack([bump, [0, 0, 1]])
        assert moved(undone[:2], 1920, 1080) < 8, (dx, dy, degrees, found)
    # Looking never changes the saved home picture, however many looks.
    assert (anchor == kept).all()
    # A picture of something else is not mistaken for the board.
    other = np.clip(rng.normal(120, 40, (1080, 1920)), 0, 255).astype(np.uint8)
    found = estimate(cv2, anchor, edges(cv2, cv2.GaussianBlur(other, (0, 0), 6)))
    assert found is None or found["phase"] < 0.08


def test_the_eye_puts_a_bumped_picture_back_and_counts_wait_until_it_has_looked(tmp_path):
    cv2 = pytest.importorskip("cv2")
    from reup_eye.config import load
    from reup_eye.runtime import Runtime

    logs: list[str] = []
    runtime = Runtime(load(text="[align]\nhold_s = 5"), "http://localhost:1", "t", tmp_path, post=False, log=logs.append)
    rng = np.random.default_rng(9)
    grey = board_picture(rng)
    for x in (540, 700, 860):
        cv2.circle(grey, (x, 290), 55, 200, 22)
    picture = cv2.cvtColor(grey, cv2.COLOR_GRAY2BGR)
    src = runtime.sources["board"]
    src.raw = src.frame = picture
    runtime.eye.still["board"] = True
    # The first still look saves where the camera sits.
    runtime.align_step("board", 0.0)
    assert runtime.home_path("board").exists() and runtime.alignment()["board"]["home"] and "Saved where the board camera sits." in logs
    # A bump: 40 pixels right, 24 down. Something moved, so counts wait.
    bump = np.array([[1.0, 0.0, 40.0], [0.0, 1.0, 24.0]])
    src.raw = cv2.warpAffine(picture, bump, (1920, 1080), borderMode=cv2.BORDER_REPLICATE)
    runtime.eye.unverified.add("board")
    runtime.align_step("board", 1.0)
    assert src.transform is None and "board" in runtime.eye.unverified  # one look is not enough to move the picture
    runtime.align_step("board", 1.2)
    assert src.transform is not None and "moved 4" in logs[-1] and "lined up again" in logs[-1]
    back = src.transform(src.raw)
    middle = (slice(200, 880), slice(400, 1500))
    assert np.abs(back[middle].astype(int) - picture[middle].astype(int)).mean() < 3
    assert np.abs(src.raw[middle].astype(int) - picture[middle].astype(int)).mean() > 6
    assert "board" in runtime.eye.unverified
    runtime.align_step("board", 1.4)
    assert "board" not in runtime.eye.unverified and runtime.alignment()["board"]["moved"] == pytest.approx(40, abs=3)
    # Someone stands in front of the board: counts are held, for at most hold_s.
    src.raw = cv2.GaussianBlur(np.clip(rng.normal(90, 40, (1080, 1920, 3)), 0, 255).astype(np.uint8), (0, 0), 6)
    runtime.align_step("board", 3.0)
    assert "board" not in runtime.eye.hidden
    runtime.align_step("board", 4.1)
    assert "Counts are held" in runtime.eye.hidden["board"] and "Counts are held" in runtime.eye.health()["notes"]["board"]
    runtime.align_step("board", 10.0)
    assert "board" not in runtime.eye.hidden and "Counting goes on" in logs[-1]
    # They step away: the picture is where it was put, nothing is held.
    src.raw = cv2.warpAffine(picture, bump, (1920, 1080), borderMode=cv2.BORDER_REPLICATE)
    runtime.align_step("board", 11.1)
    assert "board" not in runtime.eye.hidden and src.transform is not None
    # The operator moves the camera on purpose and says so: the picture is left alone from here.
    assert runtime.set_home("board") and src.transform is None and runtime.alignment()["board"]["moved"] == 0


def test_nothing_the_camera_sees_is_a_count_until_the_eye_has_checked_where_the_camera_is(tmp_path):
    from .helpers import board, eye, still

    e, _, _ = eye(tmp_path)
    e.pose_check = True
    t = still(e, board({"z-screws": [0, 1, 2]}), 0.0, 1.0)
    assert "z-screws" not in e.counts  # three boxes appeared: that was motion, and nobody has looked yet
    e.pose_verified("board")
    t = still(e, board({"z-screws": [0, 1, 2]}), t, 0.3)
    assert e.counts["z-screws"][0] == 3
    # A hand, then stillness: the board is still, but the count waits for the look.
    hand = [([[0.5, 0.45], [0.7, 0.45], [0.7, 0.65], [0.5, 0.65]], 250)]
    e.analyse("board", board({"z-screws": [0]}, extra=hand), t + 0.1)
    t = still(e, board({"z-screws": [0]}), t + 0.1, 1.0)
    assert e.still["board"] and not e.settled["board"] and e.counts["z-screws"][0] == 3
    e.pose_verified("board")
    t = still(e, board({"z-screws": [0]}), t, 0.3)
    assert e.settled["board"] and e.counts["z-screws"][0] == 1
    # A hidden board holds counts too, and says why.
    e.set_hidden("board", "The board is hidden, or the camera moved a long way. Counts are held.")
    t = still(e, board({"z-screws": []}), t, 1.0)
    assert e.counts["z-screws"][0] == 1 and "hidden" in e.health()["notes"]["board"]
    e.set_hidden("board", None)
    e.pose_verified("board")
    still(e, board({"z-screws": []}), t, 0.3)
    assert e.counts["z-screws"][0] == 0
