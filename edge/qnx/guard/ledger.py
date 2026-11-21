"""The ledger: one JSON line for every thing the shelf node saw or decided, on disk before anything else happens.

A line is written and fsynced before it is sent anywhere. If the power goes mid write, the torn last line is dropped
on the next start and nothing before it is lost.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path


class Ledger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.records = self._replay()
        # The epoch is in every id, so ids from a new ledger never collide with ones the hub has already seen.
        first = self.records[0] if self.records else None
        self.epoch = first["epoch"] if first and first.get("kind") == "opened" else None
        self.counters: dict[str, int] = {}
        for record in self.records:
            prefix, _, tail = str(record.get("id", "")).rpartition("-")
            if tail.isdigit():
                key = prefix.split("-")[0]
                self.counters[key] = max(self.counters.get(key, 0), int(tail))
        if self.epoch is None:
            self.epoch = _base36(int(time.time()))
            self.append({"kind": "opened", "epoch": self.epoch})

    def _replay(self) -> list[dict]:
        """Every whole line in the file. A torn last line is cut off the file so the next append starts clean."""
        if not self.path.exists():
            return []
        raw = self.path.read_bytes()
        good_until, records = 0, []
        for line in raw.splitlines(keepends=True):
            if not line.endswith(b"\n"):
                break
            try:
                records.append(json.loads(line))
            except ValueError:
                break
            good_until += len(line)
        if good_until != len(raw):
            with open(self.path, "r+b") as f:
                f.truncate(good_until)
                f.flush()
                os.fsync(f.fileno())
        return records

    def next_id(self, prefix: str) -> str:
        """rc for reaches, pk for picks, ro for reorder calls. Counts on from what is already in the ledger."""
        self.counters[prefix] = self.counters.get(prefix, 0) + 1
        return f"{prefix}-{self.epoch}-{self.counters[prefix]:04d}"

    def append(self, record: dict) -> dict:
        line = (json.dumps(record, separators=(",", ":")) + "\n").encode("utf-8")
        with open(self.path, "ab") as f:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())
        self.records.append(record)
        return record


def _base36(n: int) -> str:
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out = ""
    while n:
        n, r = divmod(n, 36)
        out = digits[r] + out
    return out or "0"
