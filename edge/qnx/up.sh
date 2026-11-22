#!/bin/sh
# Brings the Pi up from one command typed on the laptop: at the table the Pi has no keyboard.
# The clock, the QNX desktop (its lock and its sleep turned off), and the shelf node with the hand model's window
# full screen on the Pi's screen. Run it again any time: it starts only what is not running.
# From the station laptop use pi_up.ps1, which finds the laptop's address for CAMERA_URL and calls this.
# Usage: ssh reup-pi "HUB_URL=https://wheredidallmyinventorygo.wtf DEVICE_TOKEN=... CAMERA_URL=http://169.254.138.173:8089/stream/board.mjpg ~/reup-node/up.sh"
#   CAMERA_URL  the camera's pictures, served by the eye on the laptop. Not set: a camera on the Pi's own USB.
#   SITE_URL    also open this page full screen in the Pi's browser, and keep the hand window as an inset over it.
cd "$(dirname "$0")" || exit 1
: "${HUB_URL:?Set HUB_URL, for example https://wheredidallmyinventorygo.wtf}"
: "${DEVICE_TOKEN:?Set DEVICE_TOKEN}"
export HUB_URL DEVICE_TOKEN
SITE="${SITE_URL:-}"
DATA="${GUARD_DATA:-$PWD/data}"
mkdir -p "$DATA"
if [ -n "$CAMERA_URL" ]; then export REUP_CAMERA_URL="$CAMERA_URL"; fi
# With no page beside it the hand model's window is the whole screen. The screen is 1024 wide on the station's TV.
if [ -z "$SITE" ]; then export REUP_FULLSCREEN="${REUP_FULLSCREEN:-1}" REUP_WINDOW_WIDTH="${REUP_WINDOW_WIDTH:-1024}"; fi
running() { pidin ar 2>/dev/null | grep -v grep | grep -q "$1"; }

# The Pi has no clock battery. With the wrong date every https call fails.
if sudo ntpdate -bs pool.ntp.org 2>/dev/null; then echo "Clock set. $(date)"; else echo "Clock not set, no internet yet. $(date)"; fi

# A desktop that locks or sleeps after five quiet minutes shows a judge nothing. Both are turned off, once.
ini="$HOME/.config/weston.ini"
if [ -f "$ini" ] && ! grep -q "^idle-time=0" "$ini"; then
  [ -f "$ini.orig" ] || cp "$ini" "$ini.orig"
  python3 tv/desktop_ini.py "$ini" && echo "Desktop lock and sleep are off. They apply when the desktop next starts."
fi

if ! running "/usr/bin/weston"; then
  nohup bash /system/bin/startDesktop.sh > /dev/null 2>&1
  n=0
  while [ $n -lt 30 ] && ! ls "/var/run/user/$(id -u)"/wayland-* > /dev/null 2>&1; do sleep 1; n=$((n + 1)); done
  sleep 5
  echo "Started the desktop."
fi

# A node that runs on another camera address, or another layout, than the one asked for now is started again.
want="camera=$CAMERA_URL site=$SITE"
if running "supervisor.py" && [ "$(cat "$DATA/up.txt" 2>/dev/null)" != "$want" ]; then
  for pid in $(pidin ar 2>/dev/null | grep -v grep | grep -E "supervisor.py|python3 -m guard|handtrack_node" | awk '{ print $1 }'); do kill "$pid" 2>/dev/null; done
  sleep 2
  echo "Stopped the shelf node: its camera or its layout changed."
fi
if ! running "supervisor.py"; then
  echo "$want" > "$DATA/up.txt"
  nohup ./run.sh > "$HOME/reup-node.log" 2>&1 &
  echo "Started the shelf node. Setting up ROS 2 takes about 40 s. Log: ~/reup-node.log"
fi

# QNX shows one window at a time and switches with Alt and Tab. The desktop has to be the one in front.
desktop="$(pidin -F "%a %N" 2>/dev/null | awk '$2 == "weston" { print $1; exit }')"
shown() { sudo sh -c "cat /dev/screen/$desktop/win-*" 2>/dev/null | grep -a "status = " | grep -a -v -q "INVISIBLE"; }
n=0
while [ -n "$desktop" ] && ! shown && [ $n -lt 4 ]; do sudo python3 tv/keys.py alt+tab; sleep 1; n=$((n + 1)); done
if shown; then echo "The desktop is in front."; else echo "The desktop is not in front. Press Alt and Tab on the Pi, or run: sudo python3 tv/keys.py alt+tab"; fi

if [ -n "$SITE" ] && ! running "epiphany"; then
  . ./desk.sh
  nohup epiphany "$SITE" > /dev/null 2>&1 &
  # The page comes over the venue's network. F11 before the window is up would go to nothing.
  sleep 20
  sudo python3 tv/keys.py f11
  echo "Opened $SITE full screen. F11 again leaves full screen: sudo python3 tv/keys.py f11"
fi
if [ -z "$SITE" ] && running "epiphany"; then slay -f epiphany 2>/dev/null; echo "Closed the browser: the screen is the hand model's."; fi
