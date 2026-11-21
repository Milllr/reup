"""The outbox: what the hub has not accepted yet, on disk, in the order it happened."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Callable

OK, RETRY, DROP = "ok", "retry", "drop"


class Outbox:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.items: list[dict] = []
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                try:
                    self.items.append(json.loads(line))
                except ValueError:
                    break

    def __len__(self) -> int:
        return len(self.items)

    def put(self, route: str, body: dict) -> None:
        item = {"route": route, "body": body}
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(item, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        self.items.append(item)

    def _rewrite(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            for item in self.items:
                f.write(json.dumps(item, separators=(",", ":")) + "\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.path)

    def drain(self, send: Callable[[str, dict], str]) -> int:
        """Sends from the front, in order. Stops at the first one the hub cannot take right now. Returns how many left."""
        done = 0
        while done < len(self.items):
            result = send(self.items[done]["route"], self.items[done]["body"])
            if result == RETRY:
                break
            # OK, or DROP: the hub said this body will never be accepted, so it must not block everything behind it.
            done += 1
        if done:
            self.items = self.items[done:]
            self._rewrite()
        return done
