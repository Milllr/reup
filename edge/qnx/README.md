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

1. Get the workshop code onto the Pi at `~/QNX-AI-workshop` and set it up once as its README says: `sudo ./configure.sh`
2. Copy this folder to the Pi as `~/reup-node`.
3. Put the reup lines into the workshop program: `python3 ~/reup-node/vision/patch_workshop.py ~/QNX-AI-workshop`
4. Build: `cd ~/QNX-AI-workshop && ./build.sh`

The patch is seven lines in three files and is listed at the top of `vision/patch_workshop.py`. Running it again changes nothing.

Bring everything up, from the station laptop: `powershell -NoProfile -ExecutionPolicy Bypass -File edge\qnx\pi_up.ps1`

`pi_up.ps1` checks the eye has its camera, asks the Pi which of the laptop's addresses it can reach, and runs `up.sh` on the Pi with that address as the camera. `up.sh` sets the clock, starts the QNX desktop with its lock and sleep off, starts the node, and puts the desktop in front with the hand model's window full screen. Both start only what is not running, so they are also the commands after a reboot. The node alone, on the Pi: `HUB_URL=... DEVICE_TOKEN=... REUP_CAMERA_URL=http://169.254.138.173:8089/stream/board.mjpg ./run.sh`

## Where the camera is

The station has one camera and it is plugged into the laptop. The eye there counts the parts and serves its pictures on port 8089. The Pi reads that stream over the direct cable (`REUP_CAMERA_URL`, `vision/src/reup_netcam.hpp`) and QNX's hand model looks at every picture. The Pi is beside the counting, not in its way: unplug the Pi and the board is still counted and orders are still placed.

It was the other way round for twenty minutes (Sunday 3:55 AM to 4:15 AM): the camera on the Pi, the Pi serving the frames (`vision/src/reup_stream.hpp`, port 8089) and the eye reading them. It worked and the counts were right. It was dropped for one measured reason. The camera sends uncompressed pictures, and the USB link on QNX carried about 8 MB of them a second whatever the size:

| On the Pi's USB, size and format | Pictures a second |
| --- | --- |
| 640x360 YCbYCr | 17.4 |
| 1280x720 NV12 | 5.9 |
| 1920x1080 YCbYCr | 1.9 |

Over the cable from the laptop the Pi gets 1280x720 at 9 to 18 pictures a second, the rate the eye serves them. It drops to about 5 while the eye is busy with a hand in the picture. The hand model takes 27 to 59 ms a picture.

A camera on the Pi's own USB still works: leave `REUP_CAMERA_URL` out, and set the camera's size once with `sudo python3 ~/reup-node/vision/set_camera.py` (the workshop program opens the camera read only and may not change it). The node then serves its frames on port 8089, and `url` under `[cameras.board]` in `services/eye/config.toml` points the eye at them.

Counting stays on the laptop either way. The part detector is a PyTorch model and there is no PyTorch for QNX.

## The Pi's screen, with no keyboard

At the table the Pi has a mouse and no keyboard. QNX shows one window at a time (the launcher, the login terminal, the desktop) and switches with Alt and Tab, so after a boot the screen shows a login prompt until something presses keys. `up.sh` does that.

`tv/keys.py` presses keys from SSH. It starts QNX's own VNC server on a spare port for as long as the keys take, sends them, and stops it.

* The next QNX window: `sudo python3 ~/reup-node/tv/keys.py alt+tab`
* A click, in the screen's own pixels: `sudo python3 ~/reup-node/tv/keys.py click:512,310`
* What is on the screen right now, as a file: `sudo screenshot -file=/tmp/tv.bmp`

The hand model's window is the whole screen (`REUP_FULLSCREEN`, `REUP_WINDOW_WIDTH`). Do not send `q` or `esc` to it: both close it, and the supervisor starts it again.

The site in the Pi's own browser was tried (`SITE_URL=https://wheredidallmyinventorygo.wtf` for `up.sh` opens it full screen, with the hand window as an inset). Epiphany on the QNX desktop showed the live site and followed a take to the Shopping screen. It was soft and slow, and the screen came up at 1024 x 600 on the station's TV, not the 1920 x 1080 in the screen config. So the site is shown on the laptop.

## Level 2: teach the Pi where the pockets are

The Pi's camera sees the board from its own angle, so it needs its own corners for each pocket zone.

1. `./snapshot.sh`, then copy `data/snapshot.ppm` to a laptop and open it.
2. For each pocket zone read the four corners, clockwise from the top left, as a fraction of the picture width and height.
3. Write them to `data/node-quads.txt`, one line a zone: `z-screws 0.10 0.20 0.60 0.20 0.60 0.50 0.10 0.50`
4. Start `./run.sh` again. The guard joins these corners with the rows, columns and parts the hub gives it, and writes `data/zones.txt` for vision.
5. Clear the board and run `./capture_reference.sh`. Put the parts back. The node is now level 2 and its counts are the counts of record.

`REUP_THRESHOLD` (default 18) is the same number as `threshold` in the eye's config.

## The wooden button

The Grove button goes on GPIO 16 (D16 on the Grove hat, a BCM number), read through the `rpi_gpio` module on the QNX image. Another pin: `GUARD_BUTTON_PIN=5 ./run.sh`. No GPIO module: point `GUARD_BUTTON_FILE` at any file that holds 1 while the button is down. A press approves the oldest order that is waiting for a yes. Presses within one second count once.

A press counts only after the pin was at rest for 0.3 s and then down for 0.04 s. The level the pin starts at is never a press. On the station's Pi every free pin read high with nothing wired, through `rpi_gpio` and through `/dev/gpio`, with either pull. Before this rule a guard that started while an order waited would have approved it by itself. The guard says so once in the log when the pin has read pressed since the start.

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

Checked on a laptop: every guard and supervisor rule in `tests/`, the C++ math, the camera stream and the whole C++ pipeline on drawn frames, and the full node run against a local hub with `tools/fake_vision.py` (offline queue, the reorder call, the button, a killed vision).

Checked on the Pi, Sunday Nov 22 from 3:20 AM to 4:25 AM:

* The patched workshop program builds on the Pi and runs.
* With the laptop's camera as its camera: 1280x720, 9 to 18 pictures a second, inference 27 to 59 ms, hands found, full screen on the TV.
* Reaches by real hands are in the ledger on the Pi's disk (`data/ledger.jsonl`), and the hub shows the node online at level 1.
* The guard runs at priority 20 and vision at 10 (`pidin`).
* Vision killed with `slay -f handtrack_node`: the hand model was ready again 3.5 s after the kill. Through the workshop's `start.sh` it took 36 s, so `run.sh` sets ROS 2 up once and starts the program itself.
* With the camera on the Pi's own USB (the earlier layout): the eye read the Pi's stream and counted the live board right, washers 3, bolts 3, MWAX 4, 9V 3.

Not checked: a real button on a pin (every pin read high with nothing wired), a reach that names its ledge (the node has no zones for this board yet), the pockets at level 2, and the network cable pulled on purpose.
