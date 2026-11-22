"""The camera's size in the QNX sensor config: one unit changed, everything else left as it was."""
import importlib.util
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("set_camera", Path(__file__).resolve().parent.parent / "vision" / "set_camera.py")
set_camera = importlib.util.module_from_spec(spec)
spec.loader.exec_module(set_camera)

CONF = """begin SENSOR_UNIT_1
    type = file_camera
    default_video_format = ycbycr
    default_video_resolution = 1920, 1080
end SENSOR_UNIT_1

begin SENSOR_UNIT_5
    type = usb_camera
    name = front-camera
    default_video_framerate = 30
    address = /dev/usb/io-usb-otg, -1, -1, -1, -1
end SENSOR_UNIT_5
"""


def test_the_usb_camera_gets_a_size_and_a_format_and_no_other_unit_changes():
    out = set_camera.with_camera(CONF, 5, 1280, 720, "nv12")
    unit5 = out[out.index("begin SENSOR_UNIT_5"):]
    assert "    default_video_format = nv12\n    default_video_resolution = 1280, 720\nend SENSOR_UNIT_5" in unit5
    assert "default_video_framerate = 30" in unit5 and "address = /dev/usb/io-usb-otg" in unit5
    assert out[: out.index("begin SENSOR_UNIT_5")] == CONF[: CONF.index("begin SENSOR_UNIT_5")]
    # Run again, or with another size: one line of each, never two.
    again = set_camera.with_camera(set_camera.with_camera(out, 5, 1920, 1080, "ycbycr"), 5, 1280, 720, "nv12")
    assert again == out
    with pytest.raises(ValueError):
        set_camera.with_camera(CONF, 7, 1280, 720, "nv12")
