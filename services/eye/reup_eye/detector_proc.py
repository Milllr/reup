"""The detector in a process of its own, so nothing it does can slow the camera loop.

In one process with the eye the stream fell from 30 frames a second to 12: importing ultralytics sets OpenCV to a single
thread, and the detector's own work holds Python's lock. A second process has its own of both.
"""
from __future__ import annotations

import importlib
import multiprocessing
from typing import Optional

import numpy as np

DETECTOR = "reup_eye.detector:YoloeDetector"


def _serve(conn, make: str, args: tuple) -> None:
    """The child: builds the detector, then answers one message at a time until the pipe closes."""
    try:
        module, name = make.split(":")
        detector = getattr(importlib.import_module(module), name)(*args)
    except BaseException as err:  # noqa: BLE001  an import that fails must reach the eye as a sentence, not a dead pipe
        conn.send(("error", f"{type(err).__name__}: {err}"))
        return
    conn.send(("ready", None))
    while True:
        try:
            message = conn.recv()
        except (EOFError, OSError):
            return
        try:
            if message[0] == "prompts":
                detector.set_prompts(message[1])
                conn.send(("ok", None))
            elif message[0] == "frame":
                frame = np.frombuffer(conn.recv_bytes(), dtype=np.uint8).reshape(message[1])
                conn.send(("found", detector.detect(frame)))
            else:
                return
        except Exception as err:  # noqa: BLE001
            conn.send(("error", f"{type(err).__name__}: {err}"))


class DetectorProcess:
    """The same two calls as the detector itself, set_prompts and detect, answered by the other process."""

    def __init__(self, model: str, imgsz: int, conf: float, make: str = DETECTOR, start_timeout: float = 180.0, timeout: float = 20.0):
        self.timeout = timeout
        context = multiprocessing.get_context("spawn")
        self.conn, child = context.Pipe()
        self.process = context.Process(target=_serve, args=(child, make, (model, imgsz, conf)), daemon=True, name="reup-detector")
        self.process.start()
        child.close()
        try:
            self._answer("ready", start_timeout)
        except Exception:
            self.close()
            raise

    def _answer(self, want: str, timeout: Optional[float] = None):
        try:
            if not self.conn.poll(self.timeout if timeout is None else timeout):
                raise TimeoutError("The detector did not answer in time.")
            kind, value = self.conn.recv()
        except (EOFError, OSError) as err:
            raise RuntimeError("The detector process stopped.") from err
        if kind != want:
            raise RuntimeError(str(value) if kind == "error" else f"The detector answered {kind}, not {want}.")
        return value

    def set_prompts(self, prompts: list) -> None:
        self.conn.send(("prompts", prompts))
        self._answer("ok", 180.0)

    def detect(self, frame: np.ndarray) -> list[dict]:
        frame = np.ascontiguousarray(frame, dtype=np.uint8)
        self.conn.send(("frame", frame.shape))
        self.conn.send_bytes(frame.tobytes())
        return self._answer("found")

    def close(self) -> None:
        try:
            self.conn.close()
        except OSError:
            pass
        if self.process.is_alive():
            self.process.terminate()
        self.process.join(2.0)
