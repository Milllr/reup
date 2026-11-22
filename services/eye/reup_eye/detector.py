"""Open zone counting with YOLOE-26 and visual prompts. Imported only when config asks for it and ultralytics is installed.

Each part has one example: a whole frame and the box of one of the part in it. The model turns each example into an
embedding, the embeddings are joined into one set of classes, and after that every frame is looked at with no prompts.

Whole frames matter. Tried on the board as built: one frame with a box on each part found all 13 parts on 61 looks out
of 61, while the same parts cut out and tiled side by side found almost none.
"""
from __future__ import annotations

import numpy as np


def pixel_boxes(shape: tuple, boxes) -> np.ndarray:
    """Boxes given from 0 to 1 as pixels of an image of this shape. One row a box: x0, y0, x1, y1."""
    h, w = shape[:2]
    return np.array([[x0 * w, y0 * h, x1 * w, y1 * h] for x0, y0, x1, y1 in boxes], dtype=float).reshape(-1, 4)


class YoloeDetector:
    def __init__(self, model: str, imgsz: int, conf: float):
        from ultralytics import YOLOE  # noqa: PLC0415  raises ImportError when ultralytics is not installed

        self._load = lambda: YOLOE(model)
        self.imgsz = imgsz
        self.conf = conf
        self.model = None
        self.products: list[str] = []

    def _embed(self, model, image: np.ndarray, boxes) -> object:
        """The embedding of one part: what the model sees inside the boxes on this image. Shape (1, 1, 512)."""
        from ultralytics.models.yolo.yoloe import YOLOEVPSegPredictor  # noqa: PLC0415

        # The same steps YOLOE.predict takes for refer_image, kept apart so every part can come from its own frame.
        predictor = YOLOEVPSegPredictor(overrides={"task": "segment", "mode": "predict", "save": False, "verbose": False, "batch": 1, "imgsz": self.imgsz})
        px = pixel_boxes(image.shape, boxes)
        predictor.set_prompts({"bboxes": px, "cls": np.zeros(len(px), dtype=int)})
        predictor.setup_model(model=model.model, verbose=False)
        return predictor.get_vpe(image)

    def set_prompts(self, prompts: list[tuple[str, np.ndarray, list]]) -> None:
        """Fixes what to look for: (productId, a whole frame, the boxes of that part in it). A fresh model each time."""
        self.products = [p[0] for p in prompts]
        if not prompts:
            self.model = None
            return
        import torch  # noqa: PLC0415

        model = self._load()
        embeddings = [self._embed(model, image, boxes) for _product, image, boxes in prompts]
        model.set_classes(list(self.products), torch.cat(embeddings, dim=1))
        model.predictor = None
        self.model = model

    def detect(self, frame: np.ndarray) -> list[dict]:
        """Every instance found: productId, centre and outline, normalized to the frame."""
        if self.model is None:
            return []
        result = self.model.predict(frame, imgsz=self.imgsz, conf=self.conf, verbose=False)[0]
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
