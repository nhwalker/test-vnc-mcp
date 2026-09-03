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
import { analyzeImage } from './analyze.js';

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
      'Capture the current desktop. Waits briefly for the screen to stop changing first, so ' +
      'it does not catch a half-drawn window. Images wider than 1280px are shrunk to fit by ' +
      'default; the reply says the factor to multiply coordinates by. Use format "jpeg" for ' +
      'photo- or video-heavy screens, where PNG gets large. Coordinates for the input tools ' +
      'are always in full-size desktop pixels.',
    inputSchema: {
      maxWidth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Shrink so the image is at most this wide (default 1280). 0 means full size.'),
      scale: z.number().min(0.05).max(1).optional().describe('Shrink by this factor, 0.05 to 1 (default 1).'),
      format: z.enum(['png', 'jpeg']).optional().describe('png (lossless, default) or jpeg (smaller).'),
      quality: z.number().int().min(1).max(100).optional().describe('JPEG quality, 1-100 (default 80).'),
      quietMs: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe('Capture once the screen has been still for this long, in ms (default 100; 0 captures at once).'),
      maxWaitMs: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe('Give up waiting for stillness after this long and capture anyway (default 500).'),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    const shot = await session.screenshot(args);
    const scaled = shot.width !== shot.sourceWidth;
    const notes = [
      scaled
        ? `Desktop is ${shot.sourceWidth}x${shot.sourceHeight}; this image is ${shot.width}x${shot.height}. ` +
          `Multiply coordinates read off it by ${(shot.sourceWidth / shot.width).toFixed(3)}.`
        : `Desktop is ${shot.sourceWidth}x${shot.sourceHeight} (image is full size).`,
      shot.quiet ? '' : 'The screen was still changing when the capture was taken.',
    ];
    return {
      content: [
        { type: 'image', data: shot.data.toString('base64'), mimeType: shot.mimeType },
        { type: 'text', text: notes.filter(Boolean).join(' ') },
      ],
    };
  },
);

tool(
  'vnc_describe',
  {
    title: 'Describe the desktop as text',
    description:
      'Describe the current desktop as data instead of pixels: its regions (windows, panels, ' +
      'bars, buttons — flat-coloured areas, nested by containment), every line of text with ' +
      'its bounding box and confidence, and which parts of the screen changed since you last ' +
      'looked. All coordinates are full-size desktop pixels, ready for vnc_click. Use it to ' +
      'find something to click on without reading a screenshot, or alongside one to get exact ' +
      'coordinates. Takes about a second the first time a screen is seen; cached until it changes. ' +
      'Text on photos or gradients is still read but belongs to no region.',
    inputSchema: {
      since: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Report changes since this desktop update number (from an earlier reply). Default: since your last screenshot or description.'),
      regions: z.boolean().optional().describe('Find regions (default true).'),
      text: z.boolean().optional().describe('Read text (default true). Regions alone are fast.'),
      words: z.boolean().optional().describe('Also return a box per word, not just per line (default false; several times more output).'),
      quietMs: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe('Describe once the screen has been still for this long, in ms (default 100; 0 describes at once).'),
      maxWaitMs: z
        .number()
        .int()
        .min(0)
        .max(30000)
        .optional()
        .describe('Give up waiting for stillness after this long and describe anyway (default 500).'),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => text(await session.describe(args)),
);

tool(
  'vnc_describe_image',
  {
    title: 'Describe an image you already have',
    description:
      'The same analysis as vnc_describe — regions, text with bounding boxes, hints — over a ' +
      'PNG or JPEG you supply, such as a screenshot taken earlier, rather than the live ' +
      'desktop. Needs no VNC connection. Pass bbox to analyse only part of the image; results ' +
      'stay in whole-image coordinates. If the image is a shrunk screenshot, pass the factor ' +
      'it reported as scale and every coordinate comes back in desktop pixels.',
    inputSchema: {
      image: z.string().min(1).describe('The image as base64 (a data: URL is accepted too). PNG or JPEG.'),
      mimeType: z.enum(['image/png', 'image/jpeg']).optional().describe('Optional; the bytes are checked either way.'),
      bbox: z
        .object({
          x: z.number().int().min(0),
          y: z.number().int().min(0),
          width: z.number().int().min(1),
          height: z.number().int().min(1),
        })
        .optional()
        .describe('Analyse only this rectangle of the image, in image pixels.'),
      scale: z
        .number()
        .positive()
        .max(16)
        .optional()
        .describe('Multiply every returned coordinate by this (default 1), e.g. the factor a scaled vnc_screenshot reported.'),
      regions: z.boolean().optional().describe('Find regions (default true).'),
      text: z.boolean().optional().describe('Read text (default true).'),
      words: z.boolean().optional().describe('Also return a box per word (default false).'),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => text(await analyzeImage(session.ocr, args)),
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

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // The OCR worker thread would otherwise keep the process alive after the
  // client has gone; give it a moment to stop cleanly, then leave regardless.
  const bail = setTimeout(() => process.exit(0), 2000);
  session.close().finally(() => {
    clearTimeout(bail);
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
// The client closed our stdin: it is done with us. The SDK's stdio transport
// does not watch for end-of-file itself, so listen for it here.
process.stdin.on('end', shutdown);
server.server.onclose = shutdown;

await server.connect(new StdioServerTransport());
console.error('vnc-mcp ready on stdio');
