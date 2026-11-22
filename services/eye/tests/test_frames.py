import numpy as np
import pytest

from reup_eye.config import camera_ways, load
from reup_eye.frames import FpsMeter, FrameSource, ReferenceStore, sample, small_colour


def test_the_small_picture_averages_blocks_and_keeps_colour():
    frame = np.zeros((8, 8, 3), dtype=np.uint8)
    frame[:4, :4] = (255, 255, 255)
    frame[4:, 4:, 2] = 200
    frame[4, 4, 2] = 40
    small = small_colour(frame, 4)
    assert small.shape == (2, 2, 3)
    assert small[0, 0].tolist() == [255, 255, 255] and small[0, 1].tolist() == [0, 0, 0]
    assert small[1, 1].tolist() == [0, 0, 190]
    assert small_colour(np.full((8, 8), 7, np.uint8), 4).shape == (2, 2, 3)


def test_a_part_as_bright_as_the_board_but_another_colour_is_still_seen():
    from reup_eye.counting import pocket_levels, pockets_full

    wood, box = np.array([96.0, 142, 178]), np.array([200.0, 150, 122])
    assert abs(wood @ [0.114, 0.587, 0.299] - box @ [0.114, 0.587, 0.299]) < 1  # the same grey
    ref = np.tile(wood, (2, 50, 1))
    cur = ref.copy()
    cur[1] = box
    assert pockets_full(pocket_levels(cur, ref), 18) == [False, True]


def test_block_mean_averages_noise_away_and_keeps_a_hand():
    from reup_eye.frames import block_mean

    rng = np.random.default_rng(7)
    still = np.full((88, 160, 3), 60.0)
    noisy = still + rng.normal(0, 6, still.shape)
    assert (np.abs(noisy - still).max(axis=-1) > 10).mean() > 0.1  # a dim room: one pixel in ten is off by a hand's worth
    assert (np.abs(block_mean(noisy, 4) - block_mean(still, 4)).max(axis=-1) > 10).mean() == 0
    hand = still.copy()
    hand[20:60, 40:80] = 170
    assert (np.abs(block_mean(hand, 4) - block_mean(still, 4)).max(axis=-1) > 10).mean() > 0.05
    assert block_mean(still, 4).shape == (22, 40, 3) and block_mean(still, 1) is still


def test_sampling_reads_between_pixels():
    img = np.array([[0.0, 10.0], [20.0, 30.0]], dtype=np.float32)
    pts = np.array([[0.0, 0.0], [1.0, 1.0], [0.5, 0.5], [1.0, 0.0]])
    assert sample(img, pts) == pytest.approx([0, 30, 15, 10])
    colour = np.stack([img, img * 2, img * 0], axis=2)
    assert sample(colour, pts) == pytest.approx(np.array([[0, 0, 0], [30, 60, 0], [15, 30, 0], [10, 20, 0]]))
    assert sample(colour, pts.reshape(2, 2, 2)).shape == (2, 2, 3)


def test_camera_health_reports_fps_over_a_2_second_window():
    meter = FpsMeter(2.0)
    for i in range(90):
        meter.tick(i / 30)
    assert meter.fps(89 / 30) == pytest.approx(30, abs=1)
    assert meter.fps(89 / 30 + 5) == 0


class FakeCapture:
    def __init__(self, frames):
        self.frames = list(frames)
        self.released = False

    def read(self):
        return (True, self.frames.pop(0)) if self.frames else (False, None)

    def release(self):
        self.released = True


def test_the_frame_source_falls_back_and_retries_when_open_fails():
    clock = {"t": 0.0}
    opened = []
    captures = {1: [FakeCapture([np.zeros((2, 2, 3), np.uint8)] * 2), FakeCapture([np.ones((2, 2, 3), np.uint8)])]}

    def opener(index):
        opened.append(index)
        return captures[index].pop(0) if captures.get(index) else None

    src = FrameSource("board", [0, 1], opener, clock=lambda: clock["t"])
    assert src.step() is True  # index 0 will not open, index 1 does
    assert opened == [0, 1] and src.opened_index == 1 and src.online
    assert src.step() is True
    first = src.capture
    # The camera is unplugged: reads fail. Within 3 seconds it is reported offline and released.
    clock["t"] = 1.0
    assert src.step() is False
    clock["t"] = 2.0
    assert src.step() is False
    assert first.released and not src.online and src.fps() == 0.0
    # It does not hammer the driver: nothing is opened again until the retry time.
    opened.clear()
    clock["t"] = 2.5
    src.step()
    assert opened == []
    # Plugged back in: it opens again by itself.
    clock["t"] = 3.5
    assert src.step() is True and src.online and src.frame.max() == 1


def test_a_saved_reference_loads_back_identical(tmp_path):
    store = ReferenceStore(tmp_path / "data")
    img = np.random.default_rng(1).random((90, 160)).astype(np.float32) * 255
    assert store.load("board") is None
    store.save("board", img)
    assert np.array_equal(ReferenceStore(tmp_path / "data").load("board"), img)


def test_config_loads_camera_names_indexes_and_the_stream_port_with_defaults(tmp_path):
    assert load(tmp_path / "missing.toml").eye.port == 8089
    c = load(text='[eye]\nport = 9000\n[cameras.board]\nname = "Elgato Facecam"\nindex = 2\n[cameras.side]\nindex = 4\n[pockets]\nthreshold = 25')
    assert c.eye.port == 9000 and c.eye.public_host == "localhost" and c.eye.analysis_hz == 10
    assert (c.cameras["board"].name, c.cameras["board"].index, c.cameras["board"].width) == ("Elgato Facecam", 2, 1920)
    assert (c.cameras["aux"].index, c.cameras["side"].index, c.cameras["side"].fps) == (1, 4, 30)
    assert c.pockets.threshold == 25 and c.pockets.inset == 0.18 and c.settle.still_ms == 500


def test_the_shipped_config_file_loads():
    from pathlib import Path

    c = load(Path(__file__).resolve().parents[1] / "config.toml")
    assert c.cameras["board"].name == "Elgato Facecam" and c.cameras["aux"].name == "C920" and c.teach.zone == "z-teach"
    # The station as built: one camera, and the teach spot is a patch of the board.
    assert c.cameras["board"].enabled and not c.cameras["aux"].enabled and c.teach.camera == "board"


def test_the_second_camera_is_off_unless_the_config_turns_it_on():
    assert not load(text="").cameras["aux"].enabled
    assert load(text='[cameras.aux]\nenabled = true\nname = "C920"').cameras["aux"].enabled
    assert load(text="[cameras.side]\nindex = 4").cameras["side"].enabled


def test_a_camera_is_chosen_by_name_in_each_backends_own_numbering():
    # The laptop at the table: the two Windows backends list the same cameras, and DirectShow adds two virtual ones.
    mf = {0: "Camo", 1: "Integrated Webcam", 2: "Elgato Facecam MK.2 (USB2)", 3: "Windows Virtual Camera"}
    ds = {0: "Camo", 1: "OBS Virtual Camera", 2: "Integrated Webcam", 3: "Elgato Facecam MK.2 (USB2)"}
    assert camera_ways("Elgato Facecam", 0, [("mf", mf), ("ds", ds)]) == ([("mf", 2), ("ds", 3)], None)
    assert camera_ways("facecam", 0, [("mf", {0: "Camo"}), ("ds", ds)]) == ([("ds", 3)], None)
    # No name: the index, on every backend.
    assert camera_ways("", 5, [("mf", mf), ("ds", None)]) == ([("mf", 5), ("ds", 5)], None)


def test_a_named_camera_that_is_missing_never_falls_back_to_another_camera():
    builtin = {0: "Integrated Webcam", 1: "Integrated IR Webcam"}
    ways, note = camera_ways("Elgato Facecam", 0, [("mf", builtin), ("ds", builtin)])
    assert ways == [] and "No camera is named 'Elgato Facecam'" in note and "Integrated Webcam, Integrated IR Webcam" in note
    # The names cannot be read at all: still nothing is opened, and the note says what to do.
    ways, note = camera_ways("C920", 1, [("mf", None), ("ds", None)])
    assert ways == [] and "cv2-enumerate-cameras" in note and "index 1" in note


def test_a_camera_plugged_in_late_is_found_by_asking_again_before_every_try():
    clock = {"t": 0.0}
    plugged: list[tuple[str, int]] = []
    opened = []

    def opener(way):
        opened.append(way)
        return FakeCapture([np.zeros((4, 4, 3), np.uint8)] * 3)

    src = FrameSource("board", lambda: list(plugged), opener, clock=lambda: clock["t"])
    assert not src.step() and opened == []
    plugged.append(("mf", 2))
    clock["t"] = 0.5
    assert not src.step() and opened == []  # not yet time to try again
    clock["t"] = 1.1
    assert src.step() and opened == [("mf", 2)] and src.opened_index == ("mf", 2)


def test_a_camera_that_is_turned_off_gets_no_source():
    from pathlib import Path

    from reup_eye.runtime import Runtime

    here = Path(__file__).resolve().parents[1]
    runtime = Runtime(load(here / "config.toml"), "http://localhost:1", "t", here / "data" / "test-none", post=False, log=lambda _m: None)
    assert list(runtime.sources) == ["board"] and runtime.cameras == ["board"]
    assert [c["id"] for c in runtime.camera_health()] == ["board"]
