# vnc-mcp

An MCP server that lets an agent see and control a VNC desktop: screenshots in,
mouse and keyboard out — plus a description of the screen as data (regions,
text with positions, what changed) for when a picture is the expensive way to
find a button.

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

`VNC_OCR_LANGS` and `VNC_OCR_LANG_PATH` configure text recognition for
`vnc_describe`; see [Describing the screen](#describing-the-screen). The
defaults read English and need no network.

## Tools

| Tool | What it does |
| --- | --- |
| `vnc_screenshot` | Capture the desktop, once it has stopped changing. PNG by default, `format: "jpeg"` for heavy screens; shrunk to 1280px wide unless `maxWidth` says otherwise (0 = full size). |
| `vnc_describe` | Describe the desktop as JSON: its flat-coloured regions (windows, bars, buttons) nested by containment, every line of text with its bounding box, and which rectangles changed since the last look. Coordinates are full-size desktop pixels. |
| `vnc_describe_image` | The same analysis over a PNG or JPEG the client supplies — a screenshot taken earlier — with an optional `bbox` to analyse one part and a `scale` to map a shrunk screenshot's coordinates back to desktop pixels. Needs no connection. |
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

## Describing the screen

A screenshot is the right thing for a model that can see. `vnc_describe` is for
the cases where it is not: a smaller model that cannot, a big one that wants
exact coordinates rather than estimates off a scaled image, or an agent that
just needs to know whether anything changed. It returns JSON:

```json
{
  "desktop": { "width": 1024, "height": 768, "update": 41 },
  "changedSince": { "update": 37, "complete": true, "rects": [{ "x": 680, "y": 120, "width": 302, "height": 222 }] },
  "regions": [
    { "id": 1, "bbox": [0, 0, 1024, 28], "color": "#3b4252", "parent": null, "depth": 0, "hint": "bar", "textLines": 1, "text": "Applications Places System Wed 14:32" },
    { "id": 5, "bbox": [681, 149, 300, 192], "color": "#eceff4", "parent": 2, "depth": 1, "textLines": 2, "text": "The document has unsaved changes.\nSave before closing?" },
    { "id": 6, "bbox": [714, 298, 74, 30], "color": "#efefef", "parent": 5, "depth": 2, "hint": "button-like", "textLines": 1, "text": "Cancel" }
  ],
  "text": [
    { "text": "Cancel", "confidence": 94, "bbox": { "x": 730, "y": 307, "width": 43, "height": 11 }, "region": 6 }
  ],
  "elapsedMs": 1180, "quiet": true, "cached": false
}
```

Three things go into it, in increasing order of cost:

- **`changedSince`** comes straight from the protocol. Every framebuffer update
  the server sends lists the rectangles it redrew, so "what moved since you
  last looked" costs nothing and involves no pixel comparison. The baseline is
  the previous screenshot or description, or the `since` argument (an
  `update` number from an earlier reply). `complete: false` means the baseline
  is older than the history kept (64 updates) and the whole screen should be
  assumed changed.
- **`regions`** are found from the pixels alone: connected areas of one flat
  colour, big and solid enough to be a window body, a bar, a panel or a button
  rather than a stroke of text, nested by containment. No models. Anything
  without a flat background — a photo, a gradient, wallpaper — yields no region,
  which is the honest answer. Two hints are offered when geometry makes them
  safe: `bar` for a strip across the whole screen, `button-like` for a small
  nested region with one centred line of text. Nothing else is guessed.
- **`text`** is Tesseract, run per region rather than per screen — two windows
  side by side share rows of pixels and Tesseract will otherwise read straight
  across the gap — with small regions doubled first, since desktop text is far
  smaller than the print Tesseract expects. Each line has its box in desktop
  pixels, its confidence, and the region it was read from (`null` for text on
  no region). `words: true` adds a box per word.

The first description of a screen takes about a second on a laptop, mostly
OCR; the result is cached until the screen changes. `text: false` gives the
regions alone in about 150 ms. Set `quietMs` and `maxWaitMs` as for a
screenshot.

**Images the client already has.** `vnc_describe_image` runs the same
regions-and-text analysis over a base64 PNG or JPEG passed in the call (a
`data:` URL is fine), and needs no VNC connection at all. Two extra arguments
make it fit the screenshots this server hands out: `bbox` analyses only that
rectangle of the image, with results still in whole-image coordinates, so a
client can zoom in on one dialog without re-sending or re-reading the rest; and
`scale` multiplies every returned coordinate, so passing the factor a shrunk
`vnc_screenshot` reported gives boxes in desktop pixels that `vnc_click` can
use directly. The reply is the same shape as `vnc_describe` minus the parts
that only make sense for a live desktop (`changedSince`, `quiet`, `cached`),
with an `image` object in place of `desktop` recording the size, type, and any
`bbox` and `scale` applied. A JPEG screenshot works, with one caveat seen in
testing: the regions came back identical to the PNG's, and dark text on light
backgrounds read as well, but the terminal's thin green-on-black text was not
read at all from the JPEG. When text matters, analyse PNG.

Text recognition runs as WebAssembly in a worker thread — nothing native, no
toolchain — and reads English by default from language data installed with the
package, so it works offline and writes nothing to disk. For other languages
set `VNC_OCR_LANGS` (e.g. `eng+deu`) and point `VNC_OCR_LANG_PATH` at a
directory containing a `<lang>.traineddata.gz` for each; the npm packages
`@tesseract.js-data/<lang>` provide them. The mouse pointer is part of the
picture and is too small to be a region, but a stray letter of it can appear
in `text` at low confidence.

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

The unit tests cover the pixel code this repository owns. The framebuffer:
overlapping copies, clipping, JPEG decoding into place. The damage log: how
redrawn rectangles merge and how far back the history reaches. Region
detection, text recognition and the assembled description all run over
`test/fixtures/desktop.png`, a rendered 1024×768 desktop with a terminal, a
dialog and three buttons (its source is `desktop.html` beside it), expecting
exactly the regions a person would name and the text on each of them. One test
starts the real server over stdio and calls `vnc_describe_image` on that
fixture through MCP, then checks that closing the pipe ends the process.

The end-to-end test builds a small container running Xvfb + x11vnc + xterm,
connects to it, and checks the results against the X server itself — the
pointer position comes back from `xdotool`, and typed text comes back from a
file the terminal wrote. The description must find the terminal as a region
and read its prompt from it, find nothing in the window of random noise, and
after typing report the terminal as changed and the typed text as readable. Each encoding is then forced in turn and its output
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
