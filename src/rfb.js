/**
 * A small RFB (VNC) client: enough of the protocol to keep a live copy of the
 * remote framebuffer and to inject pointer and keyboard events.
 *
 * Scope is deliberately narrow (DECISIONS.md #3, #4):
 *   - protocol versions 3.3, 3.7, 3.8
 *   - security types None (1) and VNC Authentication (2)
 *   - encodings Raw, CopyRect, and the DesktopSize pseudo-encoding
 *   - a pixel format we pin ourselves, so there is one decoding path
 *
 * Everything left out (Tight, ZRLE, Hextile, TLS/VeNCrypt) buys compression or
 * transport security rather than capability, and each would cost more code than
 * the whole of this file.
 */

import net from 'node:net';
import { vncAuthResponse } from './novnc.js';

// Client -> server message types.
const MSG_SET_PIXEL_FORMAT = 0;
const MSG_SET_ENCODINGS = 2;
const MSG_FB_UPDATE_REQUEST = 3;
const MSG_KEY_EVENT = 4;
const MSG_POINTER_EVENT = 5;

// Server -> client message types.
const MSG_FB_UPDATE = 0;
const MSG_SET_COLOUR_MAP = 1;
const MSG_BELL = 2;
const MSG_SERVER_CUT_TEXT = 3;

// Encodings.
const ENC_RAW = 0;
const ENC_COPY_RECT = 1;
const ENC_DESKTOP_SIZE = -223;
const ENC_LAST_RECT = -224;

const SEC_NONE = 1;
const SEC_VNC_AUTH = 2;

/** Pointer button bits in the RFB button mask. */
export const BUTTONS = {
  left: 1,
  middle: 2,
  right: 4,
  wheelUp: 8,
  wheelDown: 16,
  wheelLeft: 32,
  wheelRight: 64,
};

/**
 * Reads an exact number of bytes at a time from a socket, so the protocol can
 * be written as a straight-line async function instead of a state machine.
 */
class ByteStream {
  constructor(socket) {
    this._chunks = [];
    this._length = 0;
    this._pending = null; // { need, resolve, reject }
    this._error = null;

    socket.on('data', (chunk) => {
      this._chunks.push(chunk);
      this._length += chunk.length;
      this._settle();
    });
    socket.on('error', (err) => this._fail(err));
    socket.on('close', () => this._fail(new Error('VNC connection closed by the server')));
  }

  _fail(err) {
    if (this._error) return;
    this._error = err;
    if (this._pending) {
      const { reject } = this._pending;
      this._pending = null;
      reject(err);
    }
  }

  _settle() {
    if (!this._pending || this._length < this._pending.need) return;
    const { need, resolve } = this._pending;
    this._pending = null;
    resolve(this._take(need));
  }

  _take(n) {
    const out = Buffer.allocUnsafe(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this._chunks[0];
      const take = Math.min(chunk.length, n - offset);
      chunk.copy(out, offset, 0, take);
      offset += take;
      if (take === chunk.length) this._chunks.shift();
      else this._chunks[0] = chunk.subarray(take);
    }
    this._length -= n;
    return out;
  }

  /** @returns {Promise<Buffer>} exactly `n` bytes */
  read(n) {
    if (n === 0) return Promise.resolve(Buffer.alloc(0));
    if (this._length >= n) return Promise.resolve(this._take(n));
    if (this._error) return Promise.reject(this._error);
    if (this._pending) return Promise.reject(new Error('concurrent reads on the VNC socket'));
    return new Promise((resolve, reject) => {
      this._pending = { need: n, resolve, reject };
    });
  }
}

/**
 * The pixel format we ask the server for: 32 bits per pixel, depth 24, little
 * endian, true colour, with red at shift 16. Stored little endian that is
 * B, G, R, unused per pixel, which we unpack to RGBA.
 */
function ourPixelFormat() {
  const pf = Buffer.alloc(16);
  pf.writeUInt8(32, 0); // bits per pixel
  pf.writeUInt8(24, 1); // depth
  pf.writeUInt8(0, 2); // big endian flag
  pf.writeUInt8(1, 3); // true colour flag
  pf.writeUInt16BE(255, 4); // red max
  pf.writeUInt16BE(255, 6); // green max
  pf.writeUInt16BE(255, 8); // blue max
  pf.writeUInt8(16, 10); // red shift
  pf.writeUInt8(8, 11); // green shift
  pf.writeUInt8(0, 12); // blue shift
  return pf;
}

export class RfbClient {
  constructor(socket, stream) {
    this._socket = socket;
    this._stream = stream;

    /** @type {number} */ this.width = 0;
    /** @type {number} */ this.height = 0;
    /** @type {string} */ this.name = '';
    /** RGBA, `width * height * 4` bytes. @type {Buffer} */
    this.framebuffer = Buffer.alloc(0);

    /** Bumped once per completed FramebufferUpdate, so callers can wait for one. */
    this.updateCount = 0;
    /** Whatever the server last pushed as its clipboard, if anything. @type {string|null} */
    this.clipboard = null;
    this.closed = false;
    this.closeReason = null;

    this._buttonMask = 0;
    this._pointerX = 0;
    this._pointerY = 0;
    this._updateWaiters = [];
  }

  /**
   * @param {object} options
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {string} [options.password]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<RfbClient>}
   */
  static async connect({ host = '127.0.0.1', port = 5900, password = '', timeoutMs = 15000 } = {}) {
    const socket = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`timed out connecting to ${host}:${port} after ${timeoutMs}ms`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        resolve(s);
      });
      s.once('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`could not connect to ${host}:${port}: ${err.message}`, { cause: err }));
      });
    });

    const client = new RfbClient(socket, new ByteStream(socket));
    try {
      await withTimeout(client._handshake(password), timeoutMs, 'VNC handshake');
    } catch (err) {
      socket.destroy();
      throw err;
    }

    // Run the message loop in the background; it feeds `framebuffer`.
    client._pump().catch((err) => client._shutdown(err));
    client._requestUpdate(false);
    return client;
  }

  // --- handshake -----------------------------------------------------------

  async _handshake(password) {
    const banner = (await this._stream.read(12)).toString('ascii');
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
    if (!match) throw new Error(`not a VNC server: unexpected greeting ${JSON.stringify(banner)}`);

    const serverVersion = Number(match[1]) * 1000 + Number(match[2]);
    // Speak the highest version we understand that the server also does.
    const version = serverVersion >= 3008 ? 3008 : serverVersion >= 3007 ? 3007 : 3003;
    this._send(Buffer.from(`RFB 003.${String(version % 1000).padStart(3, '0')}\n`, 'ascii'));

    const securityType = await this._negotiateSecurityType(version, password);
    await this._authenticate(version, securityType, password);

    this._send(Buffer.from([1])); // ClientInit: share the desktop
    await this._readServerInit();

    this._send(Buffer.concat([Buffer.from([MSG_SET_PIXEL_FORMAT, 0, 0, 0]), ourPixelFormat()]));
    this._sendEncodings([ENC_COPY_RECT, ENC_RAW, ENC_DESKTOP_SIZE]);
  }

  async _negotiateSecurityType(version, password) {
    if (version === 3003) {
      // The server dictates the security type outright in 3.3.
      const type = (await this._stream.read(4)).readUInt32BE(0);
      if (type === 0) throw new Error(await this._readFailureReason());
      return type;
    }

    const count = (await this._stream.read(1))[0];
    if (count === 0) throw new Error(await this._readFailureReason());
    const offered = [...(await this._stream.read(count))];

    // Prefer no authentication when the server allows it and we have no
    // password to send; otherwise use VNC auth if it is on the menu.
    const wanted = password ? [SEC_VNC_AUTH, SEC_NONE] : [SEC_NONE, SEC_VNC_AUTH];
    const chosen = wanted.find((type) => offered.includes(type));
    if (chosen === undefined) {
      throw new Error(
        `the server offers security types [${offered.join(', ')}], but this client only ` +
          'implements None (1) and VNC Authentication (2). See DECISIONS.md #3.',
      );
    }
    this._send(Buffer.from([chosen]));
    return chosen;
  }

  async _authenticate(version, securityType, password) {
    let expectSecurityResult = version >= 3008;

    if (securityType === SEC_VNC_AUTH) {
      if (!password) {
        throw new Error('the server requires a password (VNC Authentication) but none was given');
      }
      const challenge = await this._stream.read(16);
      this._send(vncAuthResponse(password, challenge));
      expectSecurityResult = true; // sent for VNC auth in every protocol version
    } else if (securityType !== SEC_NONE) {
      throw new Error(`unsupported VNC security type ${securityType}`);
    }

    if (!expectSecurityResult) return;
    const result = (await this._stream.read(4)).readUInt32BE(0);
    if (result === 0) return;
    if (version >= 3008) throw new Error(`VNC authentication failed: ${await this._readFailureReason()}`);
    throw new Error('VNC authentication failed (wrong password?)');
  }

  async _readFailureReason() {
    try {
      const length = (await this._stream.read(4)).readUInt32BE(0);
      return (await this._stream.read(length)).toString('utf8');
    } catch {
      return 'the server refused the connection without giving a reason';
    }
  }

  async _readServerInit() {
    const header = await this._stream.read(24);
    this._resize(header.readUInt16BE(0), header.readUInt16BE(2));
    const nameLength = header.readUInt32BE(20);
    this.name = (await this._stream.read(nameLength)).toString('utf8');
  }

  // --- server messages -----------------------------------------------------

  async _pump() {
    for (;;) {
      const type = (await this._stream.read(1))[0];
      switch (type) {
        case MSG_FB_UPDATE:
          await this._readFramebufferUpdate();
          this.updateCount += 1;
          this._notifyUpdate();
          // Keep exactly one update request outstanding, so the framebuffer
          // tracks the desktop without us polling.
          this._requestUpdate(true);
          break;
        case MSG_SET_COLOUR_MAP: {
          // We asked for true colour, so this should never arrive; consume it.
          const header = await this._stream.read(5);
          await this._stream.read(header.readUInt16BE(3) * 6);
          break;
        }
        case MSG_BELL:
          break;
        case MSG_SERVER_CUT_TEXT: {
          const header = await this._stream.read(7);
          this.clipboard = (await this._stream.read(header.readUInt32BE(3))).toString('latin1');
          break;
        }
        default:
          throw new Error(`unexpected message type ${type} from the VNC server`);
      }
    }
  }

  async _readFramebufferUpdate() {
    const count = (await this._stream.read(3)).readUInt16BE(1);
    for (let i = 0; count === 0xffff || i < count; i++) {
      const header = await this._stream.read(12);
      const x = header.readUInt16BE(0);
      const y = header.readUInt16BE(2);
      const w = header.readUInt16BE(4);
      const h = header.readUInt16BE(6);
      const encoding = header.readInt32BE(8);

      if (encoding === ENC_RAW) await this._readRaw(x, y, w, h);
      else if (encoding === ENC_COPY_RECT) await this._readCopyRect(x, y, w, h);
      else if (encoding === ENC_DESKTOP_SIZE) this._resize(w, h);
      else if (encoding === ENC_LAST_RECT) break;
      else {
        // Rectangle lengths are encoding-specific, so an unknown one means we
        // no longer know where the next message starts.
        throw new Error(
          `the server used encoding ${encoding}, which this client did not ask for and ` +
            'cannot skip past. See DECISIONS.md #3.',
        );
      }
    }
  }

  async _readRaw(x, y, w, h) {
    if (w === 0 || h === 0) return;
    const pixels = await this._stream.read(w * h * 4);
    const { width, framebuffer } = this;
    for (let row = 0; row < h; row++) {
      let src = row * w * 4;
      let dst = ((y + row) * width + x) * 4;
      for (let col = 0; col < w; col++, src += 4, dst += 4) {
        framebuffer[dst] = pixels[src + 2]; // R
        framebuffer[dst + 1] = pixels[src + 1]; // G
        framebuffer[dst + 2] = pixels[src]; // B
        framebuffer[dst + 3] = 255;
      }
    }
  }

  async _readCopyRect(x, y, w, h) {
    const src = await this._stream.read(4);
    const srcX = src.readUInt16BE(0);
    const srcY = src.readUInt16BE(2);
    const { width, framebuffer } = this;
    const rowBytes = w * 4;
    // Copy away from the overlap so a shifted region does not smear itself.
    const rows = srcY < y ? [...Array(h).keys()].reverse() : [...Array(h).keys()];
    for (const row of rows) {
      const from = ((srcY + row) * width + srcX) * 4;
      const to = ((y + row) * width + x) * 4;
      framebuffer.copy(framebuffer, to, from, from + rowBytes);
    }
  }

  _resize(width, height) {
    if (width === this.width && height === this.height) return;
    const next = Buffer.alloc(width * height * 4);
    // Keep whatever still fits, so a resize does not blank the screen.
    const keepRows = Math.min(height, this.height);
    const keepBytes = Math.min(width, this.width) * 4;
    for (let row = 0; row < keepRows; row++) {
      this.framebuffer.copy(next, row * width * 4, row * this.width * 4, row * this.width * 4 + keepBytes);
    }
    this.width = width;
    this.height = height;
    this.framebuffer = next;
  }

  // --- client messages -----------------------------------------------------

  _send(buffer) {
    if (this.closed) throw new Error(`VNC connection is closed: ${this.closeReason ?? 'no reason given'}`);
    this._socket.write(buffer);
  }

  _sendEncodings(encodings) {
    const message = Buffer.alloc(4 + encodings.length * 4);
    message.writeUInt8(MSG_SET_ENCODINGS, 0);
    message.writeUInt16BE(encodings.length, 2);
    encodings.forEach((encoding, i) => message.writeInt32BE(encoding, 4 + i * 4));
    this._send(message);
  }

  _requestUpdate(incremental) {
    if (this.closed) return;
    const message = Buffer.alloc(10);
    message.writeUInt8(MSG_FB_UPDATE_REQUEST, 0);
    message.writeUInt8(incremental ? 1 : 0, 1);
    message.writeUInt16BE(this.width, 6);
    message.writeUInt16BE(this.height, 8);
    this._send(message);
  }

  /** Move the pointer and/or change which buttons are held. */
  pointerEvent(x, y, buttonMask) {
    this._pointerX = clamp(Math.round(x), 0, Math.max(0, this.width - 1));
    this._pointerY = clamp(Math.round(y), 0, Math.max(0, this.height - 1));
    this._buttonMask = buttonMask;
    const message = Buffer.alloc(6);
    message.writeUInt8(MSG_POINTER_EVENT, 0);
    message.writeUInt8(buttonMask, 1);
    message.writeUInt16BE(this._pointerX, 2);
    message.writeUInt16BE(this._pointerY, 4);
    this._send(message);
  }

  get pointer() {
    return { x: this._pointerX, y: this._pointerY, buttons: this._buttonMask };
  }

  /** Press (`down`) or release a key, by X11 keysym. */
  keyEvent(keysym, down) {
    const message = Buffer.alloc(8);
    message.writeUInt8(MSG_KEY_EVENT, 0);
    message.writeUInt8(down ? 1 : 0, 1);
    message.writeUInt32BE(keysym >>> 0, 4);
    this._send(message);
  }

  // --- waiting -------------------------------------------------------------

  /**
   * Resolve once the server sends another framebuffer update, or after
   * `timeoutMs`. Resolves either way: "nothing changed" is a normal outcome.
   *
   * @returns {Promise<boolean>} whether an update arrived
   */
  waitForUpdate(timeoutMs) {
    if (this.closed || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter = { resolve };
      waiter.timer = setTimeout(() => {
        this._updateWaiters = this._updateWaiters.filter((w) => w !== waiter);
        resolve(false);
      }, timeoutMs);
      this._updateWaiters.push(waiter);
    });
  }

  _notifyUpdate(updated = true) {
    const waiters = this._updateWaiters;
    this._updateWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(updated);
    }
  }

  _shutdown(err) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = err?.message ?? 'closed';
    this._socket.destroy();
    // Release anyone waiting, but as "nothing arrived" — the screen did not
    // update, the connection went away.
    this._notifyUpdate(false);
  }

  close() {
    this._shutdown(new Error('closed by the client'));
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    }),
  ]);
}

/** Sleep, for pacing input events. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
