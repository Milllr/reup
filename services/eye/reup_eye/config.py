"""Settings for the eye: defaults here, overrides in services/eye/config.toml."""
from __future__ import annotations

import copy
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

FULL = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]

DEFAULTS: dict = {
    "eye": {"hub": "http://localhost:3000", "port": 8089, "public_host": "localhost", "analysis_hz": 10, "small_factor": 4, "stream_width": 1280, "stream_fps": 30, "stream_quality": 72, "zones_every_s": 2, "board_pad": 0.04},
    "cameras": {
        "board": {"name": "", "index": 0, "width": 1920, "height": 1080, "fps": 30, "board": FULL, "enabled": True},
        # The station as built has one camera. A second one is opened only when config.toml turns it on.
        "aux": {"name": "", "index": 1, "width": 1920, "height": 1080, "fps": 30, "board": FULL, "enabled": False},
    },
    "pockets": {"threshold": 18.0, "inset": 0.18, "samples": 12},
    "settle": {"still_ms": 500, "motion_pixel": 10.0, "motion_limit": 0.004, "motion_block": 4, "keepalive_s": 30},
    "open": {"detector": "auto", "model": "yoloe-26s-seg.pt", "imgsz": 960, "conf": 0.3, "hz": 8, "hold": 3, "grid": 64, "blob_pixel": 26.0, "min_area": 0.012, "unit_floor": 0.3, "wrong_hold": 8, "wrong_conf": 0.4},
    "align": {"enabled": True, "every_s": 1.0, "min_phase": 0.1, "min_match": 0.3, "hidden_phase": 0.06, "dead_px": 2.0, "max_shift": 0.2, "max_turn": 4.0, "verify_s": 3.0, "hold_s": 15.0},
    "teach": {"zone": "z-teach", "camera": "board", "quad": [[0.76, 0.6], [0.92, 0.6], [0.92, 0.92], [0.76, 0.92]], "hold_s": 1.5, "clear_s": 2.0, "share": 0.004, "rebase_s": 20.0, "hue": 0.06, "darker": 0.35, "brighter": 2.5, "reach": 0.2, "fine": 2, "view": 0.15},
}
CAMERA_DEFAULT = {"name": "", "index": 0, "width": 1920, "height": 1080, "fps": 30, "board": FULL, "enabled": True}


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for key, value in over.items():
        out[key] = _merge(out[key], value) if isinstance(value, dict) and isinstance(out.get(key), dict) else value
    return out


def load(path: Optional[Path] = None, text: Optional[str] = None) -> SimpleNamespace:
    """The settings as config.eye.port, config.cameras["board"].index and so on. A missing file means the defaults."""
    raw: dict = {}
    if text is not None:
        raw = tomllib.loads(text)
    elif path is not None and Path(path).exists():
        raw = tomllib.loads(Path(path).read_text(encoding="utf-8"))
    merged = _merge(DEFAULTS, raw)
    for name, cam in list(merged["cameras"].items()):
        merged["cameras"][name] = _merge(CAMERA_DEFAULT, cam)
    out = SimpleNamespace(**{section: SimpleNamespace(**values) for section, values in merged.items() if section != "cameras"})
    out.cameras = {name: SimpleNamespace(id=name, **cam) for name, cam in merged["cameras"].items()}
    return out


def camera_ways(name: str, index: int, listings: list) -> tuple[list[tuple[object, int]], Optional[str]]:
    """Where to open a camera, in the order to try: (backend, index) pairs, and a note to log.

    listings holds one (backend, {index: device name}) for each capture backend, with None for the names when that
    backend cannot list them. A camera chosen by name is only ever opened under that name. When it is unplugged, or the
    names cannot be read, nothing is opened in its place, so the eye never ends up looking through a built in webcam.
    """
    if not name:
        return [(backend, index) for backend, _names in listings], None
    ways, found, listed = [], [], False
    for backend, names in listings:
        if names is None:
            continue
        listed = True
        found.extend(device for _i, device in sorted(names.items()) if device not in found)
        match = next((i for i, device in sorted(names.items()) if name.lower() in device.lower()), None)
        if match is not None:
            ways.append((backend, match))
    if ways:
        return ways, None
    if not listed:
        return [], f"Cannot list camera names on this machine, so the camera named '{name}' is not opened. Install cv2-enumerate-cameras, or clear the name in config.toml to use index {index}."
    return [], f"No camera is named '{name}'. Found: {', '.join(found) or 'none'}. Nothing is opened in its place."
