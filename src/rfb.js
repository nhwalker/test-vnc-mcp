/**
 * An RFB (VNC) client: a live copy of the remote framebuffer, plus pointer and
 * keyboard injection.
 *
 * Division of labour:
 *   - transport, handshake and the message loop are here (~300 lines of
 *     protocol that noVNC keeps inside its browser-only `RFB` class)
 *   - byte buffering is noVNC's `Websock`
 *   - every rectangle encoding is decoded by noVNC's own decoders, drawing into
 *     `Framebuffer`, which mimics the five methods they use on a Display
 *
 * Supported: RFB 3.3 / 3.7 / 3.8; security `None` and `VNC Authentication`;
 * encodings Tight, ZRLE, Hextile, RRE, Zlib, CopyRect, Raw, plus the
 * DesktopSize, LastRect and DesktopName pseudo-encodings. See DECISIONS.md #3
 * and #11 for what is left out and why.
 */

import net from 'node:net';
import {
  Websock,
  encodings as E,
  encodingName,
  createDecoders,
  decodeUTF8,
  vncAuthResponse,
} from './novnc.js';
import { Framebuffer } from './framebuffer.js';

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

/** Encodings the client can ask for, by the name used in options and stats. */
const ENCODING_BY_NAME = {
  copyrect: E.encodingCopyRect,
  tight: E.encodingTight,
  zrle: E.encodingZRLE,
  hextile: E.encodingHextile,
  rre: E.encodingRRE,
  zlib: E.encodingZlib,
  raw: E.encodingRaw,
};

/** Default preference order: best compression first; Raw is always implied. */
const DEFAULT_ENCODINGS = ['copyrect', 'tight', 'zrle', 'hextile', 'rre', 'zlib', 'raw'];

/**
 * A TCP socket dressed as the WebSocket-shaped channel noVNC's Websock
 * attaches to. This is the whole reason no websockify is needed.
 */
class TcpChannel {
  constructor(socket) {
    this._socket = socket;
    this.bytesReceived = 0;
    // Own properties, because Websock.attach() checks for each by name.
    this.binaryType = 'arraybuffer';
    this.protocol = '';
    this.readyState = 'open';
    this.onmessage = null;
    this.onopen = null;
    this.onclose = null;
    this.onerror = null;

    socket.on('data', (chunk) => {
      this.bytesReceived += chunk.length;
      this.onmessage?.({ data: chunk });
    });
    socket.on('error', (err) => this.onerror?.(err));
    socket.on('close', () => {
      this.readyState = 'closed';
      this.onclose?.({ code: 1006, reason: 'socket closed' });
    });
  }

  send(data) {
    // `data` is a view into Websock's send queue, which is reused immediately.
    this._socket.write(Buffer.from(data));
  }

  close() {
    this.readyState = 'closing';
    this._socket.end();
  }
}

export class RfbClient {
  constructor(socket, options) {
    this._socket = socket;
    this._options = options;
    this._channel = new TcpChannel(socket);
    this._sock = new Websock();
    this._sock.attach(this._channel);
    this._sock.on('close', () => this._shutdown(new Error('VNC connection closed by the server')));
    this._sock.on('error', (err) => this._shutdown(err instanceof Error ? err : new Error(String(err))));

    /** @type {Framebuffer} */
    this.fb = new Framebuffer();
    /** @type {string} */ this.name = '';
    /** Whatever the server last pushed as its clipboard. @type {string|null} */
    this.clipboard = null;

    /** Bumped once per completed FramebufferUpdate, so callers can wait for one. */
    this.updateCount = 0;
    /** Rectangles decoded so far, by encoding name: which one the server chose. */
    this.stats = { updates: 0, rects: {} };
    Object.defineProperty(this.stats, 'bytesReceived', { enumerable: true, get: () => this._channel.bytesReceived });

    this.closed = false;
    this.closeReason = null;

    this._decoders = createDecoders();
    this._update = { rects: 0, rect: null }; // FramebufferUpdate in progress
    this._buttonMask = 0;
    this._pointerX = 0;
    this._pointerY = 0;
    this._dataWaiter = null;
    this._updateWaiters = [];
  }

  get width() {
    return this.fb.width;
  }

  get height() {
    return this.fb.height;
  }

  /** RGBA, `width * height * 4` bytes. Live: copy before holding on to it. */
  get framebuffer() {
    return this.fb.data;
  }

  /**
   * @param {object} options
   * @param {string} [options.host]
   * @param {number} [options.port]
   * @param {string} [options.password]
   * @param {number} [options.timeoutMs]
   * @param {string[]} [options.encodings] preference order, from ENCODING_BY_NAME
   * @param {number} [options.quality] 0-9: allow lossy JPEG in Tight (unset = lossless)
   * @param {number} [options.compression] 0-9 zlib level hint (default 2, like noVNC)
   * @returns {Promise<RfbClient>}
   */
  static async connect({ host = '127.0.0.1', port = 5900, password = '', timeoutMs = 15000, ...rest } = {}) {
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

    const client = new RfbClient(socket, rest);
    try {
      await withTimeout(client._handshake(password), timeoutMs, 'VNC handshake');
    } catch (err) {
      client._shutdown(err);
      throw err;
    }
    return client;
  }

  // --- reading helpers -----------------------------------------------------

  /** Resolve once at least `n` bytes are waiting in the receive queue. */
  _need(n, what) {
    if (this.closed) return Promise.reject(new Error(this.closeReason));
    if (!this._sock.rQwait(what, n)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this._dataWaiter = { n, what, resolve, reject };
    });
  }

  _onHandshakeData() {
    const waiter = this._dataWaiter;
    if (waiter && !this._sock.rQwait(waiter.what, waiter.n)) {
      this._dataWaiter = null;
      waiter.resolve();
    }
  }

  async _readString(n) {
    await this._need(n, 'string');
    return this._sock.rQshiftStr(n);
  }

  // --- handshake -----------------------------------------------------------

  async _handshake(password) {
    this._sock.on('message', () => this._onHandshakeData());

    const banner = await this._readString(12);
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
    if (!match) throw new Error(`not a VNC server: unexpected greeting ${JSON.stringify(banner)}`);

    const serverVersion = Number(match[1]) * 1000 + Number(match[2]);
    const version = serverVersion >= 3008 ? 3008 : serverVersion >= 3007 ? 3007 : 3003;
    this._sock.sQpushString(`RFB 003.${String(version % 1000).padStart(3, '0')}\n`);
    this._sock.flush();

    const securityType = await this._negotiateSecurityType(version, password);
    await this._authenticate(version, securityType, password);

    this._sock.sQpush8(1); // ClientInit: share the desktop
    this._sock.flush();
    await this._readServerInit();

    this._sendPixelFormat();
    this._sendEncodings();

    // Hand the socket over to the message loop, draining anything already here.
    this._sock.on('message', () => this._processMessages());
    this._requestUpdate(false);
    this._processMessages();
  }

  async _negotiateSecurityType(version, password) {
    if (version === 3003) {
      await this._need(4, 'security type');
      const type = this._sock.rQshift32();
      if (type === 0) throw new Error(await this._readFailureReason());
      return type;
    }

    await this._need(1, 'security type count');
    const count = this._sock.rQshift8();
    if (count === 0) throw new Error(await this._readFailureReason());
    await this._need(count, 'security types');
    const offered = [...this._sock.rQshiftBytes(count)];

    const wanted = password ? [SEC_VNC_AUTH, SEC_NONE] : [SEC_NONE, SEC_VNC_AUTH];
    const chosen = wanted.find((type) => offered.includes(type));
    if (chosen === undefined) {
      throw new Error(
        `the server offers security types [${offered.join(', ')}], but this client only ` +
          'implements None (1) and VNC Authentication (2). See DECISIONS.md #3.',
      );
    }
    this._sock.sQpush8(chosen);
    this._sock.flush();
    return chosen;
  }

  async _authenticate(version, securityType, password) {
    let expectSecurityResult = version >= 3008;

    if (securityType === SEC_VNC_AUTH) {
      if (!password) {
        throw new Error('the server requires a password (VNC Authentication) but none was given');
      }
      await this._need(16, 'auth challenge');
      const challenge = this._sock.rQshiftBytes(16);
      this._sock.sQpushBytes(vncAuthResponse(password, challenge));
      this._sock.flush();
      expectSecurityResult = true;
    } else if (securityType !== SEC_NONE) {
      throw new Error(`unsupported VNC security type ${securityType}`);
    }

    if (!expectSecurityResult) return;
    await this._need(4, 'security result');
    const result = this._sock.rQshift32();
    if (result === 0) return;
    if (version >= 3008) throw new Error(`VNC authentication failed: ${await this._readFailureReason()}`);
    throw new Error('VNC authentication failed (wrong password?)');
  }

  async _readFailureReason() {
    try {
      await this._need(4, 'reason length');
      const length = this._sock.rQshift32();
      return decodeUTF8(await this._readString(length), true);
    } catch {
      return 'the server refused the connection without giving a reason';
    }
  }

  async _readServerInit() {
    await this._need(24, 'ServerInit');
    const width = this._sock.rQshift16();
    const height = this._sock.rQshift16();
    this._sock.rQskipBytes(16); // the server's pixel format; we set our own
    const nameLength = this._sock.rQshift32();
    this.fb.resize(width, height);
    this.name = decodeUTF8(await this._readString(nameLength), true);
  }

  /**
   * 32 bits per pixel, depth 24, little endian, true colour, red in the low
   * byte. In memory that is R, G, B, pad — exactly what noVNC's decoders
   * produce and what Framebuffer stores, so no pixel gets converted twice.
   */
  _sendPixelFormat() {
    const s = this._sock;
    s.sQpush8(0); // SetPixelFormat
    s.sQpush8(0);
    s.sQpush8(0);
    s.sQpush8(0);
    s.sQpush8(32); // bits per pixel
    s.sQpush8(24); // depth
    s.sQpush8(0); // big-endian flag
    s.sQpush8(1); // true-colour flag
    s.sQpush16(255); // red max
    s.sQpush16(255); // green max
    s.sQpush16(255); // blue max
    s.sQpush8(0); // red shift
    s.sQpush8(8); // green shift
    s.sQpush8(16); // blue shift
    s.sQpush8(0);
    s.sQpush8(0);
    s.sQpush8(0);
    s.flush();
  }

  _sendEncodings() {
    const names = this._options.encodings ?? DEFAULT_ENCODINGS;
    const list = names.map((name) => {
      const encoding = ENCODING_BY_NAME[String(name).toLowerCase()];
      if (encoding === undefined) {
        throw new Error(`unknown encoding "${name}"; choose from ${Object.keys(ENCODING_BY_NAME).join(', ')}`);
      }
      return encoding;
    });

    const { quality, compression = 2 } = this._options;
    list.push(E.pseudoEncodingCompressLevel0 + clamp(compression, 0, 9));
    if (quality !== undefined && quality !== null) {
      list.push(E.pseudoEncodingQualityLevel0 + clamp(quality, 0, 9));
    }
    list.push(E.pseudoEncodingDesktopSize, E.pseudoEncodingLastRect, E.pseudoEncodingDesktopName);

    const s = this._sock;
    s.sQpush8(2); // SetEncodings
    s.sQpush8(0);
    s.sQpush16(list.length);
    for (const encoding of list) s.sQpush32(encoding);
    s.flush();
  }

  // --- server messages -----------------------------------------------------

  /**
   * Drain whatever the receive queue holds. Every step either completes a
   * message or returns early with the queue positioned to resume, which is
   * the convention noVNC's decoders follow too: "false" means "more bytes".
   */
  _processMessages() {
    try {
      while (!this.closed) {
        if (this._update.rects > 0) {
          if (!this._framebufferUpdate()) return;
          continue;
        }
        if (this._sock.rQwait('message type', 1)) return;
        const type = this._sock.rQshift8();

        let complete;
        switch (type) {
          case 0:
            complete = this._framebufferUpdate();
            break;
          case 1:
            complete = this._setColourMapEntries();
            break;
          case 2: // Bell
            complete = true;
            break;
          case 3:
            complete = this._serverCutText();
            break;
          default:
            throw new Error(`unexpected message type ${type} from the VNC server`);
        }
        if (!complete) return;
      }
    } catch (err) {
      this._shutdown(err);
    }
  }

  _framebufferUpdate() {
    const s = this._sock;
    const update = this._update;

    if (update.rects === 0) {
      if (s.rQwait('update header', 3, 1)) return false; // 1: un-read the type byte
      s.rQskipBytes(1);
      update.rects = s.rQshift16();
    }

    while (update.rects > 0) {
      if (!update.rect) {
        if (s.rQwait('rectangle header', 12)) return false;
        update.rect = {
          x: s.rQshift16(),
          y: s.rQshift16(),
          width: s.rQshift16(),
          height: s.rQshift16(),
          encoding: s.rQshift32() | 0, // signed
        };
      }
      if (!this._handleRect(update.rect)) return false;
      update.rects -= 1;
      update.rect = null;
    }

    this.updateCount += 1;
    this.stats.updates += 1;
    this._notifyUpdate(true);
    // Keep exactly one request outstanding, so the framebuffer tracks the
    // desktop without polling.
    this._requestUpdate(true);
    return true;
  }

  _handleRect(rect) {
    const s = this._sock;
    switch (rect.encoding) {
      case E.pseudoEncodingLastRect:
        this._update.rects = 1; // decremented to zero by the caller
        return true;

      case E.pseudoEncodingDesktopSize:
        this.fb.resize(rect.width, rect.height);
        return true;

      case E.pseudoEncodingDesktopName: {
        if (s.rQwait('desktop name length', 4)) return false;
        const length = s.rQshift32();
        if (s.rQwait('desktop name', length, 4)) return false;
        this.name = decodeUTF8(s.rQshiftStr(length), true);
        return true;
      }

      default: {
        const decoder = this._decoders[rect.encoding];
        if (!decoder) {
          throw new Error(
            `the server sent a ${encodingName(rect.encoding)} rectangle, which this client ` +
              'did not ask for and cannot skip past',
          );
        }
        const complete = decoder.decodeRect(rect.x, rect.y, rect.width, rect.height, s, this.fb, 24);
        if (complete) {
          const name = encodingName(rect.encoding);
          this.stats.rects[name] = (this.stats.rects[name] ?? 0) + 1;
        }
        return complete;
      }
    }
  }

  _setColourMapEntries() {
    // We asked for true colour, so this should never arrive; consume it.
    const s = this._sock;
    if (s.rQwait('colour map header', 5, 1)) return false;
    s.rQskipBytes(3); // padding + first colour
    const count = s.rQshift16();
    if (s.rQwait('colour map', count * 6, 6)) return false;
    s.rQskipBytes(count * 6);
    return true;
  }

  _serverCutText() {
    const s = this._sock;
    if (s.rQwait('cut text header', 7, 1)) return false;
    s.rQskipBytes(3);
    const length = s.rQshift32();
    if (s.rQwait('cut text', length, 8)) return false;
    this.clipboard = s.rQshiftStr(length); // Latin-1 by protocol
    return true;
  }

  // --- client messages -----------------------------------------------------

  _requestUpdate(incremental) {
    if (this.closed) return;
    const s = this._sock;
    s.sQpush8(3); // FramebufferUpdateRequest
    s.sQpush8(incremental ? 1 : 0);
    s.sQpush16(0);
    s.sQpush16(0);
    s.sQpush16(this.fb.width);
    s.sQpush16(this.fb.height);
    s.flush();
  }

  _assertOpen() {
    if (this.closed) throw new Error(`VNC connection is closed: ${this.closeReason ?? 'no reason given'}`);
  }

  /** Move the pointer and/or change which buttons are held. */
  pointerEvent(x, y, buttonMask) {
    this._assertOpen();
    this._pointerX = clamp(Math.round(x), 0, Math.max(0, this.fb.width - 1));
    this._pointerY = clamp(Math.round(y), 0, Math.max(0, this.fb.height - 1));
    this._buttonMask = buttonMask;
    const s = this._sock;
    s.sQpush8(5); // PointerEvent
    s.sQpush8(buttonMask);
    s.sQpush16(this._pointerX);
    s.sQpush16(this._pointerY);
    s.flush();
  }

  get pointer() {
    return { x: this._pointerX, y: this._pointerY, buttons: this._buttonMask };
  }

  /** Press (`down`) or release a key, by X11 keysym. */
  keyEvent(keysym, down) {
    this._assertOpen();
    const s = this._sock;
    s.sQpush8(4); // KeyEvent
    s.sQpush8(down ? 1 : 0);
    s.sQpush16(0);
    s.sQpush32(keysym >>> 0);
    s.flush();
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

  /**
   * Resolve once no framebuffer update has arrived for `quietMs` in a row —
   * the desktop has finished repainting — or give up after `maxWaitMs`.
   *
   * A screen that never stops changing (video, a clock) simply waits out
   * `maxWaitMs`; that is a bounded cost, not an error.
   *
   * @returns {Promise<boolean>} true if the screen went quiet, false if it was
   *   still changing when the time ran out
   */
  async waitForQuiet(quietMs, maxWaitMs) {
    const deadline = Date.now() + maxWaitMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const updated = await this.waitForUpdate(Math.min(quietMs, remaining));
      // No update for the whole window is "quiet"; no update for a shorter
      // window that ran into the deadline is "gave up".
      if (!updated) return remaining >= quietMs;
    }
  }

  _notifyUpdate(updated) {
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
    if (this._dataWaiter) {
      const { reject } = this._dataWaiter;
      this._dataWaiter = null;
      reject(err);
    }
    // Release anyone waiting, as "nothing arrived": the connection went away.
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
