"""Threads and OpenCV: the cameras, the stream, the loops that call the eye, and the detector. Run by python -m reup_eye."""
from __future__ import annotations

import os
import sys
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

from .align import HEIGHT, WIDTH, Steady, edges, estimate, for_frame, moved
from .app import Eye
from .config import camera_ways
from .frames import FrameSource, ReferenceStore
from .hubclient import Hub
from .server import make_server


def cv():
    # Media Foundation takes about 8 seconds to open a USB camera with its hardware transforms on, and 0.2 without.
    os.environ.setdefault("OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS", "0")
    import cv2  # noqa: PLC0415  only the runtime needs OpenCV

    return cv2


def encode_jpeg(frame: np.ndarray, quality: int) -> bytes:
    ok, data = cv().imencode(".jpg", frame, [cv().IMWRITE_JPEG_QUALITY, int(quality)])
    return data.tobytes() if ok else b""


BACKEND_NAMES = {1400: "Media Foundation", 700: "DirectShow", 0: "default"}


def capture_backends() -> list[int]:
    """The ways OpenCV can open a camera here, in the order to try them.

    Windows: Media Foundation first. DirectShow refused the Facecam MK.2 on Windows 11 ("can't be used to capture by
    index", insufficient system resources) while Media Foundation gave 1080p at 30.
    """
    cv2 = cv()
    return [cv2.CAP_MSMF, cv2.CAP_DSHOW] if sys.platform == "win32" else [cv2.CAP_ANY]


def camera_listings() -> list[tuple[int, Optional[dict[int, str]]]]:
    """For each backend: (backend, {index: device name}). The names are None when cv2-enumerate-cameras is not installed.

    The two Windows backends number the cameras on their own, so each has its own list. Listing takes a few milliseconds
    and opens nothing.
    """
    backends = capture_backends()
    try:
        from cv2_enumerate_cameras import enumerate_cameras  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return [(backend, None) for backend in backends]
    out: list[tuple[int, Optional[dict[int, str]]]] = []
    for backend in backends:
        try:
            out.append((backend, {int(c.index): str(c.name) for c in enumerate_cameras(backend)}))
        except Exception:  # noqa: BLE001
            out.append((backend, None))
    return out


def cv_opener(cam):
    def open_(way):
        backend, index = way
        cv2 = cv()
        capture = cv2.VideoCapture(index, backend)
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
        # A camera that config.toml turns off is never opened. The drawn board has every camera.
        self.cameras = [cam_id for cam_id, cam in config.cameras.items() if sim or cam.enabled]
        self.sim = None
        self.sources: dict[str, FrameSource] = {}
        if sim:
            from .sim import SimBoard, SimCamera  # noqa: PLC0415

            self.sim = SimBoard(self.eye)
            for cam_id in self.cameras:
                self.sources[cam_id] = FrameSource(cam_id, [0], lambda _i, c=cam_id: SimCamera(self.sim, c))
        else:
            for cam_id in self.cameras:
                cam = config.cameras[cam_id]
                self.sources[cam_id] = FrameSource(cam_id, self._ways(cam_id, cam), cv_opener(cam))
        # Camera alignment: the edges of each camera's home picture, and the move that puts a bumped picture back.
        self.aligning = bool(config.align.enabled) and not sim
        self.home: dict[str, Optional[np.ndarray]] = {}
        self.steady: dict[str, Steady] = {}
        self.data_dir = Path(data_dir)
        if self.aligning:
            a = config.align
            for cam_id in self.cameras:
                self.steady[cam_id] = Steady(a.min_phase, a.min_match, a.hidden_phase, a.dead_px, 1.0, a.max_shift, a.max_turn)
                try:
                    self.home[cam_id] = np.load(self.home_path(cam_id))
                except (OSError, ValueError):
                    self.home[cam_id] = None
            self.eye.pose_check = True
        self.jpegs: dict[str, tuple[int, bytes]] = {}
        self.jpeg_ready = threading.Condition()
        self.detector = None
        self._align: dict[str, dict] = {}
        self._hann = None
        self.eye.on_prompts_changed = self._load_prompts
        self._prompts_dirty = threading.Event()

    def _ways(self, cam_id: str, cam):
        """Looks the camera up by name before every try to open it, and says so once when it cannot be found."""
        said: list[Optional[str]] = [None]

        def ways():
            found, note = camera_ways(cam.name, cam.index, camera_listings())
            if note and note != said[0]:
                self.log(f"The {cam_id} camera: {note}")
            said[0] = note
            return found

        return ways

    # ---------- the camera's home position ----------

    def home_path(self, cam_id: str) -> Path:
        return self.data_dir / f"home-{cam_id}.npy"

    def set_home(self, cam_id: str) -> bool:
        """This is where the camera sits now. Zones are drawn on this picture, and a bumped picture is moved back to it."""
        src = self.sources.get(cam_id)
        if not self.aligning or src is None or src.raw is None:
            return False
        self.home[cam_id] = edges(cv(), src.raw)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        np.save(self.home_path(cam_id), self.home[cam_id])
        self.steady[cam_id].reset()
        src.transform = None
        self.eye.set_hidden(cam_id, None)
        self.eye.pose_verified(cam_id)
        self.log(f"Saved where the {cam_id} camera sits.")
        return True

    def _put_back(self, cam_id: str, matrix: Optional[np.ndarray]) -> None:
        """Every later frame from this camera is moved by matrix before anything looks at it. None leaves frames alone."""
        src = self.sources[cam_id]
        if matrix is None:
            src.transform = None
            return
        cv2 = cv()

        def transform(frame: np.ndarray) -> np.ndarray:
            return cv2.warpAffine(frame, for_frame(matrix, frame.shape[1]), (frame.shape[1], frame.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)

        src.transform = transform

    def align_step(self, cam_id: str, now: float) -> None:
        """One look at whether the camera is where it should be. Called a few times a second, works about once a second."""
        src, steady, state = self.sources[cam_id], self.steady[cam_id], self._align.setdefault(cam_id, {"at": float("-inf"), "since": None, "hidden_since": None, "said": None})
        if src.raw is None or not self.eye.still.get(cam_id, False):
            state["since"] = None
            return
        waiting = cam_id in self.eye.unverified
        if not waiting and now - state["at"] < self.config.align.every_s:
            return
        state["at"] = now
        cv2 = cv()
        seen = edges(cv2, src.raw)
        if self.home.get(cam_id) is None:
            self.set_home(cam_id)
            return
        found = estimate(cv2, self.home[cam_id], seen, self._window(), steady.matrix if steady.is_moved() else None)
        before = steady.is_moved()
        if steady.update(found):
            self._put_back(cam_id, steady.matrix if steady.is_moved() else None)
            px = moved(steady.matrix) * src.raw.shape[1] / WIDTH
            self._say(state, f"The {cam_id} camera moved {px:.0f} pixels. The picture is lined up again." if steady.is_moved() else f"The {cam_id} camera is back where it was.")
            return  # the picture just changed: the next look checks it
        sure = found is not None and found["phase"] >= steady.min_phase and found["match"] >= steady.min_match
        if steady.hidden:
            state["hidden_since"] = state["hidden_since"] or now
            if now - state["hidden_since"] <= self.config.align.hold_s:
                self.eye.set_hidden(cam_id, "The board is hidden, or the camera moved a long way. Counts are held.")
                self._say(state, f"The {cam_id} camera cannot see the board it knows. Counts are held for up to {self.config.align.hold_s:.0f} seconds.")
                return
            self._say(state, f"The {cam_id} camera still cannot see the board it knows. Counting goes on. If the camera was moved on purpose, draw the zones again and POST /anchor/{cam_id}.")
        else:
            state["hidden_since"] = None
        self.eye.set_hidden(cam_id, None)
        if steady.too_far:
            self._say(state, f"The {cam_id} camera moved too far to line up. Draw the zones again and POST /anchor/{cam_id}.")
        if not waiting:
            return
        # Counts wait for a sure look that agrees with the move in use. An unsure one is waited on for verify_s, no longer.
        state["since"] = state["since"] or now
        if (sure and steady.pending is None) or now - state["since"] >= self.config.align.verify_s:
            self.eye.pose_verified(cam_id)
            state["since"] = None
            if sure and not steady.too_far and before == steady.is_moved():
                state["said"] = None

    def _say(self, state: dict, text: str) -> None:
        if state["said"] != text:
            state["said"] = text
            self.log(text)

    def _window(self):
        if self._hann is None:
            self._hann = cv().createHanningWindow((WIDTH, HEIGHT), cv().CV_32F)
        return self._hann

    def _align_loop(self) -> None:
        while not self.stopping.is_set():
            for cam_id in self.cameras:
                try:
                    self.align_step(cam_id, time.monotonic())
                except Exception as err:  # noqa: BLE001  alignment must never stop the eye, or hold its counts
                    self.eye.pose_verified(cam_id)
                    self.eye.set_hidden(cam_id, None)
                    self.log(f"Could not check the {cam_id} camera's position: {err}")
            self.stopping.wait(0.15)

    def alignment(self) -> dict:
        out = {}
        for cam_id, steady in self.steady.items():
            raw = self.sources[cam_id].raw
            scale = (raw.shape[1] if raw is not None else 1920) / WIDTH
            # moved is the move in use, in pixels of the frame. phase and match are from the last look.
            out[cam_id] = {"home": self.home.get(cam_id) is not None, "moved": round(moved(steady.matrix) * scale, 1), "hidden": steady.hidden, "too_far": steady.too_far, "phase": steady.last.get("phase"), "match": steady.last.get("match")}
        return out

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
        return {"ok": True, "hub": self.hub.url, "hubError": self.hub.last_error, "sim": self.sim is not None, "cameras": self.camera_health(), "aligned": self.alignment(), **self.eye.health()}

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
            # The thin grey box is where motion is watched and the room's brightness is read.
            cv2.polylines(img, [px(self.eye.board_quad(camera_id))], True, (170, 170, 170), 1)
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
            note = self.eye.hidden.get(camera_id) or self.eye.notes.get(camera_id) or ("still" if self.eye.settled.get(camera_id) else "moving")
        cv2.putText(img, note, (16, h - 16), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        return encode_jpeg(img, 80)

    def capture_prompt(self, zone_id: str, boxes: Optional[list] = None) -> Optional[str]:
        """Saves the frame as the example of the part in an open zone, for the detector.

        boxes are single parts in the frame, each x0, y0, x1, y1 from 0 to 1. One box is enough. Without any, the whole
        zone is the example, so put exactly one of the part there first.
        """
        zone = next((z for z in self.eye.zones if z["id"] == zone_id), None)
        if zone is None or not zone["productId"]:
            return f"No zone {zone_id} with a part in it."
        src = self.sources.get(zone["camera"])
        if src is None or src.frame is None:
            return "No frame from that camera yet."
        if not boxes:
            xs, ys = [p[0] for p in zone["quad"]], [p[1] for p in zone["quad"]]
            boxes = [(min(xs), min(ys), max(xs), max(ys))]
        clean = []
        for x0, y0, x1, y1 in boxes:
            x0, x1, y0, y1 = max(0.0, min(x0, x1)), min(1.0, max(x0, x1)), max(0.0, min(y0, y1)), min(1.0, max(y0, y1))
            if x1 - x0 < 0.002 or y1 - y0 < 0.002:
                return "That box is not a part of the picture."
            clean.append((x0, y0, x1, y1))
        self.eye.save_prompt(zone["productId"], src.frame.copy(), clean)
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
        """Runs the detector in its own process and hands its results to the eye. A detector that dies is started again."""
        mode = self.config.open.detector
        if mode in ("off", "blobs"):
            return
        from .detector_proc import DetectorProcess  # noqa: PLC0415

        # From here the zones with an example are the detector's, loaded or not. See Eye.detector_on.
        self.eye.set_detector(True)

        gap = 1.0 / self.config.open.hz
        failures = 0
        while not self.stopping.is_set():
            try:
                self.detector = DetectorProcess(self.config.open.model, self.config.open.imgsz, self.config.open.conf)
            except Exception as err:  # noqa: BLE001
                if failures == 0:
                    # It never ran: ultralytics or the weights are missing. Not something a second try fixes.
                    self.log(f"YOLOE is not available ({err}). Open zones are counted as difference blobs.")
                    self.eye.set_detector(False)
                    return
                self.log(f"YOLOE would not start again ({err}). Trying once more in 5 seconds.")
                self.stopping.wait(5.0)
                continue
            loaded: Optional[list[str]] = None
            try:
                while not self.stopping.is_set():
                    started = time.monotonic()
                    prompts = self.eye.prompts()
                    if [p[0] for p in prompts] != loaded or self._prompts_dirty.is_set():
                        self._prompts_dirty.clear()
                        self.detector.set_prompts(prompts)
                        loaded = [p[0] for p in prompts]
                        self.log(f"YOLOE is looking for: {', '.join(loaded) or 'nothing yet, no part has an example picture'}.")
                    for cam_id, src in self.sources.items():
                        if src.frame is not None and loaded and any(z["id"] in self.eye.yolo_zones for z in self.eye.zones_for(cam_id)):
                            self.eye.take_detections(cam_id, self.detector.detect(src.frame), loaded)
                    failures = 1  # it has worked, so from here a failure is worth another start
                    self.stopping.wait(max(0.0, gap - (time.monotonic() - started)))
            except Exception as err:  # noqa: BLE001
                # The zones it counted stay its zones, so their last counts stand until it is back. Nothing wrong is posted.
                failures += 1
                self.log(f"YOLOE failed ({err}). Starting it again.")
                with self.eye.lock:
                    self.eye.detected = {}
            finally:
                self.detector.close()
                self.detector = None
            self.stopping.wait(2.0)

    def start(self) -> None:
        from . import frames  # noqa: PLC0415

        cv2 = cv()
        frames.FAST_SHRINK = lambda frame, f: cv2.resize(frame[..., :3], (frame.shape[1] // f, frame.shape[0] // f), interpolation=cv2.INTER_AREA).astype(np.float32)
        self.server = make_server(self, self.config.eye.port)
        loops = [(self._capture_loop, (c,)) for c in self.cameras] + [(self._analysis_loop, ()), (self._zones_loop, ()), (self._post_loop, ()), (self._detector_loop, ()), (self.server.serve_forever, ())]
        if self.aligning:
            loops.append((self._align_loop, ()))
        self.threads = [threading.Thread(target=fn, args=args, daemon=True) for fn, args in loops]
        for t in self.threads:
            t.start()

    def stop(self) -> None:
        self.stopping.set()
        self.server.shutdown()
        if self.detector is not None:
            self.detector.close()


def default_token() -> str:
    return os.environ.get("DEVICE_TOKEN", "dev-device-token")
