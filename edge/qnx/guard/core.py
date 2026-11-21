"""The guard: turns what vision saw into ledger lines and posts, keeps a heartbeat, calls for a reorder when the hub is gone.

Three things call into it: the line reader (on_line), the sender (send_step) and the button (on_button).
Everything goes to the ledger first and to the hub second.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import Callable, Optional

from .button import Debounce
from .ledger import Ledger
from .outbox import OK, RETRY, Outbox
from .state import EMPTY, load_json, save_json, zones_text

HEARTBEAT_S = 5.0
HUB_SILENT_S = 10.0
HAND_SEEN_S = 5.0


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def valid_ts(value) -> bool:
    try:
        return isinstance(value, str) and datetime.fromisoformat(value).tzinfo is not None
    except ValueError:
        return False


class Guard:
    def __init__(self, data_dir: Path, hub, clock: Callable[[], float] = time.monotonic, wall: Callable[[], str] = now_iso, log: Callable[[str], None] = print, supervised: bool = False):
        self.dir = Path(data_dir)
        self.hub = hub
        self.clock = clock
        self.wall = wall
        self.log = log
        self.supervised = supervised
        self.lock = threading.RLock()
        self.ledger = Ledger(self.dir / "ledger.jsonl")
        self.outbox = Outbox(self.dir / "outbox.jsonl")
        self.saved = load_json(self.dir / "hub.json", dict(EMPTY))
        self.quads = self._load_quads()
        self.counts: dict[str, int] = {}
        self.open_reach: Optional[str] = None
        self.last_reach: Optional[float] = None
        self.started = clock()
        self.last_ok: Optional[float] = None
        self.connected = False
        self.offline_since: Optional[str] = None
        self.next_heartbeat = 0.0
        self.pockets_on = False
        self.model_on = False
        self.debounce = Debounce(1.0)
        self.crossings: dict[str, dict] = {}
        self.waiting: dict[str, tuple[int, Optional[list[bool]], str]] = {}
        self.wake = threading.Event()
        self._restore()
        self._write_zones()

    # ---------- start up ----------

    def _restore(self) -> None:
        """Picks up where the last run stopped: the last count of every zone, and a crossing that was never called."""
        last_count_at: dict[str, int] = {}
        called_at: dict[str, int] = {}
        for i, r in enumerate(self.ledger.records):
            if r.get("kind") == "count":
                self.counts[r["zoneId"]] = r["count"]
                last_count_at[r["productId"]] = i
            elif r.get("kind") == "reorder":
                called_at[r["productId"]] = i
            elif r.get("kind") == "reach":
                self.open_reach = r["id"] if r["state"] == "start" else None
        if len(self.outbox) == 0:
            return
        for zone in self.saved["zones"]:
            product, rop = zone.get("productId"), self._rop(zone.get("productId"))
            count = self.counts.get(zone["id"])
            if product and rop is not None and count is not None and count <= rop and called_at.get(product, -1) < last_count_at.get(product, -1):
                self.crossings[product] = {"at": self.started, "called": False}

    def _load_quads(self) -> dict[str, list[list[float]]]:
        """Where each zone is in the Pi camera's own picture: data/node-quads.txt, one line a zone: id then eight numbers."""
        out = {}
        try:
            for line in (self.dir / "node-quads.txt").read_text(encoding="utf-8").splitlines():
                parts = line.split()
                if len(parts) == 9 and not line.startswith("#"):
                    v = [float(x) for x in parts[1:]]
                    out[parts[0]] = [[v[0], v[1]], [v[2], v[3]], [v[4], v[5]], [v[6], v[7]]]
        except (OSError, ValueError):
            pass
        return out

    def _write_zones(self) -> None:
        """The zones file vision reads: the hub's zones, with the Pi camera's own quads."""
        mine = [{**z, "quad": self.quads[z["id"]], "camera": "node"} for z in self.saved["zones"] if z["id"] in self.quads]
        text = zones_text(mine)
        path = self.dir / "zones.txt"
        try:
            if path.read_text(encoding="utf-8") == text:
                return
        except OSError:
            pass
        tmp = path.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)

    # ---------- what vision says ----------

    def on_line(self, line: str) -> None:
        line = line.strip()
        if not line.startswith("{"):
            return  # the workshop program prints its own status lines too
        try:
            event = json.loads(line)
            kind = event["type"]
        except (ValueError, KeyError, TypeError):
            self.log(f"Skipped a line that is not an event: {line[:120]}")
            return
        ts = event.get("ts") if valid_ts(event.get("ts")) else self.wall()
        with self.lock:
            if kind == "reach" and event.get("state") in ("start", "end"):
                self._reach(event["state"], event.get("zone"), ts)
            elif kind == "pockets" and isinstance(event.get("pockets"), list) and isinstance(event.get("zone"), str):
                self._pockets(event["zone"], [bool(p) for p in event["pockets"]], ts)
            elif kind == "count" and isinstance(event.get("count"), int) and isinstance(event.get("zone"), str):
                self._count(event["zone"], max(0, event["count"]), None, ts)
            elif kind == "hello":
                self.pockets_on = bool(event.get("pockets"))
                self.model_on = bool(event.get("model"))
            else:
                self.log(f"Skipped an event with a shape the guard does not know: {line[:120]}")
                return
        self.wake.set()

    def _reach(self, state: str, zone: Optional[str], ts: str) -> None:
        rid = self.ledger.next_id("rc") if state == "start" or not self.open_reach else self.open_reach
        reach = {"id": rid, "zoneId": zone if isinstance(zone, str) and zone else None, "state": state, "ts": ts}
        self.ledger.append({"kind": "reach", **reach})
        self.outbox.put("/ingest/reaches", {"reaches": [reach]})
        self.open_reach = rid if state == "start" else None
        self.last_reach = self.clock()

    def _pockets(self, zone_id: str, pockets: list[bool], ts: str) -> None:
        self.pockets_on = True
        self._count(zone_id, sum(pockets), pockets, ts)

    def _count(self, zone_id: str, count: int, pockets: Optional[list[bool]], ts: str) -> None:
        zone = next((z for z in self.saved["zones"] if z["id"] == zone_id), None)
        product = zone.get("productId") if zone else None
        if not product:
            # Vision can speak before the first heartbeat has come back. The count is kept and used once the hub has named the zone.
            if zone_id not in self.waiting:
                self.log(f"Holding a count for {zone_id} until the hub says which part is in that zone.")
            self.waiting[zone_id] = (count, pockets, ts)
            return
        self.waiting.pop(zone_id, None)
        before = self.counts.get(zone_id)
        if before == count:
            return
        if before is not None:
            seen = self.last_reach is not None and self.clock() - self.last_reach <= HAND_SEEN_S
            pick = {"id": self.ledger.next_id("pk"), "productId": product, "zoneId": zone_id, "delta": count - before, "countAfter": count, "source": "node", "handSeen": seen, "ts": ts}
            self.ledger.append({"kind": "pick", **pick})
            self.outbox.put("/ingest/picks", {"picks": [pick]})
        body = {"productId": product, "zoneId": zone_id, "count": count, "level": None, "pockets": pockets, "source": "node", "ts": ts}
        self.ledger.append({"kind": "count", **body})
        self.outbox.put("/ingest/counts", {"counts": [body]})
        self.counts[zone_id] = count
        rop = self._rop(product)
        if rop is None or count > rop:
            self.crossings.pop(product, None)
        elif before is None or before > rop:
            self.crossings[product] = {"at": self.clock(), "called": False}

    def _rop(self, product: Optional[str]) -> Optional[int]:
        return next((r["reorderPoint"] for r in self.saved["reorderPoints"] if r["productId"] == product), None)

    # ---------- the hub ----------

    def level(self) -> int:
        if not self.pockets_on:
            return 1
        if self.model_on and self.supervised:
            return 4
        return 3 if self.supervised else 2

    def status(self) -> dict:
        restarts = load_json(self.dir / "restarts.json", {}).get("vision", 0)
        return {"online": True, "level": self.level(), "lastSeen": self.wall(), "queued": len(self.outbox), "visionRestarts": int(restarts), "offlineSince": self.offline_since}

    def heartbeat(self) -> bool:
        result, answer = self.hub.post("/ingest/node", {"status": self.status()})
        with self.lock:
            if result != OK or not isinstance(answer, dict):
                if self.connected or self.last_ok is None and self.offline_since is None:
                    self.offline_since = self.wall()
                    self.log("The hub is not answering. Recording here and sending later.")
                self.connected = False
                return False
            if not self.connected and self.last_ok is not None:
                self.log(f"The hub is back. Sending {len(self.outbox)} queued.")
            self.connected, self.last_ok = True, self.clock()
            saved = {key: answer.get(key, []) for key in ("zones", "reorderPoints", "awaitingApproval")}
            if saved != self.saved:
                self.saved = saved
                save_json(self.dir / "hub.json", saved)
                self._write_zones()
            for zone_id, (count, pockets, ts) in list(self.waiting.items()):
                if any(z["id"] == zone_id and z.get("productId") for z in self.saved["zones"]):
                    self._count(zone_id, count, pockets, ts)
            return True

    def _send(self, route: str, body: dict) -> str:
        result, _ = self.hub.post(route, body)
        if result == RETRY:
            self.connected = False
        else:
            self.last_ok = self.clock()
        return result

    def send_step(self) -> None:
        """One turn of the sender: a heartbeat when it is due, then the outbox, then the reorder guard."""
        now = self.clock()
        if now >= self.next_heartbeat:
            self.next_heartbeat = now + HEARTBEAT_S
            self.heartbeat()
        if self.connected and len(self.outbox):
            self.outbox.drain(self._send)
        self._reorder_guard(self.clock())

    def _reorder_guard(self, now: float) -> None:
        with self.lock:
            for product, crossing in self.crossings.items():
                if crossing["called"]:
                    continue
                if self.last_ok is not None and self.last_ok > crossing["at"] and len(self.outbox) == 0:
                    crossing["called"] = True  # the hub has the count and decides for itself
                    continue
                silent = now - max(self.last_ok if self.last_ok is not None else self.started, self.started)
                if silent < HUB_SILENT_S:
                    continue
                zone = next((z["id"] for z in self.saved["zones"] if z.get("productId") == product), None)
                call = {"id": self.ledger.next_id("ro"), "productId": product, "countAfter": self.counts.get(zone, 0), "ts": self.wall()}
                self.ledger.append({"kind": "reorder", **call})
                self.outbox.put("/ingest/reorder", call)
                crossing["called"] = True
                self.log(f"The hub has been silent for {int(silent)} seconds and {product} is at its reorder point. Called for a reorder.")

    # ---------- the button ----------

    def on_button(self) -> Optional[str]:
        """A press. Approves the oldest order that is waiting for a yes. Returns its id, or None when nothing was approved."""
        if not self.debounce.press(self.clock()):
            return None
        self.heartbeat()  # the list of waiting orders may be five seconds old
        waiting = list(self.saved["awaitingApproval"])
        if not waiting:
            self.log("Button pressed. Nothing is waiting for a yes.")
            return None
        if not self.connected:
            self.log("Button pressed, but the hub is not answering. Press again when it is back.")
            return None
        order = waiting[0]
        result, _ = self.hub.post(f"/api/orders/{order}/approve", {"by": "button"})
        if result != OK:
            self.log(f"Button pressed, but the hub did not take the yes for {order}.")
            return None
        with self.lock:
            self.ledger.append({"kind": "approve", "orderId": order, "ts": self.wall()})
            self.saved["awaitingApproval"] = waiting[1:]
        self.log(f"Button pressed. Approved {order}.")
        return order
