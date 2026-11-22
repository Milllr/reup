#!/usr/bin/env python3
"""Presses keys and clicks on the Pi's screen from a shell: at the table the Pi has a mouse and no keyboard.

It starts QNX's own VNC server (vncserv) on a spare port for as long as the keys take, sends them, and stops it again.
The picture is 1024 wide on the station's TV, so a click is given in that picture's pixels.

Usage: sudo python3 keys.py alt+tab      the next window of the QNX window switcher
       sudo python3 keys.py f11          full screen in the browser, and out of it again
       sudo python3 keys.py click:512,310
       sudo python3 keys.py text:hello enter
"""
from __future__ import annotations

import socket
import struct
import subprocess
import sys
import time

KEYS = {
    "alt": 0xFFE9, "ctrl": 0xFFE3, "shift": 0xFFE1, "tab": 0xFF09, "enter": 0xFF0D, "esc": 0xFF1B, "space": 0x20,
    "left": 0xFF51, "up": 0xFF52, "right": 0xFF53, "down": 0xFF54, "delete": 0xFFFF, "backspace": 0xFF08,
    **{f"f{n}": 0xFFBD + n for n in range(1, 13)},
}
PORT = 5907


def messages(step: str) -> list[bytes]:
    """The VNC messages for one step, in the order to send them. Raises ValueError for a step it does not know."""
    if step.startswith("click:"):
        x, y = (int(n) for n in step[6:].split(","))
        return [struct.pack(">BBHH", 5, mask, x, y) for mask in (0, 1, 0)]
    if step.startswith("text:"):
        return [struct.pack(">BBHI", 4, down, 0, ord(ch)) for ch in step[5:] for down in (1, 0)]
    keys = []
    for name in step.lower().split("+"):
        if name in KEYS:
            keys.append(KEYS[name])
        elif len(name) == 1:
            keys.append(ord(name))
        else:
            raise ValueError(f"No key called {name!r}.")
    return [struct.pack(">BBHI", 4, 1, 0, k) for k in keys] + [struct.pack(">BBHI", 4, 0, 0, k) for k in reversed(keys)]


def connect(port: int) -> socket.socket:
    s = socket.create_connection(("127.0.0.1", port), timeout=5)
    s.recv(12)
    s.sendall(b"RFB 003.008\n")
    kinds = s.recv(s.recv(1)[0])
    if 1 not in kinds:
        raise SystemExit(f"The VNC server wants a password (it offers {list(kinds)}).")
    s.sendall(b"\x01")
    if struct.unpack(">I", s.recv(4))[0] != 0:
        raise SystemExit("The VNC server said no.")
    s.sendall(b"\x01")
    head = s.recv(24)
    s.recv(struct.unpack(">I", head[20:24])[0])
    return s


def main(steps: list[str]) -> int:
    try:
        plan = [messages(step) for step in steps]
    except ValueError as err:
        print(err)
        return 2
    server = subprocess.Popen(["vncserv", "-display=1", f"-port={PORT}", "-verbose"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        s = None
        for _ in range(40):
            try:
                s = connect(PORT)
                break
            except OSError:
                time.sleep(0.1)
        if s is None:
            print("The VNC server did not start. Run this with sudo.")
            return 1
        for step in plan:
            for message in step:
                s.sendall(message)
                time.sleep(0.1)
            time.sleep(0.4)
        s.close()
        return 0
    finally:
        server.terminate()
        try:
            server.wait(3)
        except subprocess.TimeoutExpired:
            server.kill()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
