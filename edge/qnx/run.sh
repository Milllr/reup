#!/bin/sh
# Starts the shelf node on the Pi: vision and the guard, each started again within a second if it exits.
# Usage: HUB_URL=https://wheredidallmyinventorygo.wtf DEVICE_TOKEN=... ./run.sh
cd "$(dirname "$0")" || exit 1
: "${HUB_URL:?Set HUB_URL, for example https://wheredidallmyinventorygo.wtf}"
: "${DEVICE_TOKEN:?Set DEVICE_TOKEN}"
export HUB_URL DEVICE_TOKEN
export GUARD_DATA="${GUARD_DATA:-$PWD/data}"
mkdir -p "$GUARD_DATA"
# The camera runs at 1080p: the eye on the laptop counts parts in the same frames the hand model looks at.
export REUP_MIN_PIXELS="${REUP_MIN_PIXELS:-2073600}"
# The workshop program opens a window. Started over SSH it has to be told where the desktop is.
if [ -z "$WAYLAND_DISPLAY" ]; then
  desk="/var/run/user/$(id -u)"
  for sock in "$desk"/wayland-*; do
    case "$sock" in *.lock) continue ;; esac
    if [ -S "$sock" ]; then
      export XDG_RUNTIME_DIR="$desk" WAYLAND_DISPLAY="$(basename "$sock")" GDK_BACKEND=wayland GSK_RENDERER="${GSK_RENDERER:-cairo}"
      break
    fi
  done
fi
# The workshop program with the reup hook built in. See README.md.
VISION="${VISION_CMD:-$HOME/QNX-AI-workshop/start.sh --ros-args -p camera_unit:=5}"
GUARD="python3 -m guard"
# On QNX the guard runs above vision (priority 20 against the usual 10), so a busy model never delays the ledger or the button.
if command -v on >/dev/null 2>&1; then GUARD="on -p 20 $GUARD"; fi
exec python3 supervisor.py --vision "$VISION" --guard "$GUARD" --data "$GUARD_DATA"
