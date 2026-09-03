# Decisions

A running record of the calls I made while building this that I would otherwise
have stopped and asked about. Each entry says what I chose, why, and what the
alternative was, so any of them can be reversed cheaply.

---

## 1. Language / runtime: Node.js (ESM), no build step

**Chosen:** plain JavaScript ESM on Node 22+, run directly (`node src/index.js`).
(Originally 20+; section 11 explains the bump.)

**Why:** the request was "keep it as simple as possible". noVNC — named in the
request — is a JavaScript package, so Node keeps everything in one language with
no FFI. Skipping TypeScript means there is no compile step between editing and
running, and no `dist/` to keep in sync.

**Alternative considered:** Python + `vncdotool`. It is a mature VNC automation
library and would have been less code, but it would have made the noVNC
dependency impossible.

---

## 2. How noVNC is used: its protocol internals, not its browser client

This is the most important decision in the project. It was revised once; both
versions are here because the reasoning in the first still holds.

**The constraint:** noVNC's `RFB` class is a *browser* VNC client. It cannot run
under Node. Verified directly:

```
$ node -e "import('@novnc/novnc')"
ReferenceError: window is not defined
```

It needs `window`, `document`, a `<canvas>` for its framebuffer, and a
`WebSocket` (so also a websockify TCP↔WebSocket bridge in front of any real VNC
server). Making that work under Node means `jsdom` + the native `canvas` package
+ a WebSocket shim + websockify — four moving parts, a native build, and a
framebuffer that lives in a fake DOM. That is the opposite of simple.

**First version (superseded):** speak RFB ourselves with only the `Raw` and
`CopyRect` encodings, and import just two DOM-free pieces from noVNC:
`crypto/des.js` (VNC password auth — Node's OpenSSL 3 build cannot do single
DES; `createCipheriv('des-ecb', …)` throws `error:0308010C … unsupported`) and
the `input/keysym*.js` tables (~1300 lines of X11 keysyms).

**Current version:** the transport, handshake and message loop are still ours
(`src/rfb.js`), but the byte buffering is noVNC's `Websock` and **every
rectangle encoding is decoded by noVNC's own decoders**, drawing into a small
`Framebuffer` class (`src/framebuffer.js`) that offers the five methods they
call on noVNC's `Display`. Section 11 has the full evaluation of what could be
reused, what was, and what was rejected.

**One wrinkle worth knowing:** `@novnc/novnc`'s `package.json` declares
`"exports": "./core/rfb.js"` (a bare string), so subpath imports like
`@novnc/novnc/core/websock.js` fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
`src/novnc.js` resolves the package's single public export with
`import.meta.resolve()` and walks to its sibling files. That survives pnpm and
other non-flat layouts, but it is still reaching past a package boundary, and a
future noVNC release could move those files. `src/novnc.js` fails loudly with an
explanatory message if that happens, and it is the single place to fix.

**Alternatives considered and rejected:** driving noVNC for real inside a
browser — headless Chromium via Playwright, or Electron (which would also give a
supervised window). Both genuinely use noVNC as intended, but both need a
browser process per session, a display server on Linux (Electron's docs still
require `$DISPLAY`; they recommend Xvfb), a two-process IPC topology, and
screenshots taken from a browser's rendering rather than the desktop's own
pixels. noVNC also has no public pointer-injection API, so input would either
reach into `rfb._sock` or go through its DOM gesture heuristics. Section 11
shows the Node route gets the decoders — the actual prize — for a fraction of
that.

---

## 3. RFB feature scope: only what an agent actually needs

**Encodings offered, in preference order:** CopyRect, Tight, ZRLE, Hextile, RRE,
Zlib, Raw — all decoded by noVNC (section 11). TightPNG and JPEG decoders are
loaded too, so those rectangles decode if a server ever sends them, but they are
not advertised.

**Pseudo-encodings handled:** DesktopSize (follow a resolution change),
LastRect, DesktopName, a compression-level hint (2, like noVNC), and a JPEG
quality level only when `VNC_QUALITY` is set — unset means lossless, because
screenshots are mostly read for their text.

**Deliberately not requested:**

- *Cursor / VMware cursor.* With these the server stops drawing the pointer into
  the framebuffer and sends its shape separately for the client to composite. We
  want the pointer *in* the screenshot, so not asking keeps that the server's
  job.
- *ExtendedDesktopSize, ContinuousUpdates, Fence, ExtendedClipboard, QEMU
  extended key and LED events, H.264.* Each is more protocol for a capability an
  agent driving a desktop does not need yet. QEMU extended keys (scancodes) are
  the most likely to be wanted, for VM consoles with non-US layouts; section 11
  notes what it would take.

**Protocol versions:** RFB 3.3, 3.7 and 3.8. **Security types:** `None` (1) and
`VNC Authentication` (2). Not implemented: VeNCrypt, TLS, RA2, Tight auth, ARD.
Encrypted VNC transports are a real gap, but the target is a VNC server on
localhost or a container network. Section 11 records which of these noVNC could
supply and why they are not wired in.

---

## 4. Pixel format: force 32-bit true colour, red in the low byte

**Chosen:** the client sends `SetPixelFormat` to pin 32 bpp / depth 24 /
little-endian / RGB max 255 with shifts R=0 G=8 B=16.

**Why:** it means exactly one decoding path. Without it we would have to handle
whatever the server offers — 8-bit palettes, 16-bit 565, big-endian — and each is
a separate unpacking routine. Every server that matters honours `SetPixelFormat`.

**Why this byte order:** it is the one noVNC negotiates, so its decoders emit
R, G, B, pad — which is also how `Framebuffer` stores pixels. Decoded rectangles
are copied into place without a second conversion. (The first version used
B, G, R, pad and swapped bytes in the Raw decoder; that went away with the
hand-written decoder.)

---

## 5. Screenshots: PNG by default, JPEG on request, capped at 1280px wide

**Chosen:** `pngjs` and `jpeg-js` (both pure JavaScript) encode the framebuffer;
`format` picks between them, PNG being the default. Images are box-filtered down
so they are at most `maxWidth` wide, **1280 by default** (`0` disables the cap),
with `scale` as a further factor.

**Why PNG by default:** it is lossless, so text on the desktop stays readable,
which is what a model looking at a screenshot mostly needs. On a typical desktop
(flat colours, text) PNG is also small — the test desktop's terminal encodes to
under 10 KB.

**Why JPEG exists:** photo- or video-heavy screens make PNG balloon. On the test
desktop with its 256×256 noise window, the JPEG is a fraction of the PNG. The
tool description tells the agent when to reach for it.

**Why the default cap:** screenshots go to the model as base64, so their byte
size is the dominant cost of using this server at all, and a full 1920×1080
capture is easily a megabyte or more. 1280 keeps normal desktop text legible
while roughly halving that; the reply always states the factor to multiply
coordinates by, and the agent can ask for full size. Screenshots are always
encoded from the *full* framebuffer, so scaling never loses server-side state.

**Why not `sharp`:** it would give smaller JPEGs and faster resizing, but it is a
native module. Pure JS keeps `npm install` from needing a toolchain.

**The last encode is cached.** Encoding is the slow part (pure-JS PNG at full
size is on the order of 100 ms), and an agent often looks twice at a screen that
has not changed. The framebuffer's update counter says exactly when the pixels
last moved, so a second screenshot with the same options on the same update
returns the previous bytes. The reply carries a `cached` flag so this is
visible rather than magic.

---

## 6. One connection per server process

**Chosen:** the server holds at most one VNC session. `vnc_connect` replaces any
existing one; every other tool operates on it implicitly.

**Why:** it keeps every tool signature down to the arguments that matter
(`x`, `y`, `text`) instead of threading a session id through all of them, and an
agent driving one desktop is the overwhelmingly common case. Two desktops means
two server entries in the MCP client config, which is a configuration problem
rather than a code problem.

---

## 7. Connection details come from tool arguments, with env defaults

**Chosen:** `vnc_connect` takes `host`/`port`/`password`, each defaulting to
`VNC_HOST` / `VNC_PORT` / `VNC_PASSWORD` from the environment. Tools other than
`vnc_connect` auto-connect using those defaults if nothing is connected yet.

**Why:** the env vars let an operator pin the server to one desktop and hand the
agent a password it never sees; the arguments let an agent point at a container
it just started. Auto-connect means the common case is one tool call, not two.

**Security note:** a password passed as a tool argument is visible in the model's
context. `VNC_PASSWORD` is the right way to supply a real one.

---

## 8. Input model: coordinates and key names, not raw protocol events

**Chosen:** the tools are `vnc_move`, `vnc_click`, `vnc_drag`, `vnc_scroll`,
`vnc_type`, and `vnc_key`. `vnc_key` accepts human key names with modifiers
(`"ctrl+c"`, `"alt+F4"`, `"Return"`), resolved through noVNC's keysym tables.

**Why:** RFB's actual wire events are `PointerEvent` (a button *bitmask* plus a
position) and `KeyEvent` (a keysym plus down/up). Exposing those directly would
make the model track button state and press/release pairs across calls, which is
a reliable source of stuck modifiers and dragged windows. The tools here are
complete gestures that always leave the input state clean.

**`vnc_type` sends one keysym per character** and does *not* synthesise shift for
capitals or symbols. RFB carries keysyms, not scancodes, so `XK_A` already means
"A"; the server picks whatever key produces that character. This is what noVNC
does for pasted text, and it is layout-independent at both ends. Verified against
x11vnc: typing `The quick brown fox 0123456789` arrives with its capital T
intact.

---

## 9. Every input tool waits briefly, then reports the resulting screen state

**Chosen:** after input, the server requests a framebuffer update and waits a
short, bounded time (default ~250 ms, `settleMs` on each tool) for the desktop to
repaint before returning. It returns text, not an image — the agent calls
`vnc_screenshot` when it wants to look.

**Why:** the round trip of "click, then screenshot, and hope the UI had
repainted" is the main source of flaky GUI automation. Returning an image from
every input tool would be the other extreme: correct, but it would flood the
context with near-identical screenshots.

**And `vnc_screenshot` waits for the screen to go quiet.** Waiting for *one*
update after a click is not enough: a real UI repaints in bursts, and a capture
between two of them shows a half-drawn dialog. So the screenshot tool captures
only once no update has arrived for `quietMs` (default 100 ms), giving up after
`maxWaitMs` (default 0.5 s) and saying so in its reply. A screen that never
stops changing — video, a clock — costs the full wait, which is bounded, rather
than an error. `quietMs: 0` captures immediately.

---

## 10. Testing: a container built here, driven end-to-end

**Chosen:** `test/Dockerfile` builds a small Debian image running Xvfb + x11vnc +
a couple of X clients; `test/smoke.mjs` starts it, connects, screenshots, injects
input, and asserts the pixels actually changed.

**Why:** screenshots and input injection are exactly the kind of thing that unit
tests with a mocked socket will happily pass while the real thing is broken. The
test covers both the no-password and password-protected paths, since VNC auth
(the DES code above) is otherwise never exercised.

**Since the decoders became noVNC's,** the only pixel code we own is
`Framebuffer`, and it has unit tests (`test/framebuffer.test.mjs`, Node's
built-in runner, no dependencies): overlapping copies in all four directions,
rectangles hanging off every edge, the byte-offset contract of `blitImage`,
JPEG decoding into place. Those are the cases a well-behaved server rarely
produces, so waiting for the end-to-end test to catch them meant waiting for a
hostile server.

**CopyRect is exercised end to end** by scrolling the terminal: the test
container's xterm echoes what is typed, forty-five lines scroll it, and x11vnc
expresses a scroll as CopyRect (several hundred of them per run).
The scrolled framebuffer is then compared with a fresh connection's view of the
same screen, which is the server's own idea of the truth.

**CI** runs both suites on every push and pull request (`.github/workflows/
test.yml`). GitHub's Ubuntu runners ship Docker, so the end-to-end test runs
there unchanged.

---

## 11. Which parts of noVNC run under Node — the evaluation

The question: how much of noVNC can we use directly, so that protocol code is
maintained upstream rather than here? Answered by experiment, not by reading.

### Method

A script imported every file under noVNC's `core/` in Node and recorded what
broke. First pass, no shims: 22 of 41 modules failed, all with
`window is not defined`. Reading the failures, one module explained nearly all
of them: `util/logging.js` binds `window.console` at import time, and almost
everything imports the logger.

Second pass, with `globalThis.window = { console, Error, crypto }` defined
first — those three being the *only* things noVNC reads from `window` outside
its DOM-bound modules (`util/logging.js` wants `console` and `Error`;
`crypto/rsa.js` and `ra2.js` want `crypto.subtle` and `getRandomValues`, which
Node's built-in WebCrypto provides). Result: **35 of 41 import cleanly**. The
six that do not all need `document`: `rfb.js`, `display.js`,
`input/keyboard.js`, `input/util.js`, `util/browser.js`, `util/cursor.js`,
`util/events.js`.

The shim is deliberately a three-property object, not an alias of `globalThis`,
so nothing else in the process starts believing it is in a browser. Checked:
none of our other dependencies branch on `typeof window` (only pngjs's unused
browser entry point does).

### Could `rfb.js` itself run, with a fake `document`?

Tested with a logging Proxy standing in for `window`, `document` and
`navigator`. Import fails on `MutationObserver` — but before getting there it
had already read `document.body`, `document.documentElement`,
`window.devicePixelRatio`, created an element to probe `style.cursor` support,
and measured `offsetWidth`. That is layout and rendering behaviour, and the
constructor would go on to need a working 2D canvas context, keyboard and
cursor DOM handling, and gesture recognition. This is the jsdom-plus-canvas
route by another name. **Rejected.** The handshake, security negotiation and
message dispatch inside `rfb.js` therefore stay hand-written here (~300 lines
of `src/rfb.js`, written from the RFB specification rather than copied).

### What is used

| noVNC module | Role here |
| --- | --- |
| `websock.js` | The receive/send queue. `attach()` accepts any object with a WebSocket-shaped surface, so a 30-line wrapper around a `net.Socket` replaces websockify. Every decoder is written against this buffer's `rQ*` methods. |
| `decoders/raw, copyrect, rre, hextile, zlib, tight, tightpng, zrle, jpeg` | All rectangle decoding. Each imports only the logger and the inflator, and paints through five `Display` methods: `blitImage`, `fillRect`, `copyImage`, `imageRect`, `videoFrame`. `src/framebuffer.js` implements those over a plain RGBA buffer. |
| `inflator.js` (+ vendored pako) | zlib streams, pulled in by the decoders. |
| `encodings.js` | Encoding numbers and names. |
| `crypto/des.js` | VNC password authentication. |
| `input/keysym.js`, `input/keysymdef.js` | Key names and Unicode → keysym. |
| `util/strings.js` | UTF-8 decoding of the desktop name. |

`imageRect` is the one Display method whose browser implementation is not
reproducible with a buffer — it hands JPEG/PNG bytes to `new Image()`. Here it
decodes with `jpeg-js` (pure JavaScript, no dependencies, ~40 KB) and `pngjs`
(already present). It is only exercised when a quality level is advertised;
verified against real JPEG rectangles from x11vnc.

### Importable but not wired in, and why

| Module | What it offers | Why not (yet) |
| --- | --- | --- |
| `ra2.js` + `crypto/rsa.js`, `aes.js` | RealVNC's RA2/RA2ne authentication, as a self-contained `RSAAESAuthenticationState(sock, getCredentials)` that awaits socket data through `checkInternalEvents()`. Would slot into our handshake. | Needs a RealVNC server to test against, which is proprietary and cannot run in the test container. Also needs a policy for approving the server's public key (noVNC asks the user). Shipping untested auth would be worse than not shipping it. |
| `crypto/dh.js`, `md5.js` | Building blocks for Apple Screen Sharing (ARD) and MSLogonII auth. | The negotiation sequences live in `rfb.js`, so they would be rewritten, not reused; and neither server is testable here. |
| `input/xtscancodes.js`, `input/domkeytable.js` | The tables for QEMU Extended Key Events (scancodes), which fix non-US layouts on VM consoles. | We hold keysyms, and the tables are keyed by DOM `code`; getting keysym → code → scancode means inverting `domkeytable`. Modest, but no VM console to test with yet. |
| `deflator.js`, `base64.js`, `util/int.js`, `util/eventtarget.js`, `input/gesturehandler.js`, `vkeys.js`, `fixedkeys.js` | — | No use in a non-browser client. |

**A place Node beats the browser:** VeNCrypt's TLS subtypes (TLSVnc, X509Vnc,
…) are impossible for noVNC — a browser cannot start TLS inside a WebSocket —
but here they are `tls.connect()` over the existing socket followed by the
normal inner auth, perhaps 40 lines, and testable with TigerVNC's `Xvnc` from
Debian. Not done; it is the obvious next step if encrypted transport matters.

### Other consequences

- **Node ≥ 22.** `websock.js` reads `WebSocket.OPEN` and friends at import.
  Node 22 ships the `WebSocket` global by default; Node 20 has it only behind a
  flag.
- **Licensing.** noVNC is MPL-2.0, whose copyleft is per-file. Importing its
  modules as a dependency leaves this repository's Unlicense alone, as I
  understand it; nothing was copied out of noVNC's files. Worth a glance from
  whoever cares about licensing, since I am not the right authority.
- **One more `window` reader could appear** in a future noVNC release. The
  loader in `src/novnc.js` would fail at import with a clear message, and the
  fix is a property on the shim.
- **noVNC is pinned to exactly `1.7.0`,** not `^1.7.0`. We import its internal
  files by path, so a minor release that moves one would break a fresh install.
  Upgrading is a deliberate step: bump the pin, run `npm test`.

### Measured

Full-screen first update of the 1024×768 test desktop (black terminal with a
line of text, plus a 256×256 window of random noise), bytes on the wire:

| Encoding | Bytes |
| --- | ---: |
| Raw | 3,145,800 |
| RRE | 791,696 |
| Hextile | 277,415 |
| Zlib | 245,424 |
| ZRLE | 203,186 |
| Tight | 198,007 |

The noise window alone is 196,608 bytes of incompressible data, so Tight and
ZRLE are spending almost nothing on the rest of the screen. Every lossless
encoding produced pixels identical to Raw; the test insists on it.

---

## 12. Describing the screen as data: regions from pixels, text from Tesseract, changes from the protocol

**Chosen:** a `vnc_describe` tool, separate from `vnc_screenshot`, returning
JSON in full-size desktop coordinates: flat-colour regions nested by
containment, every line of text with its box and confidence and the region it
was read from, and the rectangles redrawn since the agent last looked. Three
sources, assembled in `session.js` and cached per framebuffer update.

**Why a separate tool:** a description costs about a second (OCR) and several
kilobytes of JSON, and a capable vision model looking at a screenshot needs
neither. Attaching it to every screenshot would tax the common case for the
benefit of the rare one. Made separate, the two compose: a screenshot to
understand the screen, a description to get exact coordinates off it, or a
description alone for a model that cannot see.

### Changes: from the protocol, not from pixels

Every FramebufferUpdate names the rectangles it carries. `RfbClient` was already
decoding them; it now also files their geometry (`src/damage.js`) under the
update number, keeps the last 64 updates, and answers "what changed since
update N" by merging. Touching rectangles merge — a scroll arrives as hundreds
of one-line CopyRects and the agent wants "the terminal scrolled", not each
line — and more than 32 collapse to their bounding box. A `pixelmatch`-style
comparison of two screenshots was the obvious alternative and is strictly
worse: it rediscovers, slowly and approximately, what the server already said.

### Regions: connected components of flat colour

A desktop is mostly flat colour — window bodies, title bars, panels, buttons —
and each is a connected run of near-identical pixels whose bounding box is the
region a person would point at. `src/regions.js` flood-fills the framebuffer
into such components and keeps those at least 24×12 that cover at least half
their bounding box; strokes of text, borders and the pointer fail one test or
the other. Pixels are compared with the component's *seed* colour, not their
neighbour's, so a gradient cannot be walked across one step at a time. Nesting
is by containment, ids are in reading order. About 150 ms for 1024×768.

**Alternative considered: recursive XY-cut** (the document-layout algorithm;
`@makibm/layt` on npm does it). Prototyped: it found the big blocks but not
buttons, and its per-region "dominant colour equals background" heuristic
broke as soon as a child window's colour dominated its parent's band. The
component approach found every window, bar and button on the test desktop with
pixel-exact boxes in one pass. `layt` also depends on `sharp`, which #5 rules
out.

**Alternative considered: a model.** Microsoft's OmniParser — a YOLOv8 icon
detector plus a Florence-2 captioner — is the state of the art here and there
are community ONNX conversions runnable with `onnxruntime-node`. Rejected for
now on three grounds: the detector is YOLOv8-derived and therefore AGPL-3.0,
which this Unlicense repository should not absorb by accident; the ONNX
conversion is unvetted (a dozen downloads); and `onnxruntime-node` ships
prebuilt native binaries, which is not the toolchain problem #5 is about but
is not pure JavaScript either. Icon detection is the real thing this design
lacks, and it is a deliberate follow-up, not an oversight.

**What regions will not find** is anything without a flat background: photos,
gradients, wallpaper. That is reported as no region, which is correct, and OCR
still runs over the bare screen.

**Hints are deliberately thin.** `bar` for a strip across the whole screen;
`button-like` for a small nested region with exactly one line of text centred
on it (a title bar has one line too, but left-aligned). Nothing else is
guessed. A fake accessibility tree with confident wrong roles would be worse
than boxes and text.

### Text: tesseract.js, per region, doubled

`tesseract.js` runs Tesseract as WebAssembly in a worker thread: pure
JavaScript as far as `npm install` is concerned, so #5's "no toolchain" holds.
It is the one serious OCR available that way. It is also the largest
dependency this project has by a wide margin (`tesseract.js-core` is about
45 MB on disk), which is why it was a question put to the owner rather than a
decision made here. Apache-2.0.

Two findings from the prototype shaped `src/ocr.js`:

- **OCR must run per region.** Whole-screen recognition of the test desktop
  returned `"-rw-r--r-- 1 user user 220 Sep 3 14:30 notes.txt Save changes?"`
  as one line: the terminal's listing and the dialog's title share a row of
  pixels and Tesseract read straight across the gap. It also returned the
  three buttons as `"| cancel || pontsave || save |"`. Each surface is
  therefore cropped out, with the surfaces inside it painted over in its own
  colour, and read alone; the buttons then read as exactly `Cancel`,
  `Don't Save`, `Save`.
- **Desktop text is small.** Tesseract expects print. At 14 px it read `ls` as
  `1s`; doubled with nearest-neighbour (crisp, not smoothed — blur is the last
  thing it needs) it did not, and dialog text went from 87% to 96%
  confidence. Crops up to half a megapixel are doubled; larger ones are read
  at 1× because doubling a whole screen costs more than it helps.

Boxes come back at line level by default (word level on request; five times
the output, noisier), mapped to desktop pixels. Lines below 30% confidence or
with no letter or digit in them are dropped: borders read as `|`, scrollbars
as `l`.

**Language data is an npm dependency**, `@tesseract.js-data/eng`, and the
worker is pointed at it. Left to its defaults tesseract.js downloads
`eng.traineddata` from a CDN on first use and writes it to the process's
current directory — for an MCP server, wherever the client happened to start
it. With the data installed there is no network and nothing written. Other
languages are `VNC_OCR_LANGS` plus a directory of their data. tesseract.js
does not reliably reject when a language file is missing (the worker can sit
forever), so the file is checked before the worker starts and the start has a
timeout.

**Lifecycle.** The worker starts on the first description, survives
reconnects, and is terminated on shutdown — including when the client closes
stdin, which the server now listens for, because a live worker thread would
otherwise keep the process alive after the client had gone.

### Measured

On the 1024×768 test desktop (a terminal, a dialog with three buttons, two
bars), this sandbox's CPU:

| Step | Time |
| --- | ---: |
| OCR worker start (once per process) | ~300–700 ms |
| Regions | ~150 ms |
| Text, all regions, first look | ~1.5 s |
| Regions only (`text: false`) | ~150 ms |
| Second look at an unchanged screen | cached |

| Reading | Whole screen, 1× | Per region, 2× |
| --- | --- | --- |
| Dialog title | `"‘Save changes?"` 87% | `"Save changes?"` 96% |
| Buttons | `"\| cancel \|\| pontsave \|\| save \|"` | `"Cancel"` `"Don't Save"` `"Save"` 94–95% |
| `$ ls -la` | `"$1s -la"` 62% | `"$ 1s -la"` 79% — still imperfect; green-on-black monospace at 14 px is hard |
