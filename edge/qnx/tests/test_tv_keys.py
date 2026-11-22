"""Keys for the Pi's screen: the bytes that go to QNX's VNC server."""
import importlib.util
import struct
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location("tv_keys", Path(__file__).resolve().parent.parent / "tv" / "keys.py")
keys = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keys)


def key(down: int, sym: int) -> bytes:
    return struct.pack(">BBHI", 4, down, 0, sym)


def test_a_chord_goes_down_in_order_and_comes_up_in_reverse():
    assert keys.messages("alt+tab") == [key(1, 0xFFE9), key(1, 0xFF09), key(0, 0xFF09), key(0, 0xFFE9)]
    assert keys.messages("F11") == [key(1, 0xFFC8), key(0, 0xFFC8)]


def test_a_click_is_a_move_a_press_and_a_release_at_that_point():
    assert keys.messages("click:512,310") == [struct.pack(">BBHH", 5, mask, 512, 310) for mask in (0, 1, 0)]


def test_text_is_typed_as_it_is_and_an_unknown_key_is_refused():
    assert keys.messages("text:Hi") == [key(1, ord("H")), key(0, ord("H")), key(1, ord("i")), key(0, ord("i"))]
    with pytest.raises(ValueError):
        keys.messages("hyper+tab")


def test_the_desktop_is_told_never_to_lock_or_sleep():
    spec2 = importlib.util.spec_from_file_location("desktop_ini", Path(__file__).resolve().parent.parent / "tv" / "desktop_ini.py")
    ini = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(ini)
    text = "[core]\nmodules=screen-share.so\n\n[shell]\nlocking=true\nanimation=zoom\nlocking=true\n"
    out = ini.awake(text)
    assert out == "[core]\nidle-time=0\nmodules=screen-share.so\n\n[shell]\nlocking=false\nanimation=zoom\nlocking=false\n"
    assert ini.awake(out) == out
    assert ini.awake("[shell]\nlocking=true\n").startswith("[core]\nidle-time=0\n\n[shell]\nlocking=false")
    assert ini.awake("[core]\nidle-time=300\n") == "[core]\nidle-time=0\n"
