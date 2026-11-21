# Shelf node (Raspberry Pi 5, QNX 8)

The part of reup that keeps working when everything else is gone. It sees hands reach for the board, counts the pockets, writes every event to a ledger on disk before sending it anywhere, and calls for a reorder by itself when the hub is silent.

Two processes and a supervisor:

* `vision/`: C++. The QNX AI workshop hand tracker (github.com/qnx/QNX-AI-workshop) with three header files added. It prints one JSON line an event.
* `guard/`: Python, standard library only. The ledger, the offline queue, the heartbeat, the reorder guard and the wooden button.
* `supervisor.py`: starts both, and starts either again within a second if it exits. Vision's lines reach the guard through one pipe the supervisor keeps open, so a restart of either side loses no line.

Nothing here builds in CI for QNX. CI runs the guard and supervisor tests with normal Python (`npm run test:py`) and compiles the C++ math and pipeline tests with g++ on the host (`npm run test:cpp`).

## The four levels

| Level | What the Pi does | The hub shows |
| --- | --- | --- |
| 1 | Reach start and end, the ledger, the heartbeat, the button | The feed frame reacts while a hand is over the board. The button approves |
| 2 | Pocket counts on the Pi | Counts of record come from the node: "Counted by the shelf node on QNX" |
| 3 | Supervised: either process is back within a second | Vision restarts on the operator page |
| 4 | A trained model on the Pi for open zones | Not built. The guard already takes a `count` line when vision can send one |

## Try it without a Pi

From `edge/qnx`, with the local stack running (`node tools/dev.mjs` at the repo root):

`HUB_URL=http://localhost:3000 DEVICE_TOKEN=dev-device-token VISION_CMD="python3 tools/fake_vision.py" ./run.sh`

Take two boxes: `echo 2 > data/take.flag`. Kill vision: `touch data/die.flag`. Press the button: start with `GUARD_BUTTON_FILE=/tmp/button` and write 1 then 0 into that file.

## On the Pi

Packages (the workshop's `configure.sh` installs them): `apk add opencv-dev tflite-runtime-dev tflite-runtime flatbuffers-dev gtk4-dev ros2-jazzy python3-dev python3-numpy python3-numpy-dev qnx-sf-base-dev`

Check Python can reach an https hub: `python3 -c "import ssl, json, urllib.request; print('ok')"`

Build vision:

1. Get the workshop code onto the Pi at `~/QNX-AI-workshop` and build it once as its README says (`sudo ./configure.sh`, then `./build.sh`). Run `./start.sh --ros-args -p camera_unit:=5` and see hand landmarks from the C270.
2. Copy `vision/src/reup_math.hpp`, `vision/src/reup_vision.hpp` and `vision/src/reup_hook.hpp` next to `handtrack_node.cpp`.
3. In `handtrack_node.cpp` add `#include "reup_hook.hpp"` under the other includes, and in `infer_worker`, on the line after `auto hands = pipe->detect(frame, 2);`, add `reup::feed(hands, frame);`
4. `./build.sh` again. That is the whole change: two lines in one file.

Run it: `HUB_URL=https://wheredidallmyinventorygo.wtf DEVICE_TOKEN=... ./run.sh`

The workshop program opens its window, so the Pi needs its display attached, as in the workshop.

## Level 2: teach the Pi where the pockets are

The Pi's camera sees the board from its own angle, so it needs its own corners for each pocket zone.

1. `./snapshot.sh`, then copy `data/snapshot.ppm` to a laptop and open it.
2. For each pocket zone read the four corners, clockwise from the top left, as a fraction of the picture width and height.
3. Write them to `data/node-quads.txt`, one line a zone: `z-screws 0.10 0.20 0.60 0.20 0.60 0.50 0.10 0.50`
4. Start `./run.sh` again. The guard joins these corners with the rows, columns and parts the hub gives it, and writes `data/zones.txt` for vision.
5. Clear the board and run `./capture_reference.sh`. Put the parts back. The node is now level 2 and its counts are the counts of record.

`REUP_THRESHOLD` (default 18) is the same number as `threshold` in the eye's config.

## The wooden button

The Grove button goes on GPIO 16 (D16 on the Grove hat), read through the `rpi_gpio` module on the QNX image. Another pin: `GUARD_BUTTON_PIN=5 ./run.sh`. No GPIO module: point `GUARD_BUTTON_FILE` at any file that holds 1 while the button is down. A press approves the oldest order that is waiting for a yes. Presses within one second count once.

## Priorities

`run.sh` starts the guard with `on -p 20` and leaves vision at the usual 10, so a busy hand model never delays the ledger or the button. See them with: `pidin -F "%a %p %n" | grep -e python3 -e handtrack_node`

## For the judges

`./judge_demo.sh` prints the three things to show and the exact commands: kill vision, pull the network cable, press the button.

## What is on disk, in `data/`

| File | What |
| --- | --- |
| ledger.jsonl | Every reach, pick, count, reorder call and approval, fsynced before it is sent. Never rewritten |
| outbox.jsonl | What the hub has not accepted yet, in order |
| hub.json | Zones, reorder points and waiting orders from the last heartbeat, so the node can decide alone |
| zones.txt | The zones for vision, with the Pi camera's corners |
| reference.bgr | The empty board |
| restarts.json | How many times each process was started again |

## What was checked, and what was not

Checked on a laptop: every guard and supervisor rule in `tests/`, the C++ math and the whole C++ pipeline on drawn frames, and the full node run against a local hub with `tools/fake_vision.py` (offline queue, the reorder call, the button, a killed vision).

Not checked, because it needs the Pi: the build inside the workshop program, the camera, the `rpi_gpio` button, and the `on -p` priority. Those are the human tasks NH1 to NH4.
