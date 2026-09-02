# vnc-mcp

An MCP server that lets an agent see and control a VNC desktop: screenshots in,
mouse and keyboard out.

It speaks the RFB protocol straight over TCP — no browser, no websockify, no
native modules — and borrows [noVNC](https://github.com/novnc/noVNC) for the two
pieces that are pure logic: the DES implementation that VNC password
authentication needs, and the X11 keysym tables that input injection needs.
`DECISIONS.md` explains why it is built this way.

## Install

```sh
npm install
```

Node 20 or newer. Nothing is compiled and there is no build step.

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

The three environment variables are defaults, all optional. With them set the
agent never has to name a host and never sees the password; without them it can
point `vnc_connect` wherever it likes. VNC display `:N` is TCP port `5900 + N`.

## Tools

| Tool | What it does |
| --- | --- |
| `vnc_screenshot` | Capture the desktop as a PNG. `scale` (0.05–1) and `maxWidth` trade detail for size. |
| `vnc_click` | Click at a point. `button` is left/middle/right, `clicks: 2` double-clicks. |
| `vnc_move` | Move the pointer without clicking, for hover states. |
| `vnc_drag` | Press at one point, move, release at another. |
| `vnc_scroll` | Wheel up/down/left/right, `amount` clicks. |
| `vnc_type` | Type a string. Newlines become Return. |
| `vnc_key` | One key or shortcut: `"ctrl+c"`, `"alt+F4"`, `"Return"`, `"Escape"`, `"Up"`. |
| `vnc_connect` | Point at a different desktop. Rarely needed — the first tool call connects on its own. |
| `vnc_disconnect` | Close the connection. |
| `vnc_status` | Connection state, desktop size and name, pointer position. |

Coordinates are always pixels in the desktop's own full-size space. A scaled
screenshot says so in its accompanying text and gives the factor to multiply by.

After any input, the server waits briefly (`settleMs`, default 250 ms) for the
desktop to repaint, so the next screenshot is not a stale one.

Key names are X11 keysym names, with the obvious short aliases accepted:
`enter`, `esc`, `del`, `backspace`, `pgup`, `pgdn`, `space`, `up`/`down`/
`left`/`right`. Modifiers are `ctrl`, `alt`, `shift`, and `super` (also spelled
`meta`, `win`, `cmd`).

## What it supports

- RFB protocol versions 3.3, 3.7 and 3.8
- Security: `None` and `VNC Authentication` (password)
- Encodings: `Raw`, `CopyRect`, and the `DesktopSize` pseudo-encoding

Not supported: Tight, ZRLE and Hextile (compression, not capability), and the
encrypted transports (VeNCrypt, TLS, RA2). **Traffic is unencrypted**, and VNC
passwords are capped at 8 characters by the protocol itself — this is meant for a
VNC server on localhost or a container network, not across the internet.

## Test

The test builds a small container running Xvfb + x11vnc + xterm, connects to it,
and checks the results against the X server itself — the pointer position comes
back from `xdotool`, and typed text comes back from a file the terminal wrote.

```sh
npm test
```

Needs `docker` (or set `DOCKER_CLI=podman`). The image is built for you.

## Trying it by hand

```sh
docker build -t vnc-mcp-test test/
docker run --rm -p 5900:5900 vnc-mcp-test
```

Then point the server at `127.0.0.1:5900` and ask the agent to take a
screenshot. Set `-e VNC_PASSWORD=hunter2` on the `docker run` to exercise the
authentication path.
