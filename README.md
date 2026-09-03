# vnc-mcp

An MCP server that lets an agent see and control a VNC desktop: screenshots in,
mouse and keyboard out.

It speaks the RFB protocol straight over TCP — no browser, no websockify, no
native modules — and runs the protocol-heavy parts of
[noVNC](https://github.com/novnc/noVNC) under Node: its byte buffer, every one of
its rectangle decoders (Tight, ZRLE, Hextile, RRE, Zlib, CopyRect, Raw), its DES
for password authentication, and its X11 keysym tables. Only the transport,
handshake and message loop are written here. `DECISIONS.md` explains how that
works and what was evaluated.

## Install

```sh
npm install
```

Node 22 or newer. Nothing is compiled and there is no build step.

## Configure

Add it to your MCP client. For Claude Code:

```sh
claude mcp add vnc -- node /path/to/vnc-mcp/src/index.js
```

Or as JSON, wherever your client keeps its server list:

```json
{
  "mcpServers": {
    "vnc": {
      "command": "node",
      "args": ["/path/to/vnc-mcp/src/index.js"],
      "env": {
        "VNC_HOST": "127.0.0.1",
        "VNC_PORT": "5900",
        "VNC_PASSWORD": ""
      }
    }
  }
}
```

The environment variables are defaults, all optional. With them set the agent
never has to name a host and never sees the password; without them it can point
`vnc_connect` wherever it likes. VNC display `:N` is TCP port `5900 + N`.

`VNC_QUALITY` (0–9) is a fourth, off by default: it lets the server use JPEG
inside Tight for photographic areas, a large bandwidth saving on a slow link at
the cost of lossless text. Unset means everything arrives pixel-exact.

## Tools

| Tool | What it does |
| --- | --- |
| `vnc_screenshot` | Capture the desktop, once it has stopped changing. PNG by default, `format: "jpeg"` for heavy screens; shrunk to 1280px wide unless `maxWidth` says otherwise (0 = full size). |
| `vnc_click` | Click at a point. `button` is left/middle/right, `clicks: 2` double-clicks. |
| `vnc_move` | Move the pointer without clicking, for hover states. |
| `vnc_drag` | Press at one point, move, release at another. |
| `vnc_scroll` | Wheel up/down/left/right, `amount` clicks. |
| `vnc_type` | Type a string. Newlines become Return. |
| `vnc_key` | One key or shortcut: `"ctrl+c"`, `"alt+F4"`, `"Return"`, `"Escape"`, `"Up"`. |
| `vnc_connect` | Point at a different desktop. Rarely needed — the first tool call connects on its own. |
| `vnc_disconnect` | Close the connection. |
| `vnc_status` | Connection state, desktop size and name, pointer position, last clipboard text, and which encodings the server has been sending. |

Coordinates are always pixels in the desktop's own full-size space. A scaled
screenshot says so in its accompanying text and gives the factor to multiply by.

After any input, the server waits briefly (`settleMs`, default 250 ms) for the
desktop to repaint. `vnc_screenshot` then waits for the screen to be still for
`quietMs` (default 100 ms, up to `maxWaitMs`, default 0.5 s) before capturing,
so it does not catch a window half-drawn; if the screen never settles it
captures anyway and says so.

Key names are X11 keysym names, with the obvious short aliases accepted:
`enter`, `esc`, `del`, `backspace`, `pgup`, `pgdn`, `space`, `up`/`down`/
`left`/`right`. Modifiers are `ctrl`, `alt`, `shift`, and `super` (also spelled
`meta`, `win`, `cmd`).

## What it supports

- RFB protocol versions 3.3, 3.7 and 3.8
- Security: `None` and `VNC Authentication` (password)
- Encodings: Tight (including JPEG when `VNC_QUALITY` is set), ZRLE, Hextile,
  RRE, Zlib, CopyRect, Raw; DesktopSize, LastRect and DesktopName
  pseudo-encodings

Not supported: the encrypted transports and vendor authentication schemes
(VeNCrypt/TLS, RealVNC RA2, Apple ARD). **Traffic is unencrypted**, and VNC
passwords are capped at 8 characters by the protocol itself — this is meant for a
VNC server on localhost or a container network, not across the internet.

## Test

```sh
npm test            # both suites
npm run test:unit   # Framebuffer edge cases; no container needed
npm run test:e2e    # the real thing, against a container
```

The unit tests cover the one piece of pixel code this repository owns, the
framebuffer: overlapping copies, clipping, JPEG decoding into place.

The end-to-end test builds a small container running Xvfb + x11vnc + xterm,
connects to it, and checks the results against the X server itself — the
pointer position comes back from `xdotool`, and typed text comes back from a
file the terminal wrote. Each encoding is then forced in turn and its output
compared pixel for pixel with Raw; a window of random noise on the desktop is
what makes the lossy JPEG path fire, and scrolling the terminal is what makes
the server send CopyRect. It needs `docker` (or set `DOCKER_CLI=podman`); the
image is built for you. The same suites run in GitHub Actions on every push and
pull request.

## Trying it by hand

```sh
docker build -t vnc-mcp-test test/
docker run --rm -p 5900:5900 vnc-mcp-test
```

Then point the server at `127.0.0.1:5900` and ask the agent to take a
screenshot. Set `-e VNC_PASSWORD=hunter2` on the `docker run` to exercise the
authentication path.
