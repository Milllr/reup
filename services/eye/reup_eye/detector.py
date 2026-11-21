"""Open zone counting with YOLOE-26 and visual prompts. Imported only when config asks for it and ultralytics is installed.

Each taught part has one example picture and the box of the part inside it. The examples are tiled onto one reference
image. Passing refer_image once fixes the classes, so later frames need no prompts (docs.ultralytics.com/models/yoloe).
"""
from __future__ import annotations

from typing import Optional

import numpy as np

TILE = 384


def reference_canvas(prompts: list[tuple[str, np.ndarray, tuple[float, float, float, float]]]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tiles the example pictures side by side. Returns the canvas, one box per part in pixels, and the class ids."""
    canvas = np.full((TILE, TILE * len(prompts), 3), 127, dtype=np.uint8)
    boxes = []
    for i, (_product, image, box) in enumerate(prompts):
        ys = (np.arange(TILE) * image.shape[0] / TILE).astype(int)
        xs = (np.arange(TILE) * image.shape[1] / TILE).astype(int)
        canvas[:, i * TILE : (i + 1) * TILE] = image[ys][:, xs, :3]
        x0, y0, x1, y1 = box
        boxes.append([i * TILE + x0 * TILE, y0 * TILE, i * TILE + x1 * TILE, y1 * TILE])
    return canvas, np.array(boxes, dtype=float), np.arange(len(prompts))


class YoloeDetector:
    def __init__(self, model: str, imgsz: int, conf: float):
        from ultralytics import YOLOE  # noqa: PLC0415  raises ImportError when ultralytics is not installed

        self._load = lambda: YOLOE(model)
        self.imgsz = imgsz
        self.conf = conf
        self.model = None
        self.products: list[str] = []
        self._pending: Optional[tuple[np.ndarray, np.ndarray, np.ndarray]] = None

    def set_prompts(self, prompts: list[tuple[str, np.ndarray, tuple[float, float, float, float]]]) -> None:
        """Fixes what to look for. A fresh model each time, because classes cannot be changed once they are fixed."""
        self.products = [p[0] for p in prompts]
        self.model = self._load() if prompts else None
        self._pending = reference_canvas(prompts) if prompts else None

    def detect(self, frame: np.ndarray) -> list[dict]:
        """Every instance found: productId, centre and outline, normalized to the frame."""
        if self.model is None:
            return []
        kwargs = {"imgsz": self.imgsz, "conf": self.conf, "verbose": False}
        if self._pending is not None:
            canvas, boxes, classes = self._pending
            results = self.model.predict(frame, refer_image=canvas, visual_prompts={"bboxes": boxes, "cls": classes}, **kwargs)
            self._pending = None
        else:
            results = self.model.predict(frame, **kwargs)
        result = results[0]
        if result.boxes is None or len(result.boxes) == 0:
            return []
        boxes = result.boxes.xyxyn.cpu().numpy()
        classes = result.boxes.cls.cpu().numpy().astype(int)
        outlines = result.masks.xyn if result.masks is not None else [None] * len(boxes)
        out = []
        for box, cls, outline in zip(boxes, classes, outlines):
            if not 0 <= cls < len(self.products):
                continue
            x0, y0, x1, y1 = (float(v) for v in box)
            points = outline.tolist() if outline is not None and len(outline) >= 3 else [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
            out.append({"productId": self.products[cls], "centre": [(x0 + x1) / 2, (y0 + y1) / 2], "points": points})
        return out
