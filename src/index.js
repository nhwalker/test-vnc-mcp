#!/usr/bin/env node
/**
 * vnc-mcp — an MCP server that lets an agent see and control a VNC desktop.
 *
 * Transport is stdio, so stdout belongs to the protocol: anything this process
 * wants to say goes to stderr.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { VncSession } from './session.js';

const session = new VncSession();

const server = new McpServer(
  { name: 'vnc-mcp', version: '0.1.0' },
  {
    instructions:
      'Controls a remote desktop over VNC. Take a screenshot with vnc_screenshot to see ' +
      'the screen, then act on it with vnc_click, vnc_type, vnc_key and friends. ' +
      'Coordinates are pixels from the top-left of the desktop at its full size — if you ' +
      'take a scaled-down screenshot, scale the coordinates you read off it back up. ' +
      'The connection opens on first use from the server configuration; call vnc_connect ' +
      'only to point at a different desktop.',
  },
);

/** Options every input tool shares. */
const settleMs = z
  .number()
  .int()
  .min(0)
  .max(30000)
  .optional()
  .describe('How long to wait for the screen to repaint afterwards, in ms (default 250).');

/** Wrap a handler so failures come back as tool errors rather than killing the server. */
function tool(name, config, handler) {
  server.registerTool(name, config, async (args) => {
    try {
      return await handler(args ?? {});
    } catch (error) {
      return {
        isError: true,
        content: [{ type: 'text', text: error?.message ?? String(error) }],
      };
    }
  });
}

const text = (value) => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
});

// --- connection --------------------------------------------------------------

tool(
  'vnc_connect',
  {
    title: 'Connect to a VNC server',
    description:
      'Connect to a VNC server, replacing any current connection. Each argument falls back ' +
      'to the VNC_HOST / VNC_PORT / VNC_PASSWORD environment variables, so this usually ' +
      'needs no arguments. Prefer configuring the password in the environment: a password ' +
      'passed here is visible in the conversation.',
    inputSchema: {
      host: z.string().optional().describe('Host or IP of the VNC server (default 127.0.0.1).'),
      port: z.number().int().min(1).max(65535).optional().describe('TCP port (default 5900; display :N is 5900+N).'),
      password: z.string().optional().describe('VNC password, if the server asks for one.'),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  },
  async (args) => text(await session.connect(args)),
);

tool(
  'vnc_disconnect',
  {
    title: 'Disconnect from the VNC server',
    description: 'Close the current VNC connection. Later tool calls will reconnect automatically.',
    inputSchema: {},
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  async () => text(session.disconnect() ? 'Disconnected.' : 'Was not connected.'),
);

tool(
  'vnc_status',
  {
    title: 'VNC connection status',
    description:
      'Report whether a desktop is connected, its size, name, the pointer position, and ' +
      'the last clipboard text the desktop pushed (useful after a copy).',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => text(session.status()),
);

// --- looking -----------------------------------------------------------------

tool(
  'vnc_screenshot',
  {
    title: 'Screenshot the desktop',
    description:
      'Capture the current desktop as a PNG. Use scale or maxWidth to trade detail for size ' +
      'on a large desktop; coordinates for the input tools are always in full-size pixels.',
    inputSchema: {
      scale: z.number().min(0.05).max(1).optional().describe('Shrink by this factor, 0.05 to 1 (default 1).'),
      maxWidth: z.number().int().min(64).optional().describe('Shrink further so the image is at most this wide.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ scale, maxWidth }) => {
    const shot = await session.screenshot({ scale, maxWidth });
    const scaled = shot.width !== shot.sourceWidth;
    return {
      content: [
        { type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' },
        {
          type: 'text',
          text: scaled
            ? `Desktop is ${shot.sourceWidth}x${shot.sourceHeight}; this image is ${shot.width}x${shot.height}. ` +
              `Multiply coordinates read off it by ${(shot.sourceWidth / shot.width).toFixed(3)}.`
            : `Desktop is ${shot.sourceWidth}x${shot.sourceHeight} (image is full size).`,
        },
      ],
    };
  },
);

// --- pointer -----------------------------------------------------------------

const x = z.number().int().describe('X in pixels from the left edge of the desktop.');
const y = z.number().int().describe('Y in pixels from the top edge of the desktop.');
const button = z.enum(['left', 'middle', 'right']).optional().describe('Mouse button (default left).');

tool(
  'vnc_move',
  {
    title: 'Move the mouse',
    description: 'Move the pointer without pressing anything — useful for hover states and tooltips.',
    inputSchema: { x, y, settleMs },
    annotations: { readOnlyHint: false },
  },
  async (args) => text(await session.move(args)),
);

tool(
  'vnc_click',
  {
    title: 'Click the mouse',
    description: 'Move the pointer somewhere and click. Set clicks to 2 for a double-click.',
    inputSchema: {
      x,
      y,
      button,
      clicks: z.number().int().min(1).max(3).optional().describe('Number of clicks in quick succession (default 1).'),
      settleMs,
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => text(await session.click(args)),
);

tool(
  'vnc_drag',
  {
    title: 'Drag the mouse',
    description:
      'Press at one point, move to another, and release — for dragging windows, selecting ' +
      'text, or moving a slider.',
    inputSchema: {
      fromX: x,
      fromY: y,
      toX: x,
      toY: y,
      button,
      settleMs,
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => text(await session.drag(args)),
);

tool(
  'vnc_scroll',
  {
    title: 'Scroll the wheel',
    description: 'Scroll the mouse wheel, at the given point or wherever the pointer already is.',
    inputSchema: {
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Scroll direction (default down).'),
      amount: z.number().int().min(1).max(50).optional().describe('Number of wheel clicks (default 3).'),
      x: x.optional(),
      y: y.optional(),
      settleMs,
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => text(await session.scroll(args)),
);

// --- keyboard ----------------------------------------------------------------

tool(
  'vnc_type',
  {
    title: 'Type text',
    description:
      'Type a string into whatever has keyboard focus. Newlines are sent as Return. For ' +
      'shortcuts and non-printing keys use vnc_key instead.',
    inputSchema: {
      text: z.string().describe('The text to type.'),
      delayMs: z
        .number()
        .int()
        .min(0)
        .max(1000)
        .optional()
        .describe('Pause between keystrokes in ms (default 12). Raise it if the app drops characters.'),
      settleMs,
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => text(await session.type(args)),
);

tool(
  'vnc_key',
  {
    title: 'Press a key or shortcut',
    description:
      'Press one key, optionally with modifiers, as "ctrl+c", "alt+F4", "ctrl+shift+t", ' +
      '"Return", "Escape", "Tab", "Up". Modifiers: ctrl, alt, shift, super (also meta/win/cmd). ' +
      'Key names are X11 keysym names, with the common short aliases (enter, esc, pgup, ' +
      'pgdn, del, backspace, space) accepted too.',
    inputSchema: {
      keys: z.string().describe('The key combination, e.g. "ctrl+s".'),
      presses: z.number().int().min(1).max(50).optional().describe('Press it this many times (default 1).'),
      settleMs,
    },
    annotations: { readOnlyHint: false },
  },
  async (args) => text(await session.key(args)),
);

// --- run ---------------------------------------------------------------------

const shutdown = () => {
  session.disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await server.connect(new StdioServerTransport());
console.error('vnc-mcp ready on stdio');
