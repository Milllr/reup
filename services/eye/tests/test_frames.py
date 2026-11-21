import numpy as np
import pytest

from reup_eye.config import load, resolve_index
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


def test_a_camera_is_chosen_by_name_and_falls_back_to_its_index():
    names = ["Integrated Webcam", "Elgato Facecam", "HD Pro Webcam C920"]
    assert resolve_index("facecam", 0, names) == (1, None)
    assert resolve_index("C920", 0, names) == (2, None)
    index, note = resolve_index("Brio", 3, names)
    assert index == 3 and "No camera is named 'Brio'" in note
    assert resolve_index("", 5, None) == (5, None)
    assert resolve_index("C920", 1, None)[0] == 1
