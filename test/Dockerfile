# A throwaway VNC desktop to test against: Xvfb for the display, x11vnc to
# serve it, and an xterm to aim input at.
#
# xdotool is in here so the test can ask the X server itself where the pointer
# ended up, rather than inferring it from pixels.
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb \
        x11vnc \
        xterm \
        xdotool \
        x11-utils \
    && rm -rf /var/lib/apt/lists/*

ENV DISPLAY=:0
ENV SCREEN_SIZE=1024x768x24
# Leave empty for a server that needs no authentication.
ENV VNC_PASSWORD=

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 5900
CMD ["/entrypoint.sh"]
