"""Settings for the eye: defaults here, overrides in services/eye/config.toml."""
from __future__ import annotations

import copy
import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Optional

FULL = [[0.0, 0.0], [1.0, 0.0], [1.0, 1.0], [0.0, 1.0]]

DEFAULTS: dict = {
    "eye": {"hub": "http://localhost:3000", "port": 8089, "public_host": "localhost", "analysis_hz": 10, "small_factor": 4, "stream_width": 1280, "stream_fps": 30, "stream_quality": 72, "zones_every_s": 2},
    "cameras": {
        "board": {"name": "", "index": 0, "width": 1920, "height": 1080, "fps": 30, "board": FULL},
        "aux": {"name": "", "index": 1, "width": 1920, "height": 1080, "fps": 30, "board": FULL},
    },
    "pockets": {"threshold": 18.0, "inset": 0.18, "samples": 12},
    "settle": {"still_ms": 500, "motion_pixel": 10.0, "motion_limit": 0.004, "keepalive_s": 30},
    "open": {"detector": "auto", "model": "yoloe-26s-seg.pt", "imgsz": 960, "conf": 0.25, "hz": 4, "hold": 3, "grid": 64, "blob_pixel": 26.0, "min_area": 0.012},
    "teach": {"zone": "z-teach", "camera": "aux", "quad": [[0.2, 0.15], [0.8, 0.15], [0.8, 0.85], [0.2, 0.85]], "hold_s": 1.0, "clear_s": 2.0, "share": 0.02},
}
CAMERA_DEFAULT = {"name": "", "index": 0, "width": 1920, "height": 1080, "fps": 30, "board": FULL}


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


def resolve_index(name: str, index: int, names: Optional[list[str]]) -> tuple[int, Optional[str]]:
    """Picks the camera index: the one whose device name contains name, else the configured index. Second value is a note to log."""
    if not name:
        return index, None
    if names is None:
        return index, f"Cannot list camera names on this machine, so '{name}' uses index {index}."
    for i, device in enumerate(names):
        if name.lower() in device.lower():
            return i, None
    return index, f"No camera is named '{name}'. Using index {index}. Found: {', '.join(names) or 'none'}."
