"""python -m reup_eye --hub http://localhost:3000"""
from __future__ import annotations

import argparse
import os
import time
from pathlib import Path

from .config import load

HERE = Path(__file__).resolve().parent.parent


def list_cameras() -> None:
    """Prints the cameras by name. Opens none of them, so no webcam light comes on."""
    from .runtime import BACKEND_NAMES, camera_listings  # noqa: PLC0415

    for backend, names in camera_listings():
        label = BACKEND_NAMES.get(backend, str(backend))
        if names is None:
            print(f"{label}: cannot list camera names here. Install cv2-enumerate-cameras.")
            continue
        for index, name in sorted(names.items()):
            print(f"{label} index {index}: {name}")
        if not names:
            print(f"{label}: no cameras.")


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
    if args.sim:
        print("Drawn board, not the cameras. Development only.")
    else:
        print(f"Clear the board, then save the empty board with: curl -X POST http://localhost:{config.eye.port}/reference/board")
        print(f"Fill the board, then save the full board with: curl -X POST http://localhost:{config.eye.port}/full/board")
    runtime.start()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        runtime.stop()


if __name__ == "__main__":
    main()
