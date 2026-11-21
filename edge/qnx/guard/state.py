"""What the node needs to keep working alone, saved from every heartbeat: zones, reorder points, orders waiting for a yes."""
from __future__ import annotations

import json
import os
from pathlib import Path

EMPTY = {"zones": [], "reorderPoints": [], "awaitingApproval": []}


def save_json(path: Path, value) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(value, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def load_json(path: Path, fallback):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return fallback


def zones_text(zones: list[dict], camera: str = "node") -> str:
    """The zones as plain lines the C++ vision reads with no JSON parser.

    zone <id> <kind> <rows> <cols> <eight numbers: the quad, clockwise from the top left>
    Only zones this camera can see. The Pi has its own camera, so its zones carry its own quads.
    """
    lines = []
    for z in zones:
        if z.get("camera") != camera:
            continue
        quad = " ".join(f"{v:.5f}" for point in z["quad"] for v in point)
        lines.append(f"zone {z['id']} {z['kind']} {z.get('rows') or 0} {z.get('cols') or 0} {quad}")
    return "\n".join(lines) + ("\n" if lines else "")
