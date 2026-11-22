#!/usr/bin/env python3
"""Sets the size and format the Pi's USB camera starts in, in the QNX sensor config. Run on the Pi, with sudo.

The workshop program opens the camera read only, so it takes whatever the sensor service starts the camera in, and
the image ships with no size for the USB camera (it comes up at 640x360). This writes one for SENSOR_UNIT_5.

Why 1280x720 NV12: the camera sends uncompressed pictures and the USB link on QNX carries about 8 MB of them a second.
Measured on the Pi 5 with an Elgato Facecam MK.2: 640x360 YCbYCr 17.4 a second, 1920x1080 YCbYCr 1.9, 1280x720 NV12 5.9.
720p keeps the parts sharp enough to count and the hand model fed.

Usage: sudo python3 set_camera.py [--size 1280x720] [--format nv12] [--unit 5] [--config PATH] [--undo]
Then restart the sensor service, or the Pi. The first run keeps the original beside the config as <name>.orig.
"""
from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path

CONFIG = "/etc/config/sensor/sensor_rpi5.conf"


def with_camera(text: str, unit: int, width: int, height: int, fmt: str) -> str:
    """The config text with this unit's default size and format set. Raises ValueError when the unit is not there."""
    block = re.search(rf"(^begin SENSOR_UNIT_{unit}\b.*?^end SENSOR_UNIT_{unit}\b)", text, re.S | re.M)
    if not block:
        raise ValueError(f"SENSOR_UNIT_{unit} is not in the config.")
    lines = [line for line in block.group(1).split("\n") if not re.match(r"\s*default_video_(resolution|format)\s*=", line)]
    indent = re.match(r"\s*", lines[1]).group(0) if len(lines) > 2 else "    "
    lines[-1:-1] = [f"{indent}default_video_format = {fmt}", f"{indent}default_video_resolution = {width}, {height}"]
    return text[: block.start()] + "\n".join(lines) + text[block.end():]


def main() -> int:
    parser = argparse.ArgumentParser(description="Set the USB camera's size and format in the QNX sensor config.")
    parser.add_argument("--size", default="1280x720")
    parser.add_argument("--format", default="nv12")
    parser.add_argument("--unit", type=int, default=5)
    parser.add_argument("--config", default=CONFIG)
    parser.add_argument("--undo", action="store_true", help="put the original config back")
    args = parser.parse_args()
    config = Path(args.config)
    keep = config.with_name(config.name + ".orig")
    if args.undo:
        if not keep.exists():
            print(f"No original at {keep}. Nothing changed.")
            return 1
        shutil.copyfile(keep, config)
        print(f"Put {keep.name} back. Restart the sensor service, or the Pi.")
        return 0
    try:
        width, height = (int(n) for n in args.size.lower().split("x"))
        text = config.read_text(encoding="ascii")
        new = with_camera(text, args.unit, width, height, args.format)
    except (OSError, ValueError) as err:
        print(f"Not changed: {err}")
        return 1
    if new == text:
        print(f"Already {width}x{height} {args.format}.")
        return 0
    if not keep.exists():
        shutil.copyfile(config, keep)
    config.write_text(new, encoding="ascii")
    print(f"SENSOR_UNIT_{args.unit} now starts at {width}x{height} {args.format}. Restart the sensor service, or the Pi.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
