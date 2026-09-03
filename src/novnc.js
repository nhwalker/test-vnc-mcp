/**
 * Everything this server takes from noVNC, loaded in one place.
 *
 * noVNC is a browser VNC client, and its top-level `RFB` class genuinely cannot
 * run under Node: importing it fails on `MutationObserver` after it has already
 * reached for `document.body`, `offsetWidth` and `devicePixelRatio` — that is
 * browser layout behaviour, not something a few stubs can stand in for. See
 * DECISIONS.md #11 for the experiment.
 *
 * Underneath that class, though, most of noVNC is protocol logic with no DOM in
 * it at all, and this server uses a good part of it:
 *
 *   - `websock.js`        the receive/send queue every decoder is written against
 *   - `decoders/*.js`     Raw, CopyRect, RRE, Hextile, Zlib, Tight, TightPNG,
 *                         ZRLE and JPEG rectangle decoders
 *   - `inflator.js`       zlib, via noVNC's vendored pako (pulled in by the above)
 *   - `encodings.js`      the encoding numbers and their names
 *   - `crypto/des.js`     DES for VNC password auth — Node's OpenSSL 3 build no
 *                         longer offers single DES (`des-ecb` throws "unsupported")
 *   - `input/keysym.js`   X11 keysym constants and the Unicode -> keysym table
 *     `input/keysymdef.js`
 *   - `util/strings.js`   UTF-8 decoding for the desktop name
 *
 * Two things make this slightly awkward, and both are contained here:
 *
 *   1. `util/logging.js` binds `window.console` at import time, and almost every
 *      module above imports it. A `window` object with just `console`, `Error`
 *      and `crypto` on it (the three things noVNC ever reads from `window`
 *      outside the DOM-bound modules) is enough. It is defined before the
 *      imports below run.
 *
 *   2. `@novnc/novnc` declares `"exports": "./core/rfb.js"` as a bare string, so
 *      `import('@novnc/novnc/core/websock.js')` fails with
 *      ERR_PACKAGE_PATH_NOT_EXPORTED. We resolve the one public export and walk
 *      to its siblings — which survives pnpm and other non-flat layouts, but is
 *      still reaching past a package boundary. A noVNC release that moves these
 *      files breaks exactly here, loudly.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// (1) The minimal `window` noVNC's non-DOM modules expect. Deliberately not an
// alias of globalThis: nothing else should start believing it is in a browser.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = { console, Error, crypto: globalThis.crypto };
}

// (2) Locate noVNC's core directory through its single public export.
function novncCoreEntry() {
  if (typeof import.meta.resolve === 'function') {
    return import.meta.resolve('@novnc/novnc');
  }
  return pathToFileURL(createRequire(import.meta.url).resolve('@novnc/novnc')).href;
}

async function loadSibling(relativePath) {
  let entry;
  try {
    entry = novncCoreEntry();
  } catch (cause) {
    throw new Error('Could not resolve the @novnc/novnc package. Run `npm install`.', { cause });
  }

  const target = new URL(relativePath, entry).href;
  try {
    return await import(target);
  } catch (cause) {
    throw new Error(
      `Could not load ${relativePath} from noVNC (resolved to ${target}). ` +
        'This server imports noVNC\'s internal modules directly; a noVNC release ' +
        'that moves or renames them breaks exactly here. See src/novnc.js.',
      { cause },
    );
  }
}

const [
  websock,
  encodingsModule,
  strings,
  des,
  keysymModule,
  keysymdefModule,
  raw,
  copyrect,
  rre,
  hextile,
  zlib,
  tight,
  tightpng,
  zrle,
  jpeg,
] = await Promise.all([
  loadSibling('./websock.js'),
  loadSibling('./encodings.js'),
  loadSibling('./util/strings.js'),
  loadSibling('./crypto/des.js'),
  loadSibling('./input/keysym.js'),
  loadSibling('./input/keysymdef.js'),
  loadSibling('./decoders/raw.js'),
  loadSibling('./decoders/copyrect.js'),
  loadSibling('./decoders/rre.js'),
  loadSibling('./decoders/hextile.js'),
  loadSibling('./decoders/zlib.js'),
  loadSibling('./decoders/tight.js'),
  loadSibling('./decoders/tightpng.js'),
  loadSibling('./decoders/zrle.js'),
  loadSibling('./decoders/jpeg.js'),
]);

/** noVNC's buffered socket: `rQ*` to read, `sQ*` + `flush()` to write. */
export const Websock = websock.default;

/** Encoding numbers, e.g. `encodings.encodingTight`, `encodings.pseudoEncodingLastRect`. */
export const encodings = encodingsModule.encodings;

/** Human name for an encoding number, for messages. */
export const encodingName = encodingsModule.encodingName;

/** `decodeUTF8(str, allowLatin1)` */
export const decodeUTF8 = strings.decodeUTF8;

/** X11 keysym constants, keyed as `XK_Return`, `XK_Control_L`, ... */
export const XK = keysymModule.default;

/** `lookup(codepoint)` -> X11 keysym for a Unicode character. */
export const keysymdef = keysymdefModule.default;

/**
 * A fresh set of rectangle decoders, keyed by encoding number.
 *
 * Decoders carry state between calls (zlib streams, partially read rects), so
 * every connection gets its own set. Each one implements
 * `decodeRect(x, y, w, h, sock, display, depth) -> boolean`, returning false
 * when it needs more bytes; it is then called again with the same rectangle.
 */
export function createDecoders() {
  return {
    [encodings.encodingRaw]: new raw.default(),
    [encodings.encodingCopyRect]: new copyrect.default(),
    [encodings.encodingRRE]: new rre.default(),
    [encodings.encodingHextile]: new hextile.default(),
    [encodings.encodingZlib]: new zlib.default(),
    [encodings.encodingTight]: new tight.default(),
    [encodings.encodingTightPNG]: new tightpng.default(),
    [encodings.encodingZRLE]: new zrle.default(),
    [encodings.encodingJPEG]: new jpeg.default(),
  };
}

/**
 * The VNC authentication response: DES-ECB encrypt the server's 16-byte
 * challenge under the password, which acts as an 8-byte key (NUL-padded,
 * truncated past 8 characters — this is the protocol, not a shortcut). noVNC's
 * DES already uses the LSB-first key bit order VNC wants.
 *
 * @param {string} password
 * @param {Uint8Array} challenge 16 bytes
 * @returns {Uint8Array} 16 bytes
 */
export function vncAuthResponse(password, challenge) {
  const key = new Uint8Array(8);
  key.set(Buffer.from(password, 'latin1').subarray(0, 8));
  const cipher = des.DESECBCipher.importKey(key, { name: 'DES-ECB' }, false, ['encrypt']);
  return cipher.encrypt({ name: 'DES-ECB' }, new Uint8Array(challenge));
}
