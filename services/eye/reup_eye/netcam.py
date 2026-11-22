"""A camera that is plugged into another machine and reaches the eye as MJPEG over HTTP.

On the station as built the one camera is plugged into the Pi. The shelf node on QNX looks at every frame for hands and
serves the same frames (edge/qnx/vision/src/reup_stream.hpp). The eye reads them here and counts the parts in them,
exactly as it does for a camera on its own USB port. Standard library only: a socket, and a decoder handed in.
"""
from __future__ import annotations

import socket
from typing import Callable, Optional
from urllib.parse import urlparse

import numpy as np

MAX_JPEG_BYTES = 8_000_000
LINK_LOCAL = "169.254."


def addresses(host: str, port: int, resolve: Callable = socket.getaddrinfo) -> list[tuple]:
    """Where to connect, IPv6 first: an IPv6 link local address carries the adapter it was found on."""
    found = resolve(host, port, 0, socket.SOCK_STREAM)
    return sorted(found, key=lambda a: 0 if a[0] == socket.AF_INET6 else 1)


def own_link_local(resolve: Callable = socket.getaddrinfo, name: Callable[[], str] = socket.gethostname) -> list[str]:
    """This machine's own IPv4 link local addresses (169.254.x.x), one for each adapter on a direct cable."""
    try:
        found = resolve(name(), None, socket.AF_INET, socket.SOCK_STREAM)
    except OSError:
        return []
    return sorted({a[4][0] for a in found if a[4][0].startswith(LINK_LOCAL)})


def sources(family: int, address: tuple, own: Callable[[], list[str]] = own_link_local) -> list[Optional[str]]:
    """The addresses of this machine to connect from, in the order to try them. None leaves the choice to the system.

    A Pi on a direct cable has only a link local address. Windows sends 169.254.x.x out through whichever adapter comes
    first, which on the station laptop is a VPN, so a plain connect hangs. Connecting from the address of the adapter
    the cable is in sends it down the cable. Measured on the station: plain, no answer in 3 s. From 169.254.138.173,
    an answer in 0.02 s.
    """
    if family == socket.AF_INET and str(address[0]).startswith(LINK_LOCAL):
        return [*own(), None]
    return [None]


class MjpegCapture:
    """Reads one MJPEG stream. read() gives (True, frame) for each picture, (False, None) when the stream is gone."""

    def __init__(self, url: str, decode: Callable[[bytes], Optional[np.ndarray]], timeout: float = 4.0, connect_timeout: float = 2.0, resolve: Callable = socket.getaddrinfo, own: Callable[[], list[str]] = own_link_local):
        parts = urlparse(url)
        if parts.scheme != "http" or not parts.hostname:
            raise ValueError(f"A camera address is http://host:port/path. Got {url!r}.")
        self.decode = decode
        self.sock: Optional[socket.socket] = None
        self.file = None
        self.first: Optional[np.ndarray] = None
        last: Optional[Exception] = None
        for family, kind, proto, _name, address in addresses(parts.hostname, parts.port or 80, resolve):
            for source in sources(family, address, own):
                sock = socket.socket(family, kind, proto)
                sock.settimeout(connect_timeout)
                try:
                    if source:
                        sock.bind((source, 0))
                    sock.connect(address)
                except OSError as err:
                    last = err
                    sock.close()
                    continue
                self.sock = sock
                break
            if self.sock is not None:
                break
        if self.sock is None:
            raise OSError(f"Could not reach {parts.hostname}:{parts.port or 80}: {last}")
        try:
            self.sock.settimeout(timeout)
            host = parts.hostname if ":" not in parts.hostname else f"[{parts.hostname}]"
            path = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
            self.sock.sendall(f"GET {path} HTTP/1.1\r\nHost: {host}\r\nAccept: multipart/x-mixed-replace\r\nConnection: close\r\n\r\n".encode("ascii"))
            self.file = self.sock.makefile("rb")
            status = self.file.readline().decode("latin-1")
            if " 200" not in status:
                raise OSError(f"The camera answered {status.strip() or 'nothing'}.")
            self._headers()
            # A stream that answers and then sends nothing is no camera. Say so now, so the next way in line (the
            # laptop's own USB) is tried. Seen on the station: the Pi's node kept its port open with its camera
            # unplugged, the eye kept choosing it, and the board had no camera until the address was cleared.
            ok, self.first = self.read()
            if not ok:
                raise OSError(f"{parts.hostname}:{parts.port or 80} answers and sends no picture.")
        except Exception:
            self.release()
            raise

    def _headers(self) -> dict[str, str]:
        """The header lines up to the blank one, names in lower case."""
        out: dict[str, str] = {}
        while True:
            line = self.file.readline()
            if line == b"":
                raise OSError("The stream ended.")
            line = line.strip()
            if line == b"":
                return out
            if b":" in line:
                name, value = line.split(b":", 1)
                out[name.strip().lower().decode("latin-1")] = value.strip().decode("latin-1")

    def read(self) -> tuple[bool, Optional[np.ndarray]]:
        if self.first is not None:
            frame, self.first = self.first, None
            return True, frame
        if self.file is None:
            return False, None
        try:
            # A part: the boundary line, its headers, a blank line, then exactly Content-Length bytes.
            while True:
                line = self.file.readline()
                if line == b"":
                    return False, None
                if line.strip().startswith(b"--"):
                    break
            length = int(self._headers().get("content-length", "0"))
            if not 0 < length <= MAX_JPEG_BYTES:
                return False, None
            data = self.file.read(length)
            if len(data) != length:
                return False, None
            frame = self.decode(data)
            return (frame is not None), frame
        except (OSError, ValueError):
            return False, None

    def release(self) -> None:
        for thing in (self.file, self.sock):
            try:
                if thing is not None:
                    thing.close()
            except OSError:
                pass
        self.file, self.sock = None, None
