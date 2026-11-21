#!/bin/sh
# Writes the Pi camera's picture to data/snapshot.ppm, for finding the corners of each zone in that camera's view.
cd "$(dirname "$0")" || exit 1
DATA="${GUARD_DATA:-$PWD/data}"
mkdir -p "$DATA" && touch "$DATA/snapshot.flag"
echo "Asked vision for a picture. It is at $DATA/snapshot.ppm within a second. Copy it to a laptop and open it in any image viewer."
