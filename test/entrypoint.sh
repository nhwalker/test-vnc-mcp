#!/bin/sh
# Bring up a virtual display, put something on it, and serve it over VNC.
set -eu

Xvfb "$DISPLAY" -screen 0 "$SCREEN_SIZE" -nolisten tcp &

# Wait for the display to accept connections before anything tries to use it.
for _ in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.2
done

# A terminal that captures one line of typed text into a file, so the test can
# assert on exactly what the X server received rather than on pixels.
xterm -geometry 100x35+0+0 -fa Monospace -fs 14 -bg black -fg green \
    -e sh -c 'printf "type here: "; read -r line; printf "%s" "$line" > /tmp/typed.txt; sleep 86400' &

if [ -n "${VNC_PASSWORD:-}" ]; then
    printf '%s\n' "$VNC_PASSWORD" > /tmp/vncpasswd.txt
    set -- -passwdfile /tmp/vncpasswd.txt
else
    set -- -nopw
fi

exec x11vnc -display "$DISPLAY" -rfbport 5900 -listen 0.0.0.0 -forever -shared -noxdamage -quiet "$@"
