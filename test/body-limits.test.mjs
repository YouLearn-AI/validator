// JSON body limits (ops I-629): POST /render-screenshot takes inline HTML up to 2 MB; every other route,
// and every other method on that path, keeps 256 KB. The shared 256 KB parser used to read
// /render-screenshot's body first, so inline HTML over 256 KB got 413. No browser: the renderer is a stub.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../app.mjs';
import { renderAuth } from '../render-auth.mjs';

const KEY = 'test-body-limit-key-0123456789';
const KB = 1024;
const MB = 1024 * KB;
const quiet = { info() {}, warn() {}, error() {}, log() {} };

/** A JSON body of exactly `bytes` bytes: {"<field>":"xxx…"}. */
function bodyOf(bytes, field) {
  const wrapper = JSON.stringify({ [field]: '' }).length;
  const body = JSON.stringify({ [field]: 'x'.repeat(bytes - wrapper) });
  assert.equal(Buffer.byteLength(body), bytes);
  return body;
}

describe('JSON body limits', () => {
  const rendered = [];
  let server;
  let base;

  before(async () => {
    const app = createApp({
      renderScreenshot: async (options) => {
        rendered.push(options);
        return 'AA==';
      },
      auth: renderAuth({ key: KEY, required: true, log: quiet }),
      validateAuth: renderAuth({ key: KEY, required: true, log: quiet }),
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  async function send(path, body, { method = 'POST', key = KEY } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (key) headers['x-api-key'] = key;
    const response = await fetch(`${base}${path}`, { method, headers, body });
    return { status: response.status, json: await response.json() };
  }

  for (const [label, bytes] of [['300 KB', 300 * KB], ['exactly 2 MB', 2 * MB]]) {
    test(`/render-screenshot renders ${label} of inline HTML`, async () => {
      const before = rendered.length;
      const body = bodyOf(bytes, 'html');
      const { status, json } = await send('/render-screenshot', body);
      assert.equal(status, 200);
      assert.deepEqual(json, { success: true, screenshot: 'AA==' });
      assert.equal(rendered.length, before + 1);
      assert.equal(rendered.at(-1).html, JSON.parse(body).html);
    });
  }

  test('/render-screenshot refuses a body over 2 MB with 413, before the renderer', async () => {
    const before = rendered.length;
    const { status, json } = await send('/render-screenshot', bodyOf(2 * MB + 1, 'html'));
    assert.equal(status, 413);
    assert.equal(json.code, 'body_too_large');
    assert.equal(rendered.length, before);
  });

  test('/render-screenshot answers malformed JSON under 2 MB with 400, as any body within its limit', async () => {
    const before = rendered.length;
    const { status, json } = await send('/render-screenshot', `{"html": "${'x'.repeat(300 * KB)}`);
    assert.equal(status, 400);
    assert.equal(json.code, 'malformed_json');
    assert.equal(rendered.length, before);
  });

  test('/render-screenshot checks the key before it reads a large body', async () => {
    const { status, json } = await send('/render-screenshot', bodyOf(3 * MB, 'html'), { key: '' });
    assert.equal(status, 401);
    assert.equal(json.error, 'Missing API key');
  });

  test('a path spelled in another case or with a trailing slash gets the same 2 MB limit', async () => {
    for (const path of ['/Render-Screenshot', '/render-screenshot/']) {
      assert.equal((await send(path, bodyOf(300 * KB, 'html'))).status, 200, path);
      assert.equal((await send(path, bodyOf(2 * MB + 1, 'html'))).status, 413, path);
    }
  });

  for (const [method, path, field] of [
    ['POST', '/validate/latex', 'text'],
    ['POST', '/validate/mermaid', 'diagram'],
    ['POST', '/health', 'html'],
    ['POST', '/not-a-route', 'html'],
    ['PUT', '/render-screenshot', 'html'],
  ]) {
    test(`${method} ${path} still refuses a body over 256 KB with 413`, async () => {
      const before = rendered.length;
      const { status, json } = await send(path, bodyOf(256 * KB + 1, field), { method });
      assert.equal(status, 413);
      assert.equal(json.code, 'body_too_large');
      assert.equal(rendered.length, before);
    });
  }

  test('a body of exactly 256 KB still reaches the default routes', async () => {
    // A 404 (not 413) shows the default parser took it; the validate routes take the same parser.
    const { status } = await send('/not-a-route', bodyOf(256 * KB, 'html'));
    assert.equal(status, 404);
  });
});
