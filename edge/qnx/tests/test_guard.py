"""The guard, with a fake hub and a fake clock. Bodies are compared with the shared mocks key for key."""
import json
from pathlib import Path

from guard.button import Debounce, Presses
from guard.core import Guard
from guard.ledger import Ledger
from guard.outbox import DROP, OK, RETRY, Outbox
from guard.state import load_json, zones_text

MOCKS = Path(__file__).resolve().parents[3] / "contracts" / "mocks"
mock = lambda name: json.loads((MOCKS / f"{name}.json").read_text(encoding="utf-8"))  # noqa: E731
TS = "2026-11-21T09:14:03-05:00"


class FakeHub:
    def __init__(self):
        self.up = True
        self.posts: list[tuple[str, dict]] = []
        self.answer = mock("ingest-node-result")

    def post(self, route, body):
        if not self.up:
            return RETRY, None
        self.posts.append((route, body))
        if route == "/ingest/node":
            return OK, self.answer
        return OK, {"ok": True}

    def routes(self):
        return [r for r, _ in self.posts if r != "/ingest/node"]


def make(tmp_path, hub=None):
    clock = {"t": 100.0}
    logs: list[str] = []
    hub = hub or FakeHub()
    g = Guard(tmp_path, hub, clock=lambda: clock["t"], wall=lambda: TS, log=logs.append)
    return g, hub, clock, logs


def line(**event) -> str:
    return json.dumps({"ts": TS, **event})


def same_keys(a, b) -> None:
    assert sorted(a) == sorted(b)
    for key in a:
        if isinstance(a[key], dict):
            same_keys(a[key], b[key])
        elif isinstance(a[key], list) and a[key] and isinstance(a[key][0], dict):
            same_keys(a[key][0], b[key][0])
        else:
            assert type(a[key]) is type(b[key]) or None in (a[key], b[key]), key


def test_the_ledger_survives_a_crash_in_the_middle_of_a_write(tmp_path):
    path = tmp_path / "ledger.jsonl"
    ledger = Ledger(path)
    ledger.append({"kind": "reach", "id": ledger.next_id("rc")})
    ledger.append({"kind": "reach", "id": ledger.next_id("rc")})
    with open(path, "ab") as f:
        f.write(b'{"kind":"reach","id":"rc-torn')  # power cut here
    again = Ledger(path)
    assert [r["kind"] for r in again.records] == ["opened", "reach", "reach"]
    assert path.read_bytes().endswith(b"\n") and b"torn" not in path.read_bytes()
    again.append({"kind": "pick", "id": again.next_id("pk")})
    assert [r["kind"] for r in Ledger(path).records] == ["opened", "reach", "reach", "pick"]


def test_a_restart_does_not_repeat_an_id(tmp_path):
    first = Ledger(tmp_path / "ledger.jsonl")
    ids = [first.next_id("rc"), first.next_id("rc"), first.next_id("pk")]
    for i in ids:
        first.append({"kind": "x", "id": i})
    second = Ledger(tmp_path / "ledger.jsonl")
    assert second.epoch == first.epoch
    more = [second.next_id("rc"), second.next_id("pk"), second.next_id("ro")]
    assert len(set(ids + more)) == 6
    assert more[0].endswith("-0003") and more[1].endswith("-0002") and more[2].endswith("-0001")
    # A wiped ledger gets a new epoch, so the hub never takes a new event for one it has already seen.
    assert Ledger(tmp_path / "other.jsonl").next_id("rc").startswith("rc-")


def test_the_outbox_keeps_order_and_drains_on_reconnect(tmp_path):
    box = Outbox(tmp_path / "outbox.jsonl")
    for n in range(4):
        box.put("/ingest/reaches", {"n": n})
    sent = []
    assert box.drain(lambda route, body: RETRY) == 0 and len(box) == 4
    # Back for two, then gone again.
    answers = iter([OK, OK, RETRY])
    assert box.drain(lambda route, body: (sent.append(body["n"]), next(answers))[1]) == 2
    assert sent == [0, 1, 2] and len(box) == 2
    # It is on disk: a new process carries on from the same place.
    again = Outbox(tmp_path / "outbox.jsonl")
    sent.clear()
    assert again.drain(lambda route, body: (sent.append(body["n"]), OK)[1]) == 2
    assert sent == [2, 3] and len(Outbox(tmp_path / "outbox.jsonl")) == 0


def test_a_body_the_hub_refuses_for_good_does_not_block_the_rest(tmp_path):
    box = Outbox(tmp_path / "outbox.jsonl")
    box.put("/a", {"n": 0})
    box.put("/b", {"n": 1})
    assert box.drain(lambda route, body: DROP if body["n"] == 0 else OK) == 2 and len(box) == 0


def test_the_heartbeat_matches_the_mock_and_its_answer_is_saved_and_loaded(tmp_path):
    g, hub, _, _ = make(tmp_path)
    g.send_step()
    route, body = hub.posts[0]
    assert route == "/ingest/node"
    same_keys(body, mock("ingest-node"))
    assert body["status"] == {"online": True, "level": 1, "lastSeen": TS, "queued": 0, "visionRestarts": 0, "offlineSince": None}
    assert load_json(tmp_path / "hub.json", None) == {k: hub.answer[k] for k in ("zones", "reorderPoints", "awaitingApproval")}
    # A new guard with no hub still knows the zones and the reorder points.
    hub2 = FakeHub()
    hub2.up = False
    g2, _, _, _ = make(tmp_path, hub2)
    assert [z["id"] for z in g2.saved["zones"]] == ["z-screws", "z-brackets"] and g2._rop("p-screws") == 4


def test_the_heartbeat_goes_every_5_seconds_and_reports_the_queue_and_restarts(tmp_path):
    g, hub, clock, _ = make(tmp_path)
    (tmp_path / "restarts.json").write_text('{"vision": 3, "guard": 0}')
    for _ in range(12):
        g.send_step()
        clock["t"] += 1.0
    beats = [b for r, b in hub.posts if r == "/ingest/node"]
    assert len(beats) == 3 and beats[-1]["status"]["visionRestarts"] == 3


def test_reach_lines_become_ledger_lines_then_posts_that_match_the_mock(tmp_path):
    g, hub, _, logs = make(tmp_path)
    g.send_step()
    g.on_line(line(type="reach", state="start", zone="z-screws"))
    # On disk before anything is sent.
    assert g.ledger.records[-1]["kind"] == "reach" and hub.routes() == []
    g.on_line(line(type="reach", state="end", zone="z-screws"))
    g.send_step()
    bodies = [b for r, b in hub.posts if r == "/ingest/reaches"]
    assert len(bodies) == 2
    same_keys(bodies[0], mock("ingest-reaches"))
    start, end = bodies[0]["reaches"][0], bodies[1]["reaches"][0]
    assert (start["state"], end["state"]) == ("start", "end") and start["id"] == end["id"] and start["zoneId"] == "z-screws"
    # A hand over no zone, and the next reach gets its own id.
    g.on_line(line(type="reach", state="start", zone=None))
    assert g.ledger.records[-1]["zoneId"] is None and g.ledger.records[-1]["id"] != start["id"]
    assert logs == []


def test_a_broken_line_is_logged_and_skipped_and_chatter_is_ignored(tmp_path):
    g, _, _, logs = make(tmp_path)
    before = len(g.ledger.records)
    g.on_line("Camera 29.8 fps  AI Inference 14.2 fps")
    g.on_line('{"type":"reach","state":')
    g.on_line('{"type":"reach","state":"sideways"}')
    g.on_line('{"type":"weather"}')
    assert len(g.ledger.records) == before
    assert len(logs) == 3 and all("Skipped" in text for text in logs)
    g.on_line('{"type":"reach","state":"start","zone":"z-screws","ts":"not a time"}')
    assert g.ledger.records[-1]["ts"] == TS  # a bad time is replaced, the event is kept


def test_a_pockets_change_becomes_a_pick_and_a_count_that_match_the_mocks(tmp_path):
    g, hub, _, _ = make(tmp_path)
    g.send_step()
    full = lambda n: [i < n for i in range(12)]  # noqa: E731
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(6)))
    g.send_step()
    assert hub.routes() == ["/ingest/counts"]  # the first look is a count, not a pick
    g.on_line(line(type="reach", state="start", zone="z-screws"))
    g.on_line(line(type="reach", state="end", zone="z-screws"))
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(4)))
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(4)))  # said twice: one pick
    g.send_step()
    assert hub.routes() == ["/ingest/counts", "/ingest/reaches", "/ingest/reaches", "/ingest/picks", "/ingest/counts"]
    pick_body = next(b for r, b in hub.posts if r == "/ingest/picks")
    same_keys(pick_body, mock("ingest-picks"))
    pick = pick_body["picks"][0]
    assert {k: pick[k] for k in ("productId", "zoneId", "delta", "countAfter", "source", "handSeen")} == {"productId": "p-screws", "zoneId": "z-screws", "delta": -2, "countAfter": 4, "source": "node", "handSeen": True}
    count_body = [b for r, b in hub.posts if r == "/ingest/counts"][-1]
    same_keys(count_body["counts"][0], mock("ingest-counts")["counts"][0])
    assert count_body["counts"][0]["count"] == 4 and count_body["counts"][0]["pockets"] == full(4) and count_body["counts"][0]["source"] == "node"
    assert [r["kind"] for r in g.ledger.records[-2:]] == ["pick", "count"]
    assert g.status()["level"] == 2
    # A zone the hub never mentioned is held, not counted.
    g.on_line(line(type="pockets", zone="z-mystery", pockets=[True]))
    assert g.ledger.records[-1]["kind"] == "count" and g.ledger.records[-1]["zoneId"] == "z-screws"


def test_a_count_that_arrives_before_the_first_heartbeat_is_used_once_the_hub_names_the_zone(tmp_path):
    g, hub, clock, logs = make(tmp_path)
    full = lambda n: [i < n for i in range(12)]  # noqa: E731
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(6)))  # vision spoke first
    assert g.counts == {} and "Holding a count for z-screws" in logs[-1]
    g.send_step()
    assert g.counts == {"z-screws": 6}
    g.send_step()
    assert hub.routes() == ["/ingest/counts"] and hub.posts[-1][1]["counts"][0]["count"] == 6
    # So the first take is a pick, as it should be.
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(4)))
    g.send_step()
    assert hub.routes()[-2:] == ["/ingest/picks", "/ingest/counts"]


def test_an_open_zone_count_line_is_handled_the_same_way(tmp_path):
    g, hub, _, _ = make(tmp_path)
    hub.answer = {**hub.answer, "zones": hub.answer["zones"] + [{"id": "z-glue", "name": "Wood glue", "kind": "open", "camera": "board", "quad": [[0, 0], [1, 0], [1, 1], [0, 1]], "rows": None, "cols": None, "productId": "p-glue"}]}
    g.send_step()
    g.on_line(line(type="count", zone="z-glue", count=3))
    g.on_line(line(type="count", zone="z-glue", count=2))
    g.send_step()
    assert hub.routes() == ["/ingest/counts", "/ingest/picks", "/ingest/counts"]
    assert hub.posts[-1][1]["counts"][0] == {"productId": "p-glue", "zoneId": "z-glue", "count": 2, "level": None, "pockets": None, "source": "node", "ts": TS}


def test_offline_everything_waits_in_order_and_one_reorder_call_is_made_for_each_crossing(tmp_path):
    g, hub, clock, logs = make(tmp_path)
    full = lambda n: [i < n for i in range(12)]  # noqa: E731
    g.send_step()
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(6)))
    g.send_step()
    hub.posts.clear()
    hub.up = False  # the network cable is pulled
    clock["t"] += 6
    g.send_step()
    assert g.status()["offlineSince"] == TS
    g.on_line(line(type="reach", state="start", zone="z-screws"))
    g.on_line(line(type="reach", state="end", zone="z-screws"))
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(4)))  # at the reorder point of 4
    g.send_step()
    assert len(g.outbox) == 4 and not any(r["kind"] == "reorder" for r in g.ledger.records)
    clock["t"] += 9
    g.send_step()
    call = g.ledger.records[-1]
    assert call["kind"] == "reorder"
    same_keys({k: v for k, v in call.items() if k != "kind"}, mock("ingest-reorder"))
    assert (call["productId"], call["countAfter"]) == ("p-screws", 4)
    assert "Called for a reorder" in logs[-1]
    # Still offline, another box goes: it is the same crossing, so no second call.
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(3)))
    clock["t"] += 30
    g.send_step()
    assert sum(r["kind"] == "reorder" for r in g.ledger.records) == 1
    assert g.status()["queued"] == 7
    # The cable goes back in: everything arrives, in the order it happened.
    hub.up = True
    clock["t"] += 5
    g.send_step()
    assert hub.routes() == ["/ingest/reaches", "/ingest/reaches", "/ingest/picks", "/ingest/counts", "/ingest/reorder", "/ingest/picks", "/ingest/counts"]
    assert len(g.outbox) == 0
    # Restocked above the line and down again: that is a new crossing, but the hub is here now and decides itself.
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(12)))
    g.on_line(line(type="pockets", zone="z-screws", pockets=full(4)))
    g.send_step()
    clock["t"] += 60
    g.send_step()
    assert sum(r["kind"] == "reorder" for r in g.ledger.records) == 1


def test_a_guard_that_restarts_offline_still_makes_the_call(tmp_path):
    g, hub, clock, _ = make(tmp_path)
    g.send_step()
    g.on_line(line(type="pockets", zone="z-screws", pockets=[True] * 6 + [False] * 6))
    g.send_step()
    hub.up = False
    clock["t"] += 6
    g.send_step()
    g.on_line(line(type="pockets", zone="z-screws", pockets=[True] * 4 + [False] * 8))
    # The guard is killed before the 10 seconds are up, and started again.
    g2, _, clock2, _ = make(tmp_path, hub)
    assert g2.counts == {"z-screws": 4} and len(g2.outbox) == 2
    clock2["t"] += 11
    g2.send_step()
    assert [r["kind"] for r in g2.ledger.records].count("reorder") == 1
    ids = [r["id"] for r in g2.ledger.records if "id" in r]
    assert len(ids) == len(set(ids))


def test_the_button_approves_the_oldest_waiting_order_once(tmp_path):
    g, hub, clock, logs = make(tmp_path)
    hub.answer = {**hub.answer, "awaitingApproval": ["o-7", "o-9"]}
    assert g.on_button() == "o-7"
    assert hub.posts[-1] == ("/api/orders/o-7/approve", {"by": "button"})
    assert g.ledger.records[-1] == {"kind": "approve", "orderId": "o-7", "ts": TS}
    clock["t"] += 0.4
    assert g.on_button() is None  # a bounce, or a second press inside a second
    assert sum(r.endswith("/approve") for r, _ in hub.posts) == 1
    hub.answer = {**hub.answer, "awaitingApproval": []}
    clock["t"] += 2
    assert g.on_button() is None and "Nothing is waiting" in logs[-1]
    hub.up = False
    clock["t"] += 2
    g.saved["awaitingApproval"] = ["o-9"]
    assert g.on_button() is None and "not answering" in logs[-1]


def test_button_debounce():
    d = Debounce(1.0)
    assert [d.press(t) for t in (0.0, 0.2, 0.99, 1.0, 1.5, 2.1)] == [True, False, False, True, False, True]
    d = Debounce(1.0)
    assert [d.level(down, t) for down, t in ((False, 0), (True, 0.1), (True, 0.2), (False, 0.3), (True, 0.4), (False, 1.2), (True, 1.3))] == [False, True, False, False, False, False, True]


def test_the_zones_file_for_vision_uses_the_pi_cameras_own_quads(tmp_path):
    (tmp_path / "node-quads.txt").write_text("# id, then the quad in the Pi camera's picture\nz-screws 0.1 0.2 0.6 0.2 0.6 0.5 0.1 0.5\n")
    g, _, _, _ = make(tmp_path)
    g.send_step()
    assert (tmp_path / "zones.txt").read_text() == "zone z-screws pockets 2 6 0.10000 0.20000 0.60000 0.20000 0.60000 0.50000 0.10000 0.50000\n"
    assert zones_text([{"id": "z-a", "kind": "open", "camera": "board", "quad": [[0, 0], [1, 0], [1, 1], [0, 1]]}]) == ""


def test_calls_to_the_hub_carry_a_user_agent_cloudflare_lets_through():
    import io

    from guard.hub import Hub

    seen = []

    class Answer(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def opener(request, timeout):
        seen.append(request)
        return Answer(b'{"ok": true}')

    assert Hub("https://hub.example/", "device-1", opener=opener).post("/ingest/node", {"level": 2}) == ("ok", {"ok": True})
    # Python's default (Python-urllib/3.x) is answered 403 with error 1010 on workers.dev, and the node would retry for ever.
    assert seen[0].get_header("User-agent") == "reup-node/1" and seen[0].get_header("Authorization") == "Bearer device-1"


def looks(presses, rows):
    return [presses.look(down, t) for down, t in rows]


def test_the_level_the_pin_starts_at_is_never_a_press():
    # Nothing wired, or a pin that floats high: down from the first look, for as long as it likes.
    p = Presses(rest_s=0.3, firm_s=0.04)
    assert not any(looks(p, [(True, t / 50) for t in range(500)]))
    # It rests for a moment, too short to trust, and reads down again: still nothing.
    assert not any(looks(p, [(False, 10.0), (False, 10.1), (True, 10.2), (True, 10.4)]))


def test_a_press_counts_once_after_the_pin_was_at_rest():
    p = Presses(rest_s=0.3, firm_s=0.04)
    rest = [(False, t / 50) for t in range(20)]  # 0.38 s at rest
    assert not any(looks(p, rest))
    # Down, a bounce, down again, held for two seconds: one press, on the look where it has been down for 0.04 s.
    held = [(True, 0.40), (False, 0.41), (True, 0.42), (True, 0.44), (True, 0.46)] + [(True, 0.5 + t / 50) for t in range(100)]
    got = looks(p, held)
    assert got.count(True) == 1 and got.index(True) == 4
    # Let go for a blink and press again: not at rest long enough, so no second yes.
    assert not any(looks(p, [(False, 2.6), (True, 2.7), (True, 2.8)]))
    # Let go properly, then press: the second press counts.
    assert looks(p, [(False, 3.0), (False, 3.2), (False, 3.4), (True, 3.5), (True, 3.56)]) == [False, False, False, False, True]


def test_a_guard_that_starts_with_the_pin_down_says_yes_to_nothing(tmp_path):
    g, hub, _clock, _logs = make(tmp_path)
    hub.answer = {**hub.answer, "awaitingApproval": ["o-7"]}
    p = Presses()
    for t in range(200):
        if p.look(True, t / 50):
            g.on_button()
    assert not [route for route, _ in hub.posts if route.endswith("/approve")]


class Wire:
    """Stands in for urlopen: answers by address. An answer is a dict (200), an int (that HTTP error), or an exception."""

    def __init__(self, answers: dict):
        self.answers = answers
        self.asked: list[str] = []

    def __call__(self, request, timeout=None):
        import io
        import urllib.error

        self.asked.append(request.full_url)
        base = request.full_url.split("/ingest")[0]
        answer = self.answers[base]
        if isinstance(answer, Exception):
            raise answer
        if isinstance(answer, int):
            raise urllib.error.HTTPError(request.full_url, answer, "no", {}, io.BytesIO(b"{}"))
        return io.BytesIO(json.dumps(answer).encode())


def test_the_hub_is_reached_through_the_laptop_first_and_directly_when_the_laptop_is_gone():
    import urllib.error

    from guard.hub import Hub
    from guard.outbox import DROP, OK, RETRY

    relay, direct = "http://169.254.138.173:8089/hub", "https://hub.example"
    now = {"t": 0.0}
    wire = Wire({relay: {"ok": True, "via": "laptop"}, direct: {"ok": True, "via": "direct"}})
    hub = Hub(direct, "t", opener=wire, relay=relay, clock=lambda: now["t"])
    assert hub.post("/ingest/node", {}) == (OK, {"ok": True, "via": "laptop"})
    assert wire.asked == [relay + "/ingest/node"]
    # The laptop is off: one call finds that out, the hub is asked directly, and the laptop is left alone for a while.
    wire.answers[relay] = urllib.error.URLError("refused")
    assert hub.post("/ingest/node", {})[1] == {"ok": True, "via": "direct"}
    assert hub.post("/ingest/node", {})[1] == {"ok": True, "via": "direct"}
    assert wire.asked[1:] == [relay + "/ingest/node", direct + "/ingest/node", direct + "/ingest/node"]
    # Later it is tried again, and it is back.
    now["t"] = 30.0
    wire.answers[relay] = {"ok": True, "via": "laptop"}
    assert hub.post("/ingest/node", {})[1] == {"ok": True, "via": "laptop"}
    # The laptop answers, but the hub did not answer the laptop (502): that is the laptop's way failing, not a no from the hub.
    wire.answers[relay] = 502
    assert hub.post("/ingest/node", {})[1] == {"ok": True, "via": "direct"}
    # A real no from the hub comes back as it is, whichever way it came: nothing is asked twice.
    now["t"] = 60.0
    wire.answers[relay] = 409
    before = len(wire.asked)
    assert hub.post("/ingest/node", {}) == (DROP, None)
    assert len(wire.asked) == before + 1
    # Both ways gone: try again later.
    now["t"] = 90.0
    wire.answers[relay] = urllib.error.URLError("refused")
    wire.answers[direct] = urllib.error.URLError("no route")
    assert hub.post("/ingest/node", {}) == (RETRY, None)
    # With no relay named it is the hub alone, as before.
    plain = Hub(direct, "t", opener=Wire({direct: {"ok": True}}))
    assert plain.post("/ingest/node", {}) == (OK, {"ok": True})
