#!/usr/bin/env python3
"""Turns off the lock and the sleep of the QNX desktop (weston.ini). Usage: python3 desktop_ini.py ~/.config/weston.ini"""
from __future__ import annotations

import re
import sys


def awake(text: str) -> str:
    """The ini text with idle-time=0 under [core] and every locking line set to false. Run twice, it changes nothing more."""
    text = re.sub(r"(?m)^locking[ \t]*=[ \t]*true[ \t]*$", "locking=false", text)
    if re.search(r"(?m)^idle-time[ \t]*=", text):
        return re.sub(r"(?m)^idle-time[ \t]*=.*$", "idle-time=0", text)
    if re.search(r"(?m)^\[core\][ \t]*$", text):
        return re.sub(r"(?m)^\[core\][ \t]*$", "[core]\nidle-time=0", text, count=1)
    return "[core]\nidle-time=0\n\n" + text


if __name__ == "__main__":
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        old = f.read()
    with open(path, "w", encoding="utf-8") as f:
        f.write(awake(old))
