"""python3 -m guard --hub https://wheredidallmyinventorygo.wtf   (vision's lines come in on stdin)"""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

from .button import Presses, pin_reader
from .core import Guard
from .hub import Hub

HERE = Path(__file__).resolve().parent.parent


def main() -> None:
    parser = argparse.ArgumentParser(prog="guard", description="The shelf node's ledger, queue and heartbeat.")
    parser.add_argument("--hub", default=os.environ.get("HUB_URL", "http://localhost:3000"))
    parser.add_argument("--data", default=os.environ.get("GUARD_DATA", str(HERE / "data")))
    # The station has no button. One is read only when a pin or a file is named for it.
    parser.add_argument("--button-pin", type=int, default=int(os.environ.get("GUARD_BUTTON_PIN", "-1")))
    args = parser.parse_args()
    log = lambda text: print(f"[guard] {text}", file=sys.stderr, flush=True)  # noqa: E731
    guard = Guard(Path(args.data), Hub(args.hub, os.environ.get("DEVICE_TOKEN", "dev-device-token")), log=log, supervised=os.environ.get("GUARD_SUPERVISED") == "1")
    log(f"Hub: {args.hub}. Ledger: {guard.ledger.path} ({len(guard.ledger.records)} lines). Queued: {len(guard.outbox)}.")

    def sender() -> None:
        while True:
            try:
                guard.send_step()
            except Exception as err:  # noqa: BLE001  the sender must never die
                log(f"Sender error: {err}")
            guard.wake.wait(0.25)
            guard.wake.clear()

    def button() -> None:
        path = os.environ.get("GUARD_BUTTON_FILE", "")
        if args.button_pin < 0 and not path:
            return
        down = pin_reader(args.button_pin, path, log)
        presses = Presses()
        began = time.monotonic()
        rested = said = False
        while down is not None:
            now = time.monotonic()
            is_down = down()
            rested = rested or not is_down
            if presses.look(is_down, now):
                try:
                    guard.on_button()
                except Exception as err:  # noqa: BLE001
                    log(f"Button error: {err}")
            # Said once: a pin that has read pressed since the start is not a button being held.
            if not rested and not said and now - began > 5:
                log(f"The button's pin ({args.button_pin}) has read pressed since the start. It is ignored until it rests. Approve on the screen.")
                said = True
            time.sleep(0.02)

    threading.Thread(target=sender, daemon=True).start()
    threading.Thread(target=button, daemon=True).start()
    # The ledger write happens here, on the reading thread, so a slow network never delays it.
    for line in sys.stdin:
        guard.on_line(line)
    # stdin closed: vision is gone and nobody will start it again. Keep the heartbeat and the button alive.
    while True:
        time.sleep(1)


if __name__ == "__main__":
    main()
