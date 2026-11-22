#!/bin/sh
# Starts the shelf node on the Pi: vision and the guard, each started again within a second if it exits.
# Usage: HUB_URL=https://wheredidallmyinventorygo.wtf DEVICE_TOKEN=... ./run.sh
cd "$(dirname "$0")" || exit 1
: "${HUB_URL:?Set HUB_URL, for example https://wheredidallmyinventorygo.wtf}"
: "${DEVICE_TOKEN:?Set DEVICE_TOKEN}"
export HUB_URL DEVICE_TOKEN
export GUARD_DATA="${GUARD_DATA:-$PWD/data}"
mkdir -p "$GUARD_DATA"
# The camera's size and format are set in the Pi's sensor config (vision/set_camera.py), not here: the workshop program
# opens the camera read only. This only names the smallest picture it should ask for where it is allowed to ask.
export REUP_MIN_PIXELS="${REUP_MIN_PIXELS:-921600}"
# The workshop program opens a window. Started over SSH it has to be told where the desktop is.
. ./desk.sh
# The workshop program with the reup hook built in. See README.md.
WORKSHOP="${WORKSHOP_DIR:-$HOME/QNX-AI-workshop}"
NODE="$WORKSHOP/install/lib/handtrack/handtrack_node"
VISION="${VISION_CMD:-$WORKSHOP/start.sh --ros-args -p camera_unit:=${CAMERA_UNIT:-5}}"
GUARD="python3 -m guard"
# On QNX the guard runs above vision (priority 20 against the usual 10), so a busy model never delays the ledger or the button.
if command -v on >/dev/null 2>&1; then GUARD="on -p 20 $GUARD"; fi
# start.sh sets up ROS 2 and goes through the ros2 launcher: measured on the Pi, 35 s from a kill to the first frame.
# So ROS 2 is set up once, here, and the supervisor starts the program itself. Killed, it is back in about a second.
if [ -z "$VISION_CMD" ] && [ -x "$NODE" ] && [ -f /opt/ros/jazzy/setup.bash ] && command -v bash >/dev/null 2>&1; then
  VISION="$NODE --ros-args -p camera_unit:=${CAMERA_UNIT:-5}"
  exec bash -c 'export COLCON_CURRENT_PREFIX=/opt/ros/jazzy; . /opt/ros/jazzy/setup.bash; . "$1/install/local_setup.bash"; shift; exec python3 supervisor.py "$@"' reup "$WORKSHOP" --vision "$VISION" --guard "$GUARD" --data "$GUARD_DATA"
fi
exec python3 supervisor.py --vision "$VISION" --guard "$GUARD" --data "$GUARD_DATA"
