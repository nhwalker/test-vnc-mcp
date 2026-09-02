/**
 * Access to the parts of noVNC that work outside a browser.
 *
 * noVNC's own RFB client cannot run here: importing it under Node throws
 * `ReferenceError: window is not defined`, because it wants a DOM, a <canvas>
 * to paint the framebuffer into, and a WebSocket (hence also a websockify
 * bridge in front of the VNC server). See DECISIONS.md #2.
 *
 * What noVNC does give us is two chunks of pure logic with no DOM dependency,
 * both of which are genuinely tedious to reproduce:
 *
 *   - `core/crypto/des.js` — DES-ECB, which VNC password authentication needs.
 *     Node cannot help here: `crypto.createCipheriv('des-ecb', ...)` throws
 *     `error:0308010C:digital envelope routines::unsupported` under OpenSSL 3's
 *     default provider. noVNC's port also already expects the LSB-first key bit
 *     order that VNC auth uses, so passwords go in as-is.
 *
 *   - `core/input/keysym.js` and `core/input/keysymdef.js` — the X11 keysym
 *     constants and the Unicode -> keysym table, roughly 1300 lines of
 *     generated lookup data that input injection is built on.
 *
 * The awkward part: @novnc/novnc declares `"exports": "./core/rfb.js"` as a
 * bare string, so `import('@novnc/novnc/core/crypto/des.js')` fails with
 * ERR_PACKAGE_PATH_NOT_EXPORTED. We resolve the package's one public export and
 * walk to its siblings, which beats hard-coding a `node_modules/...` path
 * because it survives pnpm and other non-flat layouts. It is still reaching
 * past a package boundary, so if a future noVNC moves these files this module
 * is the single place to fix, and it says so out loud.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function novncCoreEntry() {
  // `import.meta.resolve` is the direct route; `require.resolve` is the
  // fallback for Node versions where it is not available. Both honour the
  // package's "exports" field and land on core/rfb.js.
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
    throw new Error(
      'Could not resolve the @novnc/novnc package. Run `npm install`.',
      { cause },
    );
  }

  const target = new URL(relativePath, entry).href;
  try {
    return await import(target);
  } catch (cause) {
    throw new Error(
      `Could not load ${relativePath} from noVNC (resolved to ${target}). ` +
        'This server uses noVNC\'s DES and keysym modules directly; a noVNC ' +
        'release that moves or renames them would break exactly here. ' +
        'See the comment at the top of src/novnc.js.',
      { cause },
    );
  }
}

const [des, keysymModule, keysymdefModule] = await Promise.all([
  loadSibling('./crypto/des.js'),
  loadSibling('./input/keysym.js'),
  loadSibling('./input/keysymdef.js'),
]);

/** X11 keysym constants, keyed as `XK_Return`, `XK_Control_L`, ... */
export const XK = keysymModule.default;

/** `lookup(codepoint)` -> X11 keysym for a Unicode character. */
export const keysymdef = keysymdefModule.default;

/**
 * The VNC authentication response: DES-ECB encrypt the server's 16-byte
 * challenge under the password, which acts as an 8-byte key (NUL-padded,
 * truncated past 8 characters — this is the protocol, not a shortcut).
 *
 * @param {string} password
 * @param {Buffer} challenge 16 bytes
 * @returns {Buffer} 16 bytes
 */
export function vncAuthResponse(password, challenge) {
  const key = new Uint8Array(8);
  key.set(Buffer.from(password, 'latin1').subarray(0, 8));
  const cipher = des.DESECBCipher.importKey(key, { name: 'DES-ECB' }, false, ['encrypt']);
  return Buffer.from(cipher.encrypt({ name: 'DES-ECB' }, new Uint8Array(challenge)));
}
