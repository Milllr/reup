"""python -m reup_eye --hub http://localhost:3000"""
from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

from .config import load

HERE = Path(__file__).resolve().parent.parent


def list_cameras() -> None:
    import cv2  # noqa: PLC0415

    from .runtime import camera_names  # noqa: PLC0415

    names = camera_names()
    for index in range(6):
        capture = cv2.VideoCapture(index, cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY)
        if capture.isOpened():
            ok, frame = capture.read()
            size = f"{frame.shape[1]} by {frame.shape[0]}" if ok and frame is not None else "no picture"
            print(f"index {index}: {names[index] if names and index < len(names) else 'camera'}, {size}")
        capture.release()


def main() -> None:
    parser = argparse.ArgumentParser(prog="reup_eye", description="Counts the parts board from the laptop cameras.")
    parser.add_argument("--hub", default=os.environ.get("HUB_URL"), help="The hub, for example http://localhost:3000")
    parser.add_argument("--config", default=str(HERE / "config.toml"))
    parser.add_argument("--port", type=int)
    parser.add_argument("--sim", action="store_true", help="Draw a board in place of the cameras. Development only.")
    parser.add_argument("--no-post", action="store_true", help="Count and stream, but send nothing to the hub.")
    parser.add_argument("--list-cameras", action="store_true")
    args = parser.parse_args()
    if args.list_cameras:
        return list_cameras()

    from .runtime import Runtime, default_token  # noqa: PLC0415

    config = load(Path(args.config))
    if args.port:
        config.eye.port = args.port
    hub = args.hub or config.eye.hub
    runtime = Runtime(config, hub, default_token(), HERE / "data" / ("sim" if args.sim else ""), sim=args.sim, post=not args.no_post)
    print(f"Hub: {hub}")
    print(f"Stream: {runtime.stream_url('board')}")
    print(f"Debug picture: http://localhost:{config.eye.port}/debug/board.jpg")
    print("Drawn board, not the cameras. Development only." if args.sim else "Clear the board, then save the empty board with: curl -X POST http://localhost:%d/reference/board" % config.eye.port)
    runtime.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        runtime.stop()


if __name__ == "__main__":
    main()
