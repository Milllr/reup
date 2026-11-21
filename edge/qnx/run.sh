#!/bin/sh
# Starts the shelf node on the Pi: vision and the guard, each started again within a second if it exits.
# Usage: HUB_URL=https://wheredidallmyinventorygo.wtf DEVICE_TOKEN=... ./run.sh
cd "$(dirname "$0")" || exit 1
: "${HUB_URL:?Set HUB_URL, for example https://wheredidallmyinventorygo.wtf}"
: "${DEVICE_TOKEN:?Set DEVICE_TOKEN}"
export HUB_URL DEVICE_TOKEN
export GUARD_DATA="${GUARD_DATA:-$PWD/data}"
mkdir -p "$GUARD_DATA"
# The workshop program with the reup hook built in. See README.md.
VISION="${VISION_CMD:-$HOME/QNX-AI-workshop/start.sh --ros-args -p camera_unit:=5}"
GUARD="python3 -m guard"
# On QNX the guard runs above vision (priority 20 against the usual 10), so a busy model never delays the ledger or the button.
if command -v on >/dev/null 2>&1; then GUARD="on -p 20 $GUARD"; fi
exec python3 supervisor.py --vision "$VISION" --guard "$GUARD" --data "$GUARD_DATA"
