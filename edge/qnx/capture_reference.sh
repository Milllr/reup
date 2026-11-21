#!/bin/sh
# Saves the empty board on the Pi. Take every part off the board first, and keep hands out of the picture.
cd "$(dirname "$0")" || exit 1
DATA="${GUARD_DATA:-$PWD/data}"
mkdir -p "$DATA" && touch "$DATA/capture.flag"
echo "Asked vision to save the empty board. It answers within a second: look for the reference line in the run.sh window."
