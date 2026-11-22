"""Puts the reup lines into the QNX AI workshop hand tracker. Run it on the Pi, once, before ./build.sh.

Usage: python3 vision/patch_workshop.py ~/QNX-AI-workshop

It copies the reup headers next to handtrack_node.cpp and makes these small changes. Running it again changes nothing.
1. handtrack_node.cpp includes reup_hook.hpp and reup_camera.hpp.
2. Every frame the hand model has looked at goes to reup::feed, with the hands it found: reaches, pockets, the snapshot.
3. Every frame the camera gives goes to reup::offer, which serves it on REUP_STREAM_PORT when that is set above 0.
4. The window opens 480 wide (REUP_WINDOW_WIDTH changes that) when the camera is wider than 640, and full screen when
   REUP_FULLSCREEN is set. The hand model looks at the picture at the window's size.
5. rpi_cam.cpp takes its smallest size from REUP_MIN_PIXELS when that is set.
6. The camera is a reup::Camera: the Pi's own USB camera as before, or with REUP_CAMERA_URL set, the pictures another
   machine serves as MJPEG. On the station that is the laptop, where the one camera is plugged in.
7. CMakeLists.txt links libsocket: the camera stream uses sockets, and on QNX they are not in libc.
"""
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
EDITS = {
    "handtrack_node.cpp": [
        ('#include "rpi_cam.hpp"', '#include "rpi_cam.hpp"\n#include "reup_hook.hpp"\n#include "reup_camera.hpp"', "reup_hook.hpp"),
        ("  RpiCam cam(static_cast<camera_unit_t>(unit));", "  reup::Camera cam(static_cast<camera_unit_t>(unit));", "reup::Camera cam"),
        ("    auto hands = pipe->detect(frame, 2);", "    auto hands = pipe->detect(frame, 2);\n    reup::feed(hands, frame);", "reup::feed"),
        ("    if (!g_run.load()) return;\n\n    // Resized here", "    if (!g_run.load()) return;\n    reup::offer(bgr);\n\n    // Resized here", "reup::offer"),
        ("  if (gui.open(cw, ch) != 0) {", "  const char *reup_win = std::getenv(\"REUP_WINDOW_WIDTH\");\n  const int reup_w = reup_win && std::atoi(reup_win) > 0 ? std::atoi(reup_win) : (cw > 640 ? 480 : cw), reup_h = reup_w * ch / cw;\n  if (gui.open(reup_w, reup_h) != 0) {", "reup_w"),
        ("  const int DW = gui.width(), DH = gui.height();", "  if (std::getenv(\"REUP_FULLSCREEN\")) gui.toggle_fullscreen();\n  const int DW = gui.width(), DH = gui.height();", "REUP_FULLSCREEN"),
    ],
    "CMakeLists.txt": [
        ('target_link_libraries(handtrack_node "${cpp_typesupport_target}")', 'target_link_libraries(handtrack_node "${cpp_typesupport_target}")\n# reup: the camera stream uses sockets, which on QNX are in libsocket.\ntarget_link_libraries(handtrack_node socket)', "handtrack_node socket"),
    ],
    "rpi_cam.cpp": [
        ("    constexpr long MIN_PIXELS = 1280 * 720;", "    const char *reup_min = std::getenv(\"REUP_MIN_PIXELS\");\n    const long MIN_PIXELS = reup_min ? std::atol(reup_min) : 1280 * 720;", "REUP_MIN_PIXELS"),
        ('#include "rpi_cam.hpp"', '#include "rpi_cam.hpp"\n\n#include <cstdlib>', "<cstdlib>"),
    ],
}


def patch(workshop: Path) -> list[str]:
    """Returns what it did, one line a change. Raises when a line it needs is not where the workshop had it."""
    done = []
    for name in ("reup_math.hpp", "reup_vision.hpp", "reup_stream.hpp", "reup_hook.hpp", "reup_netcam.hpp", "reup_camera.hpp"):
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
