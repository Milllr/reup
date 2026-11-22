"""The shelf node's way to the hub through the laptop: POST /hub/... on the eye's own port is passed on as it is."""
import io
import json
import threading
import urllib.error
import urllib.request
from types import SimpleNamespace

from reup_eye.server import make_server


def serve(opener):
    runtime = SimpleNamespace(hub=SimpleNamespace(url="https://hub.example/"), cameras={}, stopping=threading.Event())
    server = make_server(runtime, 0, opener=opener)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}"


def post(url, body, token="dev"):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=5) as answer:
            return answer.status, json.loads(answer.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read() or b"{}")


def test_a_call_from_the_node_reaches_the_hub_with_its_token_and_its_body():
    seen = []

    def hub(request, timeout=None):
        seen.append((request.full_url, request.get_method(), request.headers.get("Authorization"), request.headers.get("User-agent"), request.data))
        answer = io.BytesIO(b'{"ok": true, "awaitingApproval": []}')
        answer.status, answer.headers = 200, {"Content-Type": "application/json"}
        return answer

    server, base = serve(hub)
    try:
        assert post(base + "/hub/ingest/node", {"level": 1}, token="device-1") == (200, {"ok": True, "awaitingApproval": []})
        assert seen == [("https://hub.example/ingest/node", "POST", "Bearer device-1", "reup-node/1", b'{"level": 1}')]
    finally:
        server.shutdown()


def test_a_no_from_the_hub_comes_back_as_it_is_and_a_hub_that_is_gone_is_a_502():
    def refuses(request, timeout=None):
        raise urllib.error.HTTPError(request.full_url, 409, "Conflict", {}, io.BytesIO(b'{"ok": false, "code": "conflict"}'))

    server, base = serve(refuses)
    try:
        assert post(base + "/hub/api/orders/o-1/approve", {"by": "button"}) == (409, {"ok": False, "code": "conflict"})
    finally:
        server.shutdown()

    def gone(request, timeout=None):
        raise urllib.error.URLError("no route to host")

    server, base = serve(gone)
    try:
        status, body = post(base + "/hub/ingest/node", {})
        assert status == 502 and body["code"] == "upstream_failed"
    finally:
        server.shutdown()
