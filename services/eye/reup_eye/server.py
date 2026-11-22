"""The eye's local routes on port 8089: the live stream, outlines, a debug picture, and the empty and full board captures.

Standard library only. Every answer allows any origin, because the TV page comes from the hub, not from here.
"""
from __future__ import annotations

import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

BOUNDARY = "reupframe"


def make_server(runtime, port: int) -> ThreadingHTTPServer:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):  # quiet: the stream would fill the terminal
            return

        def _send(self, status: int, body: bytes, kind: str = "application/json") -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status: int, value) -> None:
            self._send(status, json.dumps(value).encode("utf-8"))

        def do_OPTIONS(self):  # noqa: N802
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            path = urlparse(self.path).path
            if m := re.fullmatch(r"/stream/(\w+)\.mjpg", path):
                return self._stream(m.group(1))
            if m := re.fullmatch(r"/outlines/(\w+)\.json", path):
                if m.group(1) not in runtime.cameras:
                    return self._json(404, {"ok": False, "code": "not_found", "message": f"No camera {m.group(1)}."})
                return self._json(200, {"ts": runtime.eye.wall(), "items": runtime.eye.outlines.get(m.group(1), [])})
            if m := re.fullmatch(r"/debug/(\w+)\.jpg", path):
                jpeg = runtime.debug_jpeg(m.group(1))
                return self._send(200, jpeg, "image/jpeg") if jpeg else self._json(404, {"ok": False, "code": "not_found", "message": "No frame from that camera yet."})
            if path in ("/", "/health"):
                return self._json(200, runtime.health())
            self._json(404, {"ok": False, "code": "not_found", "message": f"No route {path}."})

        def do_POST(self):  # noqa: N802
            url = urlparse(self.path)
            query = {k: v[0] for k, v in parse_qs(url.query).items()}
            length = int(self.headers.get("Content-Length") or 0)
            if length:
                self.rfile.read(length)
            if m := re.fullmatch(r"/reference/(\w+)", url.path):
                if runtime.eye.capture_reference(m.group(1)):
                    return self._json(200, {"ok": True})
                return self._json(409, {"ok": False, "code": "conflict", "message": "No frame from that camera yet."})
            if m := re.fullmatch(r"/anchor/(\w+)", url.path):
                if runtime.set_home(m.group(1)):
                    return self._json(200, {"ok": True})
                return self._json(409, {"ok": False, "code": "conflict", "message": "No frame from that camera yet, or camera alignment is off."})
            if m := re.fullmatch(r"/full/(\w+)", url.path):
                result = runtime.eye.capture_full(m.group(1), {k: int(v) for k, v in query.items() if v.isdigit() and int(v) > 0})
                if result is None:
                    return self._json(409, {"ok": False, "code": "conflict", "message": "Save the empty board for that camera first."})
                return self._json(200, {"ok": True, **result})
            if m := re.fullmatch(r"/prompt/([\w-]+)", url.path):
                boxes = []
                # box=x0,y0,x1,y1 is one part in the frame. Several, split by a semicolon, are several of the same part.
                for text in filter(None, query.get("box", "").split(";")):
                    try:
                        box = tuple(float(v) for v in text.split(","))
                        assert len(box) == 4
                    except (ValueError, AssertionError):
                        return self._json(400, {"ok": False, "code": "bad_request", "message": "box is x0,y0,x1,y1, each from 0 to 1."})
                    boxes.append(box)
                note = runtime.capture_prompt(m.group(1), boxes)
                return self._json(200, {"ok": True}) if note is None else self._json(409, {"ok": False, "code": "conflict", "message": note})
            if url.path.startswith("/sim/") and runtime.sim is not None:
                return self._json(200, {"ok": True, **runtime.sim.command(url.path[5:], query)})
            self._json(404, {"ok": False, "code": "not_found", "message": f"No route {url.path}."})

        def _stream(self, camera_id: str) -> None:
            if camera_id not in runtime.cameras:
                return self._json(404, {"ok": False, "code": "not_found", "message": f"No camera {camera_id}."})
            self.send_response(200)
            self.send_header("Content-Type", f"multipart/x-mixed-replace; boundary={BOUNDARY}")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            seen = -1
            try:
                while not runtime.stopping.is_set():
                    seq, jpeg = runtime.wait_jpeg(camera_id, seen, timeout=2.0)
                    if jpeg is None or seq == seen:
                        continue
                    seen = seq
                    self.wfile.write(f"--{BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: {len(jpeg)}\r\n\r\n".encode("ascii"))
                    self.wfile.write(jpeg)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            self.close_connection = True

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def handle_error(self, request, client_address):
            # A browser that closes the stream or a tab is not an error worth a traceback.
            import sys  # noqa: PLC0415

            if isinstance(sys.exc_info()[1], (ConnectionError, TimeoutError)):
                return
            super().handle_error(request, client_address)

    return Server(("0.0.0.0", port), Handler)


def wait_until(predicate, timeout: float, step: float = 0.05) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if predicate():
            return True
        time.sleep(step)
    return False
