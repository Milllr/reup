"""The camera on the Pi: the eye reads its MJPEG stream, picture by picture, and says so plainly when it is gone."""
import socket
import threading

import numpy as np
import pytest

from reup_eye.netcam import MjpegCapture, addresses


def serve(parts: list[bytes], status: bytes = b"HTTP/1.1 200 OK", hold: bool = False):
    """A one shot server on a free port that sends these pictures as one multipart stream. Returns (url, requests)."""
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    seen: list[bytes] = []
    stop = threading.Event()

    def run() -> None:
        conn, _ = listener.accept()
        seen.append(conn.recv(4096))
        conn.sendall(status + b"\r\nContent-Type: multipart/x-mixed-replace; boundary=reupframe\r\nConnection: close\r\n\r\n")
        for jpeg in parts:
            conn.sendall(b"--reupframe\r\nContent-Type: image/jpeg\r\nContent-Length: " + str(len(jpeg)).encode() + b"\r\n\r\n" + jpeg + b"\r\n")
        if hold:
            stop.wait(5)
        conn.close()
        listener.close()

    threading.Thread(target=run, daemon=True).start()
    return f"http://127.0.0.1:{port}/stream/board.mjpg", seen, stop


def decode(data: bytes):
    # The first byte stands in for the picture. A real decoder gives None for bytes that are not a picture.
    return None if data.startswith(b"bad") else np.full((2, 2, 3), data[0], np.uint8)


def test_reads_each_picture_in_turn_and_stops_when_the_stream_ends():
    url, seen, _ = serve([b"\x10" * 300, b"\x20" * 5000, b"\x30" * 10])
    cam = MjpegCapture(url, decode)
    assert seen[0].startswith(b"GET /stream/board.mjpg HTTP/1.1\r\n")
    for value in (0x10, 0x20, 0x30):
        ok, frame = cam.read()
        assert ok and frame.shape == (2, 2, 3) and int(frame[0, 0, 0]) == value
    # The node stopped sending: the eye is told there is no frame, so it lets go and tries again.
    assert cam.read() == (False, None)
    cam.release()
    assert cam.read() == (False, None)


def test_a_stream_that_goes_quiet_is_not_waited_on_for_ever():
    url, _seen, stop = serve([b"\x10" * 300], hold=True)
    cam = MjpegCapture(url, decode, timeout=0.3)
    assert cam.read()[0]
    assert cam.read() == (False, None)
    stop.set()
    cam.release()


def test_bytes_that_are_no_picture_and_a_camera_that_says_no_are_not_frames():
    url, _seen, _ = serve([b"bad bytes", b"\x40" * 20])
    cam = MjpegCapture(url, decode)
    assert cam.read() == (False, None)
    cam.release()
    url, _seen, _ = serve([], status=b"HTTP/1.1 503 Service Unavailable")
    with pytest.raises(OSError):
        MjpegCapture(url, decode)
    with pytest.raises(ValueError):
        MjpegCapture("rtsp://qnxpi.local/stream", decode)
    # Nothing listens there: it fails within the connect timeout and names the place.
    free = socket.socket()
    free.bind(("127.0.0.1", 0))
    port = free.getsockname()[1]
    free.close()
    with pytest.raises(OSError, match=str(port)):
        MjpegCapture(f"http://127.0.0.1:{port}/stream/board.mjpg", decode, connect_timeout=0.5)


def test_a_link_local_pi_is_tried_on_ipv6_first():
    v4 = (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("169.254.30.27", 8089))
    v6 = (socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("fe80::8aa2:9eff:fea9:d00c", 8089, 0, 51))
    assert addresses("qnxpi.local", 8089, lambda *_a: [v4, v6]) == [v6, v4]
    assert addresses("qnxpi.local", 8089, lambda *_a: [v4]) == [v4]
