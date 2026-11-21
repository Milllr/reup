"""Starts vision and the guard as two processes and starts either again within a second if it exits.

Usage: python3 supervisor.py --vision "<command>" --guard "<command>"
Vision's stdout goes to the guard's stdin through one pipe that the supervisor keeps open, so a restart of either
side loses no line: what vision wrote waits in the pipe until a guard reads it.
Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Optional

RESTART_S = 0.25


class Supervisor:
    def __init__(self, vision: list[str], guard: list[str], data_dir: Path, spawn: Callable = subprocess.Popen, clock: Callable[[], float] = time.monotonic, log: Callable[[str], None] = print, env: Optional[dict] = None):
        self.commands = {"vision": vision, "guard": guard}
        self.data_dir = Path(data_dir)
        self.spawn = spawn
        self.clock = clock
        self.log = log
        self.env = {**(env if env is not None else os.environ), "GUARD_SUPERVISED": "1", "GUARD_DATA": str(self.data_dir)}
        self.read_fd, self.write_fd = os.pipe()
        self.children: dict[str, Optional[subprocess.Popen]] = {"vision": None, "guard": None}
        self.died_at: dict[str, float] = {}
        self.restarts = {"vision": 0, "guard": 0}
        self.stopping = False
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self._save()

    def _save(self) -> None:
        tmp = self.data_dir / "restarts.json.tmp"
        tmp.write_text(json.dumps(self.restarts), encoding="utf-8")
        tmp.replace(self.data_dir / "restarts.json")

    def _start(self, name: str) -> None:
        pipes = {"stdout": self.write_fd} if name == "vision" else {"stdin": self.read_fd}
        self.children[name] = self.spawn(self.commands[name], env=self.env, **pipes)
        self.log(f"Started {name} (pid {self.children[name].pid}).")

    def step(self) -> None:
        """Starts what is not running. Call it a few times a second."""
        if self.stopping:
            return
        now = self.clock()
        for name, child in self.children.items():
            if child is not None and child.poll() is None:
                continue
            if child is not None and name not in self.died_at:
                self.died_at[name] = now
                self.log(f"{name} exited with code {child.returncode}. Starting it again.")
            if child is None or now - self.died_at[name] >= RESTART_S:
                if child is not None:
                    self.restarts[name] += 1
                    self._save()
                    self.died_at.pop(name, None)
                self._start(name)

    def stop(self) -> None:
        self.stopping = True
        for child in self.children.values():
            if child is not None and child.poll() is None:
                child.terminate()
        deadline = time.monotonic() + 3
        for child in self.children.values():
            if child is None:
                continue
            try:
                child.wait(max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()

    def run(self) -> None:
        signal.signal(signal.SIGTERM, lambda *_: self.stop())
        signal.signal(signal.SIGINT, lambda *_: self.stop())
        while not self.stopping:
            self.step()
            time.sleep(0.1)


def main() -> None:
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Keeps vision and the guard running.")
    parser.add_argument("--vision", required=True, help="The command that starts vision, in quotes.")
    parser.add_argument("--guard", default=f"{shlex.quote(sys.executable)} -m guard", help="The command that starts the guard.")
    parser.add_argument("--data", default=os.environ.get("GUARD_DATA", str(here / "data")))
    args = parser.parse_args()
    log = lambda text: print(f"[supervisor] {text}", file=sys.stderr, flush=True)  # noqa: E731
    Supervisor(shlex.split(args.vision), shlex.split(args.guard), Path(args.data), log=log).run()


if __name__ == "__main__":
    main()
