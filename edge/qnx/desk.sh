# Where the QNX desktop is, for a program started over SSH. Sourced by run.sh and up.sh, never run by itself.
# A program started from the desktop has all of this already. One started from a shell on the laptop has none of it,
# and opens no window.
if [ -z "$WAYLAND_DISPLAY" ]; then
  desk="/var/run/user/$(id -u)"
  for sock in "$desk"/wayland-*; do
    case "$sock" in *.lock) continue ;; esac
    if [ -S "$sock" ]; then
      export XDG_RUNTIME_DIR="$desk" WAYLAND_DISPLAY="$(basename "$sock")" GDK_BACKEND=wayland GSK_RENDERER="${GSK_RENDERER:-cairo}" GDK_GL="${GDK_GL:-gles}" XDG_SESSION_TYPE=wayland XDG_DATA_DIRS="${XDG_DATA_DIRS:-/usr/share}" XDG_CONFIG_DIRS="${XDG_CONFIG_DIRS:-/etc/xdg}"
      break
    fi
  done
fi
# The desktop's message bus: the newest one, an older desktop leaves its socket behind.
if [ -z "$DBUS_SESSION_BUS_ADDRESS" ]; then
  bus="$(ls -t /tmp/dbus-* 2>/dev/null | head -1)"
  if [ -n "$bus" ] && [ -S "$bus" ]; then export DBUS_SESSION_BUS_ADDRESS="unix:path=$bus"; fi
fi
