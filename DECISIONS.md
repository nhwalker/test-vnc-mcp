# Decisions

A running record of the calls I made while building this that I would otherwise
have stopped and asked about. Each entry says what I chose, why, and what the
alternative was, so any of them can be reversed cheaply.

---

## 1. Language / runtime: Node.js (ESM), no build step

**Chosen:** plain JavaScript ESM on Node 20+, run directly (`node src/index.js`).

**Why:** the request was "keep it as simple as possible". noVNC — named in the
request — is a JavaScript package, so Node keeps everything in one language with
no FFI. Skipping TypeScript means there is no compile step between editing and
running, and no `dist/` to keep in sync.

**Alternative considered:** Python + `vncdotool`. It is a mature VNC automation
library and would have been less code, but it would have made the noVNC
dependency impossible.

---

## 2. How noVNC is actually used: as a source of two DOM-free helpers, not as the VNC client

This is the most important decision in the project, so it gets the most detail.

**The constraint:** noVNC's `RFB` class is a *browser* VNC client. It cannot run
under Node. Verified directly:

```
$ node -e "import('@novnc/novnc')"
ReferenceError: window is not defined
```

It needs `window`, `document`, a `<canvas>` for its framebuffer, and a
`WebSocket` (so it also needs a websockify TCP↔WebSocket bridge in front of any
real VNC server). Making that work under Node means `jsdom` + the native
`canvas` package + a WebSocket shim + websockify — four moving parts, a native
build, and a framebuffer that lives in a fake DOM. That is the opposite of
simple.

**What I did instead:** this server speaks the RFB protocol directly over a TCP
socket (`src/rfb.js`, ~400 lines), and imports from noVNC the two pieces that
are pure logic with no DOM dependency:

| noVNC module | What it gives us | Why not hand-roll it |
| --- | --- | --- |
| `core/crypto/des.js` | DES-ECB for VNC password authentication | Node's own crypto **cannot** do single DES anymore: `crypto.createCipheriv('des-ecb', …)` throws `error:0308010C:digital envelope routines::unsupported` under OpenSSL 3's default provider. VNC auth also needs DES with LSB-first key bits, which noVNC's port already handles. |
| `core/input/keysym.js`, `core/input/keysymdef.js` | Named X11 keysyms (`XK_Return`, `XK_Control_L`, …) and the Unicode→keysym table | ~1300 lines of generated lookup tables. Input injection is exactly what this table exists for. |

So noVNC is a genuine helper library here — it does the two jobs that are
annoying to redo — it just isn't the transport.

**One wrinkle worth knowing:** `@novnc/novnc`'s `package.json` declares
`"exports": "./core/rfb.js"` (a bare string), so subpath imports like
`@novnc/novnc/core/crypto/des.js` fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
`src/novnc.js` works around this by resolving the package's single public export
with `import.meta.resolve()` and then walking to its sibling files. That is more
robust than a hard-coded `node_modules/…` path (it survives pnpm and other
non-flat layouts), but it is still reaching past a package boundary, and a future
noVNC release could move those files. `src/novnc.js` fails loudly with an
explanatory message if that happens, and it is the single place to fix.

**Alternative considered and rejected:** drive noVNC for real inside the
pre-installed headless Chromium (Playwright) — take page screenshots, inject
input with `page.keyboard`/`page.mouse`. It genuinely uses noVNC as intended, but
it needs websockify plus a browser process per session, and screenshots would be
of a browser rendering of the desktop rather than the desktop's own pixels. Too
much machinery for "as simple as possible".

---

## 3. RFB feature scope: only what an agent actually needs

**Chosen encodings:** `Raw`, `CopyRect`, and the `DesktopSize` pseudo-encoding.

**Why:** Raw is mandatory in the RFB spec, so every server supports it and the
decoder is ~15 lines. CopyRect is nearly as trivial and saves a lot of bandwidth
on window drags and scrolls. DesktopSize lets us follow a resolution change
instead of desynchronising.

**Deliberately not implemented:** Tight, ZRLE, Hextile, TRLE. They are where the
real complexity of a VNC client lives (zlib streams, palettes, JPEG sub-encoding)
and they buy compression, not capability. On a loopback/LAN connection to a
container — the intended use — Raw is fine. If a slow link ever matters, Hextile
is the cheapest one to add next.

**Protocol versions:** RFB 3.3, 3.7 and 3.8. **Security types:** `None` (1) and
`VNC Authentication` (2). Not implemented: VeNCrypt, TLS, RA2, Tight auth, ARD.
Encrypted VNC transports are a real gap, but the target is a VNC server on
localhost or a container network, and adding TLS variants would roughly double
the handshake code.

---

## 4. Pixel format: force 32-bit true colour, little-endian BGRX

**Chosen:** the client sends `SetPixelFormat` to pin 32 bpp / depth 24 /
little-endian / RGB max 255 with shifts R=16 G=8 B=0.

**Why:** it means exactly one decoding path. Without it we would have to handle
whatever the server offers — 8-bit palettes, 16-bit 565, big-endian — and each is
a separate unpacking routine. Every server that matters honours `SetPixelFormat`.

---

## 5. Screenshots: PNG via `pngjs`, with an optional `scale`

**Chosen:** `pngjs` (pure JavaScript) to encode the framebuffer to PNG, plus a
`scale` parameter (0 < scale ≤ 1) that box-filters the image down before
encoding.

**Why PNG:** it is lossless, so text on the desktop stays readable, which is what
a model looking at a screenshot mostly needs.

**Why not `sharp`:** `sharp` would give much smaller JPEGs and faster resizing,
but it is a native module. Pure JS keeps `npm install` from needing a toolchain.

**Why `scale` exists:** a 1280×800 PNG is a few hundred KB, and screenshots go to
the model as base64. `scale` is the escape hatch when a full-resolution capture
is more image than the task needs. Screenshots are always encoded from the *full*
framebuffer the server sent us, so scaling never loses server-side state.

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

---

## 10. Testing: a container built here, driven end-to-end

**Chosen:** `test/Dockerfile` builds a small Debian image running Xvfb + x11vnc +
a couple of X clients; `test/smoke.mjs` starts it, connects, screenshots, injects
input, and asserts the pixels actually changed.

**Why:** screenshots and input injection are exactly the kind of thing that unit
tests with a mocked socket will happily pass while the real thing is broken. The
test covers both the no-password and password-protected paths, since VNC auth
(the DES code above) is otherwise never exercised.

**Not done:** unit tests for the RFB decoder in isolation. The end-to-end test
covers the same code and there is a limited amount of it.
