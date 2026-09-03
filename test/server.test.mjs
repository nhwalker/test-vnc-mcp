/**
 * The MCP server itself, over stdio: the tool list, a tool call that needs no
 * desktop (vnc_describe_image over the fixture), and a clean exit when the
 * client closes the pipe. Everything else about the server needs a VNC
 * desktop and lives in the end-to-end test.
 *
 * Run with: node --test test/server.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, '..', 'src', 'index.js');
const FIXTURE = path.join(HERE, 'fixtures', 'desktop.png');

/** Start the server and speak JSON-RPC to it over stdio. */
function startServer() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  let nextId = 1;
  const exited = new Promise((resolve) => child.on('exit', resolve));
  return {
    child,
    exited,
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, resolve);
        setTimeout(() => reject(new Error(`${method} did not answer in time`)), 60000).unref();
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

test('lists both describe tools, analyses a supplied image, and exits when stdin closes', async () => {
  const server = startServer();
  try {
    const init = await server.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'server.test', version: '0' },
    });
    assert.equal(init.result.serverInfo.name, 'vnc-mcp');
    server.notify('notifications/initialized');

    const list = await server.request('tools/list', {});
    const names = list.result.tools.map((t) => t.name);
    assert.ok(names.includes('vnc_describe'), names);
    assert.ok(names.includes('vnc_describe_image'), names);
    assert.ok(names.includes('vnc_screenshot'), names);
    const schema = list.result.tools.find((t) => t.name === 'vnc_describe_image').inputSchema;
    assert.deepEqual(schema.required, ['image']);
    assert.ok(schema.properties.bbox && schema.properties.scale, 'bbox and scale are in the schema');

    const call = await server.request('tools/call', {
      name: 'vnc_describe_image',
      arguments: {
        image: fs.readFileSync(FIXTURE).toString('base64'),
        bbox: { x: 670, y: 110, width: 320, height: 240 },
        scale: 2,
      },
    });
    assert.equal(call.result.isError, undefined, JSON.stringify(call.result).slice(0, 500));
    assert.equal(call.result.content[0].type, 'text');
    const analysis = JSON.parse(call.result.content[0].text);
    assert.deepEqual(analysis.image, { width: 1024, height: 768, mimeType: 'image/png', bbox: { x: 670, y: 110, width: 320, height: 240 }, scale: 2 });
    const cancel = analysis.regions.find((r) => r.text === 'Cancel');
    assert.deepEqual(cancel.bbox, [1428, 596, 148, 60], 'offset by the box, then doubled');
    assert.ok(analysis.text.some((l) => l.text === 'Save changes?'));

    // A bad image is a tool error, not a dead server.
    const bad = await server.request('tools/call', { name: 'vnc_describe_image', arguments: { image: 'aGVsbG8=' } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /neither PNG nor JPEG/);

    // The OCR worker is running now; closing stdin must still end the process.
    const closedAt = Date.now();
    server.child.stdin.end();
    const code = await Promise.race([server.exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
    assert.equal(code, 0, `expected a clean exit, got ${code} after ${Date.now() - closedAt}ms`);
  } finally {
    if (server.child.exitCode === null) server.child.kill();
  }
});
