"""Puts the reup lines into the QNX AI workshop hand tracker. Run it on the Pi, once, before ./build.sh.

Usage: python3 vision/patch_workshop.py ~/QNX-AI-workshop

It copies the reup headers next to handtrack_node.cpp and makes five small changes. Running it again changes nothing.
1. handtrack_node.cpp includes reup_hook.hpp.
2. Every frame the hand model has looked at goes to reup::feed, with the hands it found: reaches, pockets, the snapshot.
3. Every frame the camera gives goes to reup::offer: the picture for the eye on the laptop and for the board page.
4. The window opens at a third of the camera's size when the camera runs at more than 1280 wide, so it sits beside
   the browser on the same screen. The camera itself stays at full size.
5. rpi_cam.cpp takes its smallest size from REUP_MIN_PIXELS when that is set. The workshop asks for 720p, which is
   enough for hands. The eye counts parts in the same frames and was set up on 1080p.
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EDITS = {
    "handtrack_node.cpp": [
        ('#include "rpi_cam.hpp"', '#include "rpi_cam.hpp"\n#include "reup_hook.hpp"', "reup_hook.hpp"),
        ("    auto hands = pipe->detect(frame, 2);", "    auto hands = pipe->detect(frame, 2);\n    reup::feed(hands, frame);", "reup::feed"),
        ("    if (!g_run.load()) return;\n\n    // Resized here", "    if (!g_run.load()) return;\n    reup::offer(bgr);\n\n    // Resized here", "reup::offer"),
        ("  if (gui.open(cw, ch) != 0) {", "  const int reup_w = cw > 1280 ? cw / 3 : cw, reup_h = cw > 1280 ? ch / 3 : ch;\n  if (gui.open(reup_w, reup_h) != 0) {", "reup_w"),
    ],
    "rpi_cam.cpp": [
        ("    constexpr long MIN_PIXELS = 1280 * 720;", "    const char *reup_min = std::getenv(\"REUP_MIN_PIXELS\");\n    const long MIN_PIXELS = reup_min ? std::atol(reup_min) : 1280 * 720;", "REUP_MIN_PIXELS"),
        ('#include "rpi_cam.hpp"', '#include "rpi_cam.hpp"\n\n#include <cstdlib>', "<cstdlib>"),
    ],
}


def patch(workshop: Path) -> list[str]:
    """Returns what it did, one line a change. Raises when a line it needs is not where the workshop had it."""
    done = []
    for name in ("reup_math.hpp", "reup_vision.hpp", "reup_stream.hpp", "reup_hook.hpp"):
        shutil.copyfile(HERE / "src" / name, workshop / name)
    for name, edits in EDITS.items():
        path = workshop / name
        text = path.read_text(encoding="utf-8")
        for old, new, mark in edits:
            if mark in text:
                continue
            if old not in text:
                raise SystemExit(f"{name}: could not find the line to change for {mark}. The workshop code may have moved on: {old!r}")
            text = text.replace(old, new, 1)
            done.append(f"{name}: {mark}")
        path.write_text(text, encoding="utf-8")
    return done


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python3 vision/patch_workshop.py ~/QNX-AI-workshop")
    changes = patch(Path(sys.argv[1]).expanduser())
    print("\n".join(changes) if changes else "Nothing to change: the reup lines are already there.")
