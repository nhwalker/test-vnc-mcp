/**
 * The gesture layer: complete actions ("click at 10,20", "type hello") built
 * on top of the raw RFB events, plus the single connection the MCP tools share.
 *
 * RFB's own input messages are a pointer button *bitmask* and separate key
 * down/up events. Exposing those directly would make the caller track button
 * and modifier state across tool calls, which is how automation ends up with a
 * stuck Ctrl or a window dragged across the desktop. Everything here starts and
 * ends with no buttons and no modifiers held (DECISIONS.md #8).
 */

import { RfbClient, BUTTONS, delay } from './rfb.js';
import { keysymsForText, parseCombo } from './keys.js';
import { encodePng } from './png.js';

/** How long to wait for the desktop to repaint after input, by default. */
const DEFAULT_SETTLE_MS = 250;

/** Milliseconds between the keystrokes of `type`. */
const DEFAULT_KEY_DELAY_MS = 12;

export class VncSession {
  constructor(env = process.env) {
    /** @type {RfbClient | null} */
    this.client = null;
    this.target = null;
    this.defaults = {
      host: env.VNC_HOST || '127.0.0.1',
      port: Number(env.VNC_PORT || 5900),
      password: env.VNC_PASSWORD || '',
    };
  }

  /** Open a connection, replacing any existing one. */
  async connect({ host, port, password, timeoutMs = 15000 } = {}) {
    this.disconnect();
    const target = {
      host: host ?? this.defaults.host,
      port: port ?? this.defaults.port,
      password: password ?? this.defaults.password,
    };
    this.client = await RfbClient.connect({ ...target, timeoutMs });
    this.target = { host: target.host, port: target.port };
    // The first full framebuffer arrives asynchronously; without this a
    // screenshot taken immediately after connecting can be a blank screen.
    await this.client.waitForUpdate(Math.min(timeoutMs, 5000));
    return this.status();
  }

  disconnect() {
    if (!this.client) return false;
    this.client.close();
    this.client = null;
    this.target = null;
    return true;
  }

  /**
   * The connection every other method runs against, connecting with the
   * configured defaults if there is not one yet.
   */
  async ensureConnected() {
    if (this.client && !this.client.closed) return this.client;
    if (this.client?.closed) {
      const reason = this.client.closeReason;
      this.client = null;
      // Reconnecting silently would hide a server that keeps dropping us.
      throw new Error(`the VNC connection dropped (${reason}); call vnc_connect again`);
    }
    await this.connect();
    return this.client;
  }

  status() {
    if (!this.client || this.client.closed) {
      return { connected: false, defaults: { ...this.defaults, password: undefined } };
    }
    return {
      connected: true,
      host: this.target.host,
      port: this.target.port,
      desktopName: this.client.name,
      width: this.client.width,
      height: this.client.height,
      pointer: this.client.pointer,
    };
  }

  /** @returns {Promise<{ png: Buffer, width: number, height: number, sourceWidth: number, sourceHeight: number }>} */
  async screenshot({ scale = 1, maxWidth } = {}) {
    const client = await this.ensureConnected();
    const result = encodePng(client.framebuffer, client.width, client.height, { scale, maxWidth });
    return { ...result, sourceWidth: client.width, sourceHeight: client.height };
  }

  // --- pointer -------------------------------------------------------------

  async move({ x, y, settleMs = DEFAULT_SETTLE_MS }) {
    const client = await this.ensureConnected();
    client.pointerEvent(x, y, 0);
    return this._settle(client, settleMs, `moved the pointer to (${x}, ${y})`);
  }

  async click({ x, y, button = 'left', clicks = 1, settleMs = DEFAULT_SETTLE_MS }) {
    const client = await this.ensureConnected();
    const mask = buttonMask(button);

    client.pointerEvent(x, y, 0); // land first: some widgets act on hover
    for (let i = 0; i < clicks; i++) {
      if (i > 0) await delay(60); // inside the usual double-click interval
      client.pointerEvent(x, y, mask);
      await delay(20);
      client.pointerEvent(x, y, 0);
    }

    const what = clicks === 1 ? 'clicked' : `${clicks}x clicked`;
    return this._settle(client, settleMs, `${what} ${button} at (${x}, ${y})`);
  }

  async drag({ fromX, fromY, toX, toY, button = 'left', steps = 12, settleMs = DEFAULT_SETTLE_MS }) {
    const client = await this.ensureConnected();
    const mask = buttonMask(button);

    client.pointerEvent(fromX, fromY, 0);
    await delay(20);
    client.pointerEvent(fromX, fromY, mask);
    // Intermediate positions matter: a single jump reads as a teleport and many
    // drag handlers ignore it.
    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      client.pointerEvent(fromX + (toX - fromX) * t, fromY + (toY - fromY) * t, mask);
      await delay(15);
    }
    client.pointerEvent(toX, toY, 0);

    return this._settle(client, settleMs, `dragged ${button} from (${fromX}, ${fromY}) to (${toX}, ${toY})`);
  }

  async scroll({ x, y, direction = 'down', amount = 3, settleMs = DEFAULT_SETTLE_MS }) {
    const client = await this.ensureConnected();
    const mask = buttonMask(
      { up: 'wheelUp', down: 'wheelDown', left: 'wheelLeft', right: 'wheelRight' }[direction] ?? '',
      `unknown scroll direction "${direction}"; use up, down, left or right`,
    );

    const at = { x: x ?? client.pointer.x, y: y ?? client.pointer.y };
    client.pointerEvent(at.x, at.y, 0);
    for (let i = 0; i < amount; i++) {
      client.pointerEvent(at.x, at.y, mask);
      await delay(10);
      client.pointerEvent(at.x, at.y, 0);
      await delay(10);
    }

    return this._settle(client, settleMs, `scrolled ${direction} ${amount} at (${at.x}, ${at.y})`);
  }

  // --- keyboard ------------------------------------------------------------

  async type({ text, delayMs = DEFAULT_KEY_DELAY_MS, settleMs = DEFAULT_SETTLE_MS }) {
    const client = await this.ensureConnected();
    const keysyms = keysymsForText(text);
    for (const keysym of keysyms) {
      client.keyEvent(keysym, true);
      client.keyEvent(keysym, false);
      if (delayMs > 0) await delay(delayMs);
    }
    return this._settle(client, settleMs, `typed ${keysyms.length} character(s)`);
  }

  async key({ keys, presses = 1, settleMs = DEFAULT_SETTLE_MS }) {
    const client = await this.ensureConnected();
    const { modifiers, key } = parseCombo(keys);

    for (const modifier of modifiers) client.keyEvent(modifier, true);
    try {
      for (let i = 0; i < presses; i++) {
        if (i > 0) await delay(30);
        client.keyEvent(key, true);
        client.keyEvent(key, false);
      }
    } finally {
      // Release held modifiers even if a send failed, so the desktop is not
      // left with a stuck Ctrl.
      for (const modifier of [...modifiers].reverse()) {
        try {
          client.keyEvent(modifier, false);
        } catch {
          /* the connection is already gone; nothing to release */
        }
      }
    }

    const what = presses === 1 ? `pressed ${keys}` : `pressed ${keys} ${presses}x`;
    return this._settle(client, settleMs, what);
  }

  // --- shared --------------------------------------------------------------

  /**
   * Give the desktop a moment to repaint, then describe what happened. Waiting
   * here is what stops the caller from screenshotting a stale screen
   * (DECISIONS.md #9).
   */
  async _settle(client, settleMs, description) {
    const before = client.updateCount;
    const changed = await client.waitForUpdate(settleMs);
    const suffix = changed
      ? `screen updated (${client.updateCount - before} update(s))`
      : `no screen change within ${settleMs}ms`;
    return `${description}; ${suffix}. Desktop is ${client.width}x${client.height}.`;
  }
}

function buttonMask(name, message) {
  const mask = BUTTONS[name];
  if (mask === undefined) {
    throw new Error(message ?? `unknown mouse button "${name}"; use left, middle or right`);
  }
  return mask;
}
