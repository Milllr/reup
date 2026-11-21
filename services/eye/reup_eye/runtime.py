"""Threads and OpenCV: the cameras, the stream, the loops that call the eye, and the detector. Run by python -m reup_eye."""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

from .app import Eye
from .config import resolve_index
from .frames import FrameSource, ReferenceStore
from .hubclient import Hub
from .server import make_server


def cv():
    import cv2  # noqa: PLC0415  only the runtime needs OpenCV

    return cv2


def encode_jpeg(frame: np.ndarray, quality: int) -> bytes:
    ok, data = cv().imencode(".jpg", frame, [cv().IMWRITE_JPEG_QUALITY, int(quality)])
    return data.tobytes() if ok else b""


def camera_names() -> Optional[list[str]]:
    """Device names in index order. Only Windows with pygrabber installed can say."""
    try:
        from pygrabber.dshow_graph import FilterGraph  # noqa: PLC0415

        return list(FilterGraph().get_input_devices())
    except Exception:  # noqa: BLE001
        return None


def cv_opener(cam):
    def open_(index: int):
        cv2 = cv()
        capture = cv2.VideoCapture(index, cv2.CAP_DSHOW if sys.platform == "win32" else cv2.CAP_ANY)
        if not capture.isOpened():
            capture.release()
            return None
        # 1080p at 30 over USB needs MJPG. A small buffer keeps the picture current.
        capture.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, cam.width)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, cam.height)
        capture.set(cv2.CAP_PROP_FPS, cam.fps)
        capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        capture.set(cv2.CAP_PROP_AUTOFOCUS, 0)
        return capture

    return open_


class Runtime:
    def __init__(self, config, hub_url: str, token: str, data_dir: Path, sim: bool = False, post: bool = True, log=print):
        self.config = config
        self.log = log
        self.post = post
        self.stopping = threading.Event()
        self.hub = Hub(hub_url, token)
        self.eye = Eye(config, self.hub, ReferenceStore(data_dir), encode_jpeg, data_dir, log)
        self.cameras = list(config.cameras)
        self.sim = None
        self.sources: dict[str, FrameSource] = {}
        if sim:
            from .sim import SimBoard, SimCamera  # noqa: PLC0415

            self.sim = SimBoard(self.eye)
            for cam_id in self.cameras:
                self.sources[cam_id] = FrameSource(cam_id, [0], lambda _i, c=cam_id: SimCamera(self.sim, c))
        else:
            names = camera_names()
            for cam_id, cam in config.cameras.items():
                index, note = resolve_index(cam.name, cam.index, names)
                if note:
                    log(note)
                self.sources[cam_id] = FrameSource(cam_id, [index], cv_opener(cam))
        self.jpegs: dict[str, tuple[int, bytes]] = {}
        self.jpeg_ready = threading.Condition()
        self.detector = None
        self.eye.on_prompts_changed = self._load_prompts
        self._prompts_dirty = threading.Event()

    # ---------- what the server asks for ----------

    def wait_jpeg(self, camera_id: str, seen: int, timeout: float):
        with self.jpeg_ready:
            self.jpeg_ready.wait_for(lambda: self.jpegs.get(camera_id, (-1, b""))[0] != seen, timeout)
            return self.jpegs.get(camera_id, (seen, None))

    def stream_url(self, camera_id: str) -> str:
        return f"http://{self.config.eye.public_host}:{self.config.eye.port}/stream/{camera_id}.mjpg"

    def camera_health(self) -> list[dict]:
        return [{"id": cam_id, "online": src.online, "fps": src.fps(), "streamUrl": self.stream_url(cam_id)} for cam_id, src in self.sources.items()]

    def health(self) -> dict:
        return {"ok": True, "hub": self.hub.url, "hubError": self.hub.last_error, "sim": self.sim is not None, "cameras": self.camera_health(), **self.eye.health()}

    def debug_jpeg(self, camera_id: str) -> Optional[bytes]:
        src = self.sources.get(camera_id)
        if src is None or src.frame is None:
            return None
        cv2 = cv()
        img = src.frame.copy()
        h, w = img.shape[:2]
        px = lambda pts: (np.asarray(pts) * [w, h]).astype(np.int32).reshape(-1, 1, 2)  # noqa: E731
        from .geometry import cell_corners  # noqa: PLC0415

        with self.eye.lock:
            for zone in self.eye.zones_for(camera_id):
                cv2.polylines(img, [px(zone["quad"])], True, (255, 255, 255), 2)
                cv2.putText(img, f"{zone['id']} {self.eye.counts.get(zone['id'], ('?',))[0]}", tuple(px(zone["quad"])[0][0] + [4, -8]), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
                if zone["kind"] == "pockets" and zone["rows"] and zone["cols"]:
                    state = self.eye.counts.get(zone["id"], (0, ()))[1] or ()
                    levels = self.eye.levels.get(zone["id"], [])
                    for index in range(zone["rows"] * zone["cols"]):
                        corners = px(cell_corners(zone["quad"], zone["rows"], zone["cols"], index, self.config.pockets.inset))
                        full = index < len(state) and state[index]
                        cv2.polylines(img, [corners], True, (61, 239, 224) if full else (5, 75, 250), 2)
                        if index < len(levels):
                            cv2.putText(img, f"{index}:{levels[index]:.0f}", tuple(corners[0][0] + [2, 16]), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 255), 1)
            for item in self.eye.outlines.get(camera_id, []):
                cv2.polylines(img, [px(item["points"])], True, (61, 239, 224), 1)
            note = self.eye.notes.get(camera_id) or ("still" if self.eye.settled.get(camera_id) else "moving")
        cv2.putText(img, note, (16, h - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        return encode_jpeg(img, 80)

    def capture_prompt(self, zone_id: str) -> Optional[str]:
        """Saves what is in an open zone now as its part's example picture. Put exactly one of the part there first."""
        from .teach import crop_quad  # noqa: PLC0415

        zone = next((z for z in self.eye.zones if z["id"] == zone_id), None)
        if zone is None or not zone["productId"]:
            return f"No zone {zone_id} with a part in it."
        src = self.sources.get(zone["camera"])
        if src is None or src.frame is None:
            return "No frame from that camera yet."
        self.eye.save_prompt(zone["productId"], crop_quad(src.frame, zone["quad"]), (0.05, 0.05, 0.95, 0.95))
        return None

    # ---------- loops ----------

    def _capture_loop(self, cam_id: str) -> None:
        src = self.sources[cam_id]
        gap = 1.0 / self.config.eye.stream_fps
        last = 0.0
        while not self.stopping.is_set():
            if not src.step():
                time.sleep(0.02)
                continue
            now = time.monotonic()
            if now - last < gap * 0.75:  # a little early is fine, or a 30 fps camera would stream at 15
                continue
            last = now
            frame = src.frame
            width = self.config.eye.stream_width
            if frame.shape[1] > width:
                frame = cv().resize(frame, (width, int(frame.shape[0] * width / frame.shape[1])), interpolation=cv().INTER_AREA)
            jpeg = encode_jpeg(frame, self.config.eye.stream_quality)
            with self.jpeg_ready:
                self.jpegs[cam_id] = (src.seq, jpeg)
                self.jpeg_ready.notify_all()

    def _analysis_loop(self) -> None:
        gap = 1.0 / self.config.eye.analysis_hz
        seen: dict[str, int] = {}
        while not self.stopping.is_set():
            started = time.monotonic()
            for cam_id, src in self.sources.items():
                if src.frame is None or seen.get(cam_id) == src.seq:
                    continue
                seen[cam_id] = src.seq
                try:
                    self.eye.analyse(cam_id, src.frame, time.monotonic())
                except Exception as err:  # noqa: BLE001  one bad frame must not stop the eye
                    self.log(f"Analysis failed on the {cam_id} camera: {err}")
            time.sleep(max(0.0, gap - (time.monotonic() - started)))

    def _zones_loop(self) -> None:
        told = False
        while not self.stopping.is_set():
            snapshot = self.hub.state()
            if snapshot is not None:
                if self.sim is not None:
                    self.eye.set_zones(snapshot)
                    self.sim.seed(snapshot)
                    self._sim_reference()
                else:
                    self.eye.set_zones(snapshot)
                if told:
                    self.log("The hub is back.")
                told = False
            elif not told:
                self.log(f"Cannot reach the hub. Still counting. {self.hub.last_error}")
                told = True
            self.stopping.wait(self.config.eye.zones_every_s)

    def _sim_reference(self) -> None:
        """The drawn board knows what empty looks like, so nobody has to clear it first."""
        from .frames import small_colour  # noqa: PLC0415

        for cam_id in self.cameras:
            key = str([[z["id"], z["quad"]] for z in self.eye.zones_for(cam_id)])
            if getattr(self, "_sim_ref", {}).get(cam_id) == key:
                continue
            self._sim_ref = {**getattr(self, "_sim_ref", {}), cam_id: key}
            with self.eye.lock:
                self.eye.references[cam_id] = small_colour(self.sim.render(cam_id, empty=True), self.config.eye.small_factor)
                self.eye.layouts.pop(cam_id, None)

    def _post_loop(self) -> None:
        last_health = 0.0
        while not self.stopping.is_set():
            now = time.monotonic()
            cameras = None
            if now - last_health >= 5.0:
                cameras, last_health = self.camera_health(), now
            if self.post:
                try:
                    self.eye.flush(now, cameras)
                except Exception as err:  # noqa: BLE001
                    self.log(f"Could not post counts: {err}")
            self.stopping.wait(0.1)

    def _load_prompts(self) -> None:
        self._prompts_dirty.set()

    def _detector_loop(self) -> None:
        mode = self.config.open.detector
        if mode in ("off", "blobs"):
            return
        try:
            from .detector import YoloeDetector  # noqa: PLC0415

            self.detector = YoloeDetector(self.config.open.model, self.config.open.imgsz, self.config.open.conf)
        except Exception as err:  # noqa: BLE001
            self.log(f"YOLOE is not available ({err}). Open zones are counted as difference blobs.")
            return
        loaded: list[str] = []
        gap = 1.0 / self.config.open.hz
        while not self.stopping.is_set():
            started = time.monotonic()
            try:
                prompts = self.eye.prompts()
                if [p[0] for p in prompts] != loaded or self._prompts_dirty.is_set():
                    self._prompts_dirty.clear()
                    self.detector.set_prompts(prompts)
                    loaded = [p[0] for p in prompts]
                    with self.eye.lock:
                        self.eye.yolo_zones = {z["id"] for z in self.eye.zones if z["kind"] != "pockets" and z["productId"] in loaded}
                    self.log(f"YOLOE is looking for: {', '.join(loaded) or 'nothing yet, no part has an example picture'}.")
                for cam_id, src in self.sources.items():
                    if src.frame is not None and any(z["id"] in self.eye.yolo_zones for z in self.eye.zones_for(cam_id)):
                        self.eye.take_detections(cam_id, self.detector.detect(src.frame))
            except Exception as err:  # noqa: BLE001
                self.log(f"YOLOE failed ({err}). Open zones go back to difference blobs.")
                with self.eye.lock:
                    self.eye.yolo_zones = set()
                    self.eye.detected = {}
                return
            self.stopping.wait(max(0.0, gap - (time.monotonic() - started)))

    def start(self) -> None:
        from . import frames  # noqa: PLC0415

        cv2 = cv()
        frames.FAST_SHRINK = lambda frame, f: cv2.resize(frame[..., :3], (frame.shape[1] // f, frame.shape[0] // f), interpolation=cv2.INTER_AREA).astype(np.float32)
        self.server = make_server(self, self.config.eye.port)
        loops = [(self._capture_loop, (c,)) for c in self.cameras] + [(self._analysis_loop, ()), (self._zones_loop, ()), (self._post_loop, ()), (self._detector_loop, ()), (self.server.serve_forever, ())]
        self.threads = [threading.Thread(target=fn, args=args, daemon=True) for fn, args in loops]
        for t in self.threads:
            t.start()

    def stop(self) -> None:
        self.stopping.set()
        self.server.shutdown()


def default_token() -> str:
    return os.environ.get("DEVICE_TOKEN", "dev-device-token")
