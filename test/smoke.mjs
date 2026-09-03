/**
 * End-to-end test: build a throwaway VNC desktop in a container, then drive it.
 *
 * Screenshots and input injection are exactly the sort of thing a mocked socket
 * will happily pretend works, so everything here is checked against the real X
 * server: the pointer position comes back from `xdotool`, and typed text comes
 * back from a file the terminal wrote (DECISIONS.md #10).
 *
 * Usage: npm test            (needs docker, or podman aliased to it)
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import path from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

import { VncSession } from '../src/session.js';
import { RfbClient } from '../src/rfb.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const IMAGE = 'vnc-mcp-test:latest';
const PASSWORD = 'sw0rdfish';

const DOCKER = process.env.DOCKER_CLI || (has('docker') ? 'docker' : 'podman');

const containers = [];
let failures = 0;

// --- tiny test harness -------------------------------------------------------

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message.split('\n').join('\n       ')}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  assert(
    actual === expected,
    `${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
  );
}

// --- container plumbing ------------------------------------------------------

function has(command) {
  return spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
}

function docker(args, options = {}) {
  return execFileSync(DOCKER, args, { encoding: 'utf8', ...options }).trim();
}

function buildImage() {
  console.log(`building ${IMAGE} with ${DOCKER}...`);
  execFileSync(DOCKER, ['build', '-q', '-t', IMAGE, HERE], { stdio: ['ignore', 'ignore', 'inherit'] });
}

/** Start a desktop container and return the host port its VNC server is on. */
function startDesktop({ password = '', screen = '1024x768x24' } = {}) {
  const id = docker([
    'run', '-d', '--rm',
    '-e', `VNC_PASSWORD=${password}`,
    '-e', `SCREEN_SIZE=${screen}`,
    '-p', '127.0.0.1::5900',
    IMAGE,
  ]);
  containers.push(id);
  const port = Number(docker(['port', id, '5900']).split(':').pop());
  return { id, port };
}

function stopDesktops() {
  for (const id of containers.splice(0)) {
    spawnSync(DOCKER, ['kill', id], { stdio: 'ignore' });
  }
}

/** Run a command inside the container against its X display. */
function inDesktop(id, command) {
  return docker(['exec', '-e', 'DISPLAY=:0', id, ...command]);
}

async function waitForPort(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise((resolve) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => (socket.destroy(), resolve(true)));
      socket.once('error', () => resolve(false));
    });
    if (open) return;
    if (Date.now() > deadline) throw new Error(`nothing listening on port ${port} after ${timeoutMs}ms`);
    await sleep(200);
  }
}

/** Wait for the desktop's own startup (X, then the terminal) to finish. */
async function waitForDesktop(id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (inDesktop(id, ['xdotool', 'search', '--class', 'xterm']).length > 0) return;
    } catch {
      /* X or the terminal is not up yet */
    }
    if (Date.now() > deadline) throw new Error('the test desktop never started an xterm');
    await sleep(300);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How many pixels differ between two RGBA buffers. */
function pixelsDiffering(a, b) {
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) differing++;
  }
  return differing;
}

// --- the tests ---------------------------------------------------------------

async function testOpenDesktop() {
  const { id, port } = startDesktop();
  await waitForPort(port);
  await waitForDesktop(id);

  const session = new VncSession({});
  try {
    const status = await session.connect({ host: '127.0.0.1', port });

    await test('connects and reads the desktop geometry', () => {
      assertEqual(status.connected, true, 'should be connected');
      assertEqual(status.width, 1024, 'desktop width');
      assertEqual(status.height, 768, 'desktop height');
    });

    let pngBytes = 0;
    await test('screenshots decode as a full-size PNG', async () => {
      const shot = await session.screenshot();
      assertEqual(shot.mimeType, 'image/png', 'default format');
      const png = PNG.sync.read(shot.data);
      assertEqual(png.width, 1024, 'png width');
      assertEqual(png.height, 768, 'png height');
      // A black root window with a terminal on it is not a uniform image.
      const first = png.data.subarray(0, 4);
      assert(
        [...png.data].some((_, i) => i % 4 !== 3 && png.data[i] !== first[i % 4]),
        'the screenshot is a single flat colour, so nothing was decoded',
      );
      pngBytes = shot.data.length;
    });

    await test('screenshots can be JPEG', async () => {
      const shot = await session.screenshot({ format: 'jpeg', quality: 70 });
      assertEqual(shot.mimeType, 'image/jpeg', 'mime type');
      const image = jpeg.decode(shot.data);
      assertEqual(image.width, 1024, 'jpeg width');
      assertEqual(image.height, 768, 'jpeg height');
      // The noise window makes PNG expensive; that is exactly when JPEG earns its keep.
      assert(shot.data.length < pngBytes, `jpeg (${shot.data.length} bytes) should be smaller than png (${pngBytes})`);
    });

    await test('screenshots can be scaled down', async () => {
      const shot = await session.screenshot({ scale: 0.5 });
      assertEqual(shot.width, 512, 'scaled width');
      assertEqual(shot.height, 384, 'scaled height');
      assertEqual(shot.sourceWidth, 1024, 'source width is still full size');
      assertEqual(PNG.sync.read(shot.data).width, 512, 'scaled png width');
    });

    await test('maxWidth caps the screenshot size', async () => {
      const shot = await session.screenshot({ maxWidth: 320 });
      assertEqual(shot.width, 320, 'capped width');
      assertEqual(shot.height, 240, 'capped height keeps the aspect ratio');
    });

    await test('screenshots wait for the screen to go quiet, but not forever', async () => {
      const client = session.client;

      // A still desktop is quiet almost immediately.
      let started = Date.now();
      assertEqual(await client.waitForQuiet(100, 1500), true, 'a still screen should report quiet');
      assert(Date.now() - started < 600, 'a still screen should not take long to report quiet');

      // Simulate a screen that repaints every 40ms: never quiet for 100ms, so
      // the wait must give up at the deadline and say so.
      const churn = setInterval(() => client._notifyUpdate(true), 40);
      try {
        started = Date.now();
        assertEqual(await client.waitForQuiet(100, 500), false, 'a churning screen should report not-quiet');
        const took = Date.now() - started;
        assert(took >= 450 && took < 1000, `should give up around the 500ms deadline, took ${took}ms`);
      } finally {
        clearInterval(churn);
      }

      const shot = await session.screenshot({ quietMs: 0 });
      assertEqual(shot.quiet, true, 'quietMs 0 skips the wait and reports quiet');

      // With the defaults, a churning screen costs about the 500ms cap and no more.
      const churnAgain = setInterval(() => client._notifyUpdate(true), 40);
      try {
        started = Date.now();
        const capped = await session.screenshot();
        const took = Date.now() - started;
        assertEqual(capped.quiet, false, 'the default wait should report the screen was still changing');
        assert(took >= 450 && took < 1000, `default maxWaitMs should be ~500ms, took ${took}ms`);
      } finally {
        clearInterval(churnAgain);
      }
    });

    await test('the pointer lands where it was told to', async () => {
      await session.move({ x: 321, y: 234, settleMs: 100 });
      const location = inDesktop(id, ['xdotool', 'getmouselocation', '--shell']);
      assert(/\bX=321\b/.test(location), `x should be 321, got: ${location}`);
      assert(/\bY=234\b/.test(location), `y should be 234, got: ${location}`);
    });

    await test('clicking moves the pointer and presses a button', async () => {
      await session.click({ x: 150, y: 160, settleMs: 100 });
      const location = inDesktop(id, ['xdotool', 'getmouselocation', '--shell']);
      assert(/\bX=150\b/.test(location), `x should be 150, got: ${location}`);
      assert(/\bY=160\b/.test(location), `y should be 160, got: ${location}`);
    });

    await test('dragging ends at the target', async () => {
      await session.drag({ fromX: 100, fromY: 100, toX: 400, toY: 300, steps: 5, settleMs: 100 });
      const location = inDesktop(id, ['xdotool', 'getmouselocation', '--shell']);
      assert(/\bX=400\b/.test(location), `x should be 400, got: ${location}`);
      assert(/\bY=300\b/.test(location), `y should be 300, got: ${location}`);
    });

    await test('typed text reaches the application, and the screen repaints', async () => {
      // Focus follows the pointer on a bare X server, so aim at the terminal.
      await session.move({ x: 200, y: 200, settleMs: 100 });
      const before = Buffer.from(session.client.framebuffer);

      await session.type({ text: 'hello vnc\n', settleMs: 800 });
      await sleep(500);

      assertEqual(inDesktop(id, ['cat', '/tmp/typed.txt']), 'hello vnc', 'the terminal should have read the typed line');
      const changed = pixelsDiffering(before, session.client.framebuffer);
      assert(changed > 100, `typing should have repainted the screen, but only ${changed} pixels changed`);
    });

    await test('key combinations resolve and send without error', async () => {
      // The terminal is done reading, so this only proves the keysym path is
      // wired up end to end; parseCombo covers the name resolution itself.
      await session.key({ keys: 'ctrl+l', settleMs: 100 });
      await session.key({ keys: 'Escape', presses: 2, settleMs: 100 });
    });

    await test('pixels land in the right colour channels', async () => {
      // A swapped red and blue channel would pass every other test here, so
      // put a known-colour window on the desktop and read it back.
      spawnSync(DOCKER, [
        'exec', '-d', '-e', 'DISPLAY=:0', id,
        'xterm', '-geometry', '24x6+700+600', '-bg', '#0000ff', '-fg', '#0000ff',
      ]);

      const offset = (630 * 1024 + 750) * 4;
      const deadline = Date.now() + 15000;
      let pixel;
      do {
        await sleep(200);
        pixel = session.client.framebuffer.subarray(offset, offset + 3);
      } while (pixel[2] < 200 && Date.now() < deadline);

      const [r, g, b] = pixel;
      assert(b > 200, `blue should be near 255 at the blue window, got rgb(${r}, ${g}, ${b})`);
      assert(r < 40 && g < 40, `red and green should be near 0 there, got rgb(${r}, ${g}, ${b})`);
    });

    await test('an unknown key name is reported clearly', async () => {
      await session
        .key({ keys: 'ctrl+nosuchkey' })
        .then(() => assert(false, 'should have thrown'))
        .catch((error) => assert(/unknown key/.test(error.message), `unexpected message: ${error.message}`));
    });

    await test('disconnect closes the session', () => {
      assertEqual(session.disconnect(), true, 'first disconnect closes');
      assertEqual(session.disconnect(), false, 'second disconnect is a no-op');
    });
  } finally {
    session.disconnect();
  }
}

/**
 * Every encoding noVNC decodes for us, checked against a Raw baseline of the
 * same static desktop. The server honours the client's preference order, so
 * offering one encoding at a time forces it; `stats.rects` then proves the
 * server actually used it rather than quietly falling back to Raw.
 */
async function testEncodings() {
  const { id, port } = startDesktop();
  await waitForPort(port);
  await waitForDesktop(id);
  await sleep(1500); // let the desktop finish painting so every capture sees the same pixels

  async function capture(options) {
    const client = await RfbClient.connect({ host: '127.0.0.1', port, timeoutMs: 15000, ...options });
    try {
      // The first update is the whole screen; a second one flushes anything
      // the server split off (some encoders send large rects in pieces).
      await client.waitForUpdate(10000);
      await client.waitForUpdate(300);
      return {
        pixels: client.fb.snapshot(),
        stats: client.stats,
        bytes: client.stats.bytesReceived,
        imageRects: client.fb.imageRects,
      };
    } finally {
      client.close();
    }
  }

  const baseline = await capture({ encodings: ['raw'] });
  await test('Raw baseline is a real picture', () => {
    assert(baseline.stats.rects.Raw > 0, `expected Raw rectangles, got ${JSON.stringify(baseline.stats.rects)}`);
    const lit = pixelsDiffering(baseline.pixels, Buffer.alloc(baseline.pixels.length));
    assert(lit > 10000, `only ${lit} non-black pixels; the noise window should contribute 65536 on its own`);
  });

  for (const [name, label] of [
    ['tight', 'Tight'],
    ['zrle', 'ZRLE'],
    ['hextile', 'Hextile'],
    ['rre', 'RRE'],
    ['zlib', 'Zlib'],
  ]) {
    await test(`${label} decodes to the same pixels as Raw`, async () => {
      const got = await capture({ encodings: [name] });
      assert(
        got.stats.rects[label] > 0,
        `the server never sent a ${label} rectangle; it sent ${JSON.stringify(got.stats.rects)}`,
      );
      const differing = pixelsDiffering(baseline.pixels, got.pixels);
      // A handful of pixels may legitimately differ if the desktop repainted
      // something between captures (the pointer, a cursor blink).
      assert(differing < 200, `${differing} pixels differ from the Raw baseline`);
      console.log(`       ${label}: ${got.bytes.toLocaleString()} bytes on the wire vs ${baseline.bytes.toLocaleString()} for Raw`);
    });
  }

  await test('Tight uses JPEG for photographic areas when a quality level is set', async () => {
    const got = await capture({ encodings: ['tight'], quality: 6 });
    assert(got.stats.rects.Tight > 0, `expected Tight rectangles, got ${JSON.stringify(got.stats.rects)}`);
    assert(got.imageRects > 0, 'no JPEG rectangles arrived, so the lossy path was never exercised');
    // Lossy, so no exact match — but the noise window must still look like
    // noise rather than a blank or a smear, and the rest must still match.
    const noiseOffset = (100 * 1024 + 750) * 4;
    const noise = got.pixels.subarray(noiseOffset, noiseOffset + 64 * 4);
    const distinct = new Set();
    for (let i = 0; i < noise.length; i += 4) distinct.add(noise[i] * 65536 + noise[i + 1] * 256 + noise[i + 2]);
    assert(distinct.size > 20, `the JPEG-decoded noise has only ${distinct.size} colours across 64 pixels`);
  });
}

/** A desktop wider than the default cap, to see the cap actually apply. */
async function testWideDesktop() {
  const { id, port } = startDesktop({ screen: '1600x900x24' });
  await waitForPort(port);
  await waitForDesktop(id);

  const session = new VncSession({});
  try {
    const status = await session.connect({ host: '127.0.0.1', port });
    await test('a 1600px desktop is captured at 1280px by default', async () => {
      assertEqual(status.width, 1600, 'desktop width');
      const shot = await session.screenshot();
      assertEqual(shot.width, 1280, 'capped width');
      assertEqual(shot.height, 720, 'capped height keeps the aspect ratio');
      assertEqual(shot.sourceWidth, 1600, 'source width is reported');
      assertEqual(PNG.sync.read(shot.data).width, 1280, 'the encoded image is the capped size');
    });

    await test('maxWidth 0 gives the full-size image', async () => {
      const shot = await session.screenshot({ maxWidth: 0 });
      assertEqual(shot.width, 1600, 'full width');
      assertEqual(shot.height, 900, 'full height');
    });
  } finally {
    session.disconnect();
  }
}

async function testPasswordDesktop() {
  const { id, port } = startDesktop({ password: PASSWORD });
  await waitForPort(port);
  await waitForDesktop(id);

  await test('VNC authentication succeeds with the right password', async () => {
    const session = new VncSession({});
    try {
      const status = await session.connect({ host: '127.0.0.1', port, password: PASSWORD });
      assertEqual(status.connected, true, 'should be connected');
      assertEqual(status.width, 1024, 'desktop width');
    } finally {
      session.disconnect();
    }
  });

  await test('VNC authentication fails loudly with the wrong password', async () => {
    await RfbClient.connect({ host: '127.0.0.1', port, password: 'wrong-password', timeoutMs: 10000 })
      .then((client) => {
        client.close();
        assert(false, 'connecting with the wrong password should have failed');
      })
      .catch((error) => {
        assert(
          /authentication failed/i.test(error.message),
          `expected an authentication failure, got: ${error.message}`,
        );
      });
  });

  await test('a missing password is reported as such', async () => {
    await RfbClient.connect({ host: '127.0.0.1', port, timeoutMs: 10000 })
      .then((client) => {
        client.close();
        assert(false, 'connecting without a password should have failed');
      })
      .catch((error) => {
        assert(/requires a password/.test(error.message), `unexpected message: ${error.message}`);
      });
  });
}

/** Drive the actual MCP server over stdio, the way a client would. */
async function testMcpServer() {
  const { id, port } = startDesktop();
  await waitForPort(port);
  await waitForDesktop(id);

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  const client = new Client({ name: 'vnc-mcp-smoke', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(HERE, '..', 'src', 'index.js')],
    env: { ...process.env, VNC_HOST: '127.0.0.1', VNC_PORT: String(port) },
    stderr: 'ignore',
  });

  try {
    await client.connect(transport);

    await test('the server advertises its tools', async () => {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assertEqual(
        names.join(','),
        'vnc_click,vnc_connect,vnc_disconnect,vnc_drag,vnc_key,vnc_move,vnc_screenshot,vnc_scroll,vnc_status,vnc_type',
        'tool list',
      );
    });

    await test('vnc_screenshot returns a PNG image, connecting on demand', async () => {
      const result = await client.callTool({ name: 'vnc_screenshot', arguments: { scale: 0.5 } });
      assert(!result.isError, `tool reported an error: ${JSON.stringify(result.content)}`);
      const image = result.content.find((part) => part.type === 'image');
      assert(image, 'no image in the response');
      assertEqual(image.mimeType, 'image/png', 'mime type');
      const png = PNG.sync.read(Buffer.from(image.data, 'base64'));
      assertEqual(png.width, 512, 'png width');
      assert(
        result.content.some((part) => part.type === 'text' && part.text.includes('1024x768')),
        'the response should say what the full desktop size is',
      );
    });

    await test('vnc_screenshot can return JPEG through the tool layer', async () => {
      const result = await client.callTool({
        name: 'vnc_screenshot',
        arguments: { format: 'jpeg', maxWidth: 400, quietMs: 0 },
      });
      assert(!result.isError, `tool reported an error: ${JSON.stringify(result.content)}`);
      const image = result.content.find((part) => part.type === 'image');
      assertEqual(image.mimeType, 'image/jpeg', 'mime type');
      assertEqual(jpeg.decode(Buffer.from(image.data, 'base64')).width, 400, 'jpeg width');
    });

    await test('vnc_click reaches the desktop through the tool layer', async () => {
      const result = await client.callTool({ name: 'vnc_click', arguments: { x: 640, y: 480, settleMs: 100 } });
      assert(!result.isError, `tool reported an error: ${JSON.stringify(result.content)}`);
      const location = inDesktop(id, ['xdotool', 'getmouselocation', '--shell']);
      assert(/\bX=640\b/.test(location), `x should be 640, got: ${location}`);
    });

    await test('vnc_status describes the connection', async () => {
      const result = await client.callTool({ name: 'vnc_status', arguments: {} });
      const status = JSON.parse(result.content[0].text);
      assertEqual(status.connected, true, 'connected');
      assertEqual(status.width, 1024, 'width');
    });

    await test('a bad argument comes back as a tool error, not a crash', async () => {
      const result = await client.callTool({ name: 'vnc_key', arguments: { keys: 'ctrl+nosuchkey' } });
      assertEqual(result.isError, true, 'should be a tool error');
      assert(/unknown key/.test(result.content[0].text), `unexpected message: ${result.content[0].text}`);
    });
  } finally {
    await client.close().catch(() => {});
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  if (!has(DOCKER)) {
    console.error(`${DOCKER} is not installed; this test needs a container runtime.`);
    process.exit(1);
  }
  buildImage();

  try {
    console.log('\ndesktop without a password');
    await testOpenDesktop();

    console.log('\nencodings (decoded by noVNC)');
    await testEncodings();

    console.log('\nwide desktop');
    await testWideDesktop();

    console.log('\ndesktop with a password');
    await testPasswordDesktop();

    console.log('\nMCP server over stdio');
    await testMcpServer();
  } finally {
    stopDesktops();
  }

  console.log(failures === 0 ? '\nall tests passed' : `\n${failures} test(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

process.on('SIGINT', () => (stopDesktops(), process.exit(130)));

await main();
