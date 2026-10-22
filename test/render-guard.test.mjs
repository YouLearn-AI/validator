// The render guard as probes (ops I-602): the shared key, the scheme check, and
// private, loopback, link-local and metadata addresses refused for the page, its
// subresources, its redirects and its WebSockets. Runs a real headless Chromium.
//
// Test network: "public.test" stands for a public site. Its lookup answers a
// public address (93.184.216.34), and connections to that address go to a local
// server. Every other name and address is resolved and connected for real, so
// 127.0.0.1 reaches the local "secret" server if the guard lets it through.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { addressRefusal, checkRequestUrl, checkUrl, publicAddresses, UrlRefused } from '../egress-guard.mjs';
import { GuardedBrowser } from '../guarded-browser.mjs';
import { createScreenshotRenderer } from '../screenshot-renderer.mjs';
import { keysMatch, renderAuth } from '../render-auth.mjs';
import { createApp } from '../app.mjs';

const FAKE_PUBLIC = '93.184.216.34';
const FAKE_PUBLIC_V6 = '2606:4700::1111';
const KEY = 'test-render-key-0123456789';

function collectingLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, log: { info: push, warn: push, error: push, log: push } };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** JPEG width and height from its SOF marker. */
function jpegSize(buffer) {
  let i = 2;
  while (i < buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

// --- the address check, no browser -----------------------------------------

const REFUSED = {
  '127.0.0.1': 'loopback',
  '127.255.0.9': 'loopback',
  '::1': 'loopback',
  '10.0.0.1': 'private',
  '10.255.255.254': 'private',
  '172.16.5.4': 'private',
  '172.31.255.255': 'private',
  '192.168.1.1': 'private',
  '169.254.169.254': 'metadata',
  'fd00:ec2::254': 'metadata',
  '169.254.1.1': 'link_local',
  'fe80::1': 'link_local',
  '100.64.0.1': 'cgnat',
  '0.0.0.0': 'unspecified',
  '0.1.2.3': 'unspecified',
  '::': 'unspecified',
  '224.0.0.1': 'multicast',
  'ff02::1': 'multicast',
  'fc00::1': 'private',
  'fd12:3456::1': 'private',
  '240.0.0.1': 'reserved',
  '255.255.255.255': 'broadcast',
  '198.18.0.1': 'reserved',
  '192.0.2.1': 'reserved',
  '2001:db8::1': 'reserved',
  '::ffff:127.0.0.1': 'loopback',
  '::ffff:10.1.2.3': 'private',
  '::ffff:169.254.169.254': 'metadata',
  '::127.0.0.1': 'loopback',
  '64:ff9b::a9fe:a9fe': 'nat64',
  '64:ff9b::7f00:1': 'nat64',
  '2002:7f00:1::1': 'embedded_ipv4',
  '2001::1': 'embedded_ipv4',
  '::a9fe:a9fe': 'embedded_ipv4',
  '::7f00:1': 'embedded_ipv4',
  '::a00:1': 'embedded_ipv4',
  'fec0::1': 'not_global',
  'fd20:ce::254': 'private',
};

describe('address check', () => {
  for (const [address, reason] of Object.entries(REFUSED)) {
    test(`${address} is refused (${reason})`, async () => {
      assert.equal(addressRefusal(address), reason);
      const { lines, log } = collectingLog();
      await assert.rejects(
        publicAddresses('evil.test', { lookup: async () => [{ address, family: address.includes(':') ? 6 : 4 }], log }),
        (e) => e instanceof UrlRefused && e.reason === reason,
      );
      assert.deepEqual(lines, [`[EGRESS_REFUSED] reason=${reason} host=evil.test`]);
    });
  }

  for (const address of ['8.8.8.8', '52.217.160.9', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
    test(`${address} passes`, () => assert.equal(addressRefusal(address), null));
  }

  test('a name with one private address among public ones is refused', async () => {
    const lookup = async () => [{ address: '52.217.160.9', family: 4 }, { address: '10.0.0.7', family: 4 }];
    await assert.rejects(publicAddresses('mixed.test', { lookup, log: collectingLog().log }), { reason: 'private' });
  });

  test('metadata and localhost names are refused without a lookup', async () => {
    const lookup = async () => assert.fail('no lookup expected');
    const { log } = collectingLog();
    for (const [host, reason] of [['metadata.google.internal', 'metadata'], ['metadata', 'metadata'], ['foo.internal', 'metadata'], ['localhost', 'loopback'], ['a.localhost.', 'loopback']]) {
      await assert.rejects(publicAddresses(host, { lookup, log }), { reason });
    }
  });

  test('numeric host forms are judged by the address they reach', async () => {
    const { log } = collectingLog();
    for (const url of ['http://2130706433/', 'http://127.1/', 'http://0x7f.1/', 'http://[::1]/']) {
      await assert.rejects(checkUrl(url, { log }), { reason: 'loopback' }, url);
    }
  });

  test('only http(s) URLs pass the scheme check', () => {
    const { log } = collectingLog();
    for (const url of ['file:///etc/passwd', 'data:text/html,hi', 'chrome://version', 'ftp://example.com/', 'javascript:alert(1)', 'about:blank', '/etc/passwd', 'gopher://x/']) {
      assert.throws(() => checkRequestUrl(url, { log }), UrlRefused, url);
    }
    assert.throws(() => checkRequestUrl('http://user:pass@example.com/', { log }), { reason: 'credentials' });
    assert.equal(checkRequestUrl('HTTPS://example.com/a?b=c', { log }).protocol, 'https:');
  });
});

// --- the shared key --------------------------------------------------------

describe('render key', () => {
  test('keysMatch compares any lengths', () => {
    assert.equal(keysMatch('abc', 'abc'), true);
    assert.equal(keysMatch('abc', 'abd'), false);
    assert.equal(keysMatch('abc', 'abcd'), false);
    assert.equal(keysMatch('', 'abc'), false);
  });
});

// --- the endpoint, with a real browser ------------------------------------

describe('/render-screenshot', { timeout: 120_000 }, () => {
  const secretHits = [];
  const originHits = [];
  let secretPort;
  let originPort;
  let secret;
  let origin;
  let bad;
  let badPort;
  let guardLog;
  let browser;
  let tmpDir;
  const apps = [];

  const lookup = async (host) => {
    if (host === 'public.test' || host === 'bad.test') return [{ address: FAKE_PUBLIC, family: 4 }];
    // A public IPv6 address that does not answer here, then a working one.
    if (host === 'dual.test') return [{ address: FAKE_PUBLIC_V6, family: 6 }, { address: FAKE_PUBLIC, family: 4 }];
    if (host === 'rebind.test') return [{ address: '127.0.0.1', family: 4 }];
    return dns.lookup(host, { all: true, verbatim: true });
  };
  // Connections to the fake public names go to local servers. The socket
  // reports the fake public address it stands for, so the guard's own checks
  // (pinned lookup, peer address) run unchanged.
  const connect = (options) => {
    const local = { 'public.test': originPort, 'dual.test': originPort, 'bad.test': badPort }[options.host];
    if (local === undefined) return net.connect(options);
    const toLocal = { [FAKE_PUBLIC]: '127.0.0.1', [FAKE_PUBLIC_V6]: '::1' };
    const socket = net.connect({
      ...options,
      port: local,
      lookup: (hostname, opts, callback) => options.lookup(hostname, opts, (error, records, family) => {
        if (error) return callback(error);
        if (Array.isArray(records)) return callback(null, records.map((r) => ({ ...r, address: toLocal[r.address] })));
        return callback(null, toLocal[records], family);
      }),
    });
    Object.defineProperty(socket, 'remoteAddress', { get: () => FAKE_PUBLIC });
    return socket;
  };

  async function startApp({ key = KEY, required = false } = {}) {
    const { log } = collectingLog();
    const app = createApp({
      renderScreenshot: createScreenshotRenderer(browser, { checkOptions: { lookup, log: guardLog.log } }),
      auth: renderAuth({ key, required, log }),
    });
    const server = http.createServer(app);
    const port = await listen(server);
    apps.push(server);
    return `http://127.0.0.1:${port}`;
  }

  async function post(base, body, headers = {}) {
    const response = await fetch(`${base}/render-screenshot`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  }

  before(async () => {
    secret = http.createServer((req, res) => {
      secretHits.push(req.url);
      res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>SECRET</h1>');
    });
    secret.on('upgrade', (req, socket) => {
      secretHits.push(`upgrade ${req.url}`);
      socket.destroy();
    });
    secretPort = await listen(secret);
    const s = `127.0.0.1:${secretPort}`;
    origin = http.createServer((req, res) => {
      originHits.push(req.url);
      const redirects = {
        '/redirect-loopback': `http://${s}/via-redirect`,
        '/redirect-metadata': 'http://169.254.169.254/computeMetadata/v1/',
        '/redirect-private': 'http://10.0.0.1/',
        '/redirect-name': `http://localhost:${secretPort}/via-name`,
      };
      if (redirects[req.url]) return res.writeHead(302, { location: redirects[req.url] }).end();
      if (req.url === '/green.svg') {
        return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#0f0"/></svg>');
      }
      if (req.url === '/subresources') {
        return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><body>
          <img src="http://${s}/img">
          <img src="http://169.254.169.254/computeMetadata/v1/img">
          <iframe src="http://10.0.0.1/frame"></iframe>
          <iframe src="http://${s}/frame"></iframe>
          <link rel="stylesheet" href="https://${s}/style.css">
          <img src="http://public.test:${originPort}/green.svg">
          <script>
            fetch('http://${s}/fetch').catch(() => {});
            fetch('http://rebind.test:${secretPort}/rebind').catch(() => {});
            try { new WebSocket('ws://${s}/ws'); } catch (e) {}
            try { new WebSocket('wss://${s}/wss'); } catch (e) {}
            navigator.sendBeacon && navigator.sendBeacon('http://${s}/beacon', 'x');
          </script></body>`);
      }
      return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><body style="background:#0a0"><h1>public page</h1></body>');
    });
    originPort = await listen(origin);
    // An upstream that answers a status Node's response writer refuses.
    bad = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => socket.end('HTTP/1.1 099 Bad\r\nContent-Length: 0\r\n\r\n'));
    });
    badPort = await listen(bad);
    guardLog = collectingLog();
    browser = new GuardedBrowser({ guard: { lookup, connect }, log: guardLog.log });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-guard-'));
  });

  after(async () => {
    await browser.close();
    for (const server of apps) server.close();
    secret.close();
    origin.close();
    bad.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('a missing key is refused once the key is required', async () => {
    const base = await startApp({ required: true });
    const { status, json } = await post(base, { html: '<p>hi</p>' });
    assert.equal(status, 401);
    assert.equal(json.error, 'Missing API key');
  });

  test('a wrong key is refused, required or not', async () => {
    for (const required of [true, false]) {
      const base = await startApp({ required });
      const { status, json } = await post(base, { html: '<p>hi</p>' }, { 'x-api-key': 'wrong' });
      assert.equal(status, 401, `required=${required}`);
      assert.equal(json.error, 'Invalid API key');
    }
  });

  test('required with no key configured refuses every render', async () => {
    const base = await startApp({ key: '', required: true });
    assert.equal((await post(base, { html: '<p>hi</p>' }, { 'x-api-key': KEY })).status, 503);
  });

  test('the right key renders; no key still renders while the key is optional', async () => {
    const required = await startApp({ required: true });
    const withKey = await post(required, { html: '<p>hi</p>', width: 1200, height: 630 }, { 'x-api-key': KEY });
    assert.equal(withKey.status, 200);
    assert.deepEqual(jpegSize(Buffer.from(withKey.json.screenshot, 'base64')), { width: 1200, height: 630 });
    const optional = await startApp({ required: false });
    assert.equal((await post(optional, { html: '<p>hi</p>' })).status, 200);
  });

  test('the key is checked before the body is read', async () => {
    const base = await startApp({ required: true });
    const response = await fetch(`${base}/render-screenshot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    assert.equal(response.status, 401);
  });

  test('page URLs that are not public http(s) are refused with a 400', async () => {
    const base = await startApp();
    const before = secretHits.length;
    for (const url of [
      'file:///etc/passwd',
      `http://127.0.0.1:${secretPort}/page`,
      `http://localhost:${secretPort}/page`,
      'http://10.0.0.1/',
      'http://10.1.2.3:8080/admin',
      'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
      'http://metadata.google.internal/computeMetadata/v1/',
      `http://rebind.test:${secretPort}/page`,
      'data:text/html,<h1>x</h1>',
      'chrome://version',
    ]) {
      const { status, json } = await post(base, { url }, { 'x-api-key': KEY });
      assert.equal(status, 400, url);
      assert.match(json.error, /URL refused/, url);
    }
    assert.equal(secretHits.length, before);
  });

  test('an upstream status Node cannot forward gives a 502, not a crash', async () => {
    const base = await startApp();
    const first = await post(base, { url: `http://bad.test:${badPort}/` }, { 'x-api-key': KEY });
    assert.equal(first.status, 200);
    // The proxy and the service are still up.
    const next = await post(base, { url: `http://public.test:${originPort}/` }, { 'x-api-key': KEY });
    assert.equal(next.status, 200);
  });

  test('the next checked address is tried when the first does not answer', async () => {
    const base = await startApp();
    const before = originHits.filter((u) => u === '/dual').length;
    const { status } = await post(base, { url: `http://dual.test:${originPort}/dual` }, { 'x-api-key': KEY });
    assert.equal(status, 200);
    assert.equal(originHits.filter((u) => u === '/dual').length, before + 1);
  });

  test('a public page still renders', async () => {
    const base = await startApp();
    const { status, json } = await post(base, { url: `http://public.test:${originPort}/`, width: 1200, height: 630 }, { 'x-api-key': KEY });
    assert.equal(status, 200);
    assert.deepEqual(jpegSize(Buffer.from(json.screenshot, 'base64')), { width: 1200, height: 630 });
    assert.ok(originHits.includes('/'));
  });

  test('a redirect to a private or metadata address is refused', async () => {
    const base = await startApp();
    const before = secretHits.length;
    const refusedBefore = guardLog.lines.length;
    for (const hop of ['/redirect-loopback', '/redirect-metadata', '/redirect-private', '/redirect-name']) {
      await post(base, { url: `http://public.test:${originPort}${hop}` }, { 'x-api-key': KEY });
      assert.ok(originHits.includes(hop), hop);
    }
    assert.equal(secretHits.length, before, `secret server reached: ${secretHits.slice(before)}`);
    const refused = guardLog.lines.slice(refusedBefore).join('\n');
    for (const reason of ['loopback', 'metadata', 'private']) assert.match(refused, new RegExp(`reason=${reason}`));
  });

  test('subresources, fetches, beacons and WebSockets to private addresses are refused', async () => {
    const base = await startApp();
    const before = secretHits.length;
    const refusedBefore = guardLog.lines.length;
    const greenBefore = originHits.filter((u) => u === '/green.svg').length;
    const { status } = await post(base, { url: `http://public.test:${originPort}/subresources` }, { 'x-api-key': KEY });
    assert.equal(status, 200);
    assert.equal(secretHits.length, before, `secret server reached: ${secretHits.slice(before)}`);
    const refused = guardLog.lines.slice(refusedBefore).join('\n');
    for (const reason of ['loopback', 'metadata', 'private']) assert.match(refused, new RegExp(`reason=${reason}`));
    // A public subresource on the same page still loads.
    assert.ok(originHits.filter((u) => u === '/green.svg').length > greenBefore);
  });

  test('the same subresources in inline HTML are refused', async () => {
    const base = await startApp();
    const before = secretHits.length;
    const html = `<img src="http://127.0.0.1:${secretPort}/inline-img"><script>fetch('http://127.0.0.1:${secretPort}/inline-fetch')</script>
      <iframe src="http://169.254.169.254/computeMetadata/v1/"></iframe>`;
    const { status } = await post(base, { html }, { 'x-api-key': KEY });
    assert.equal(status, 200);
    assert.equal(secretHits.length, before, `secret server reached: ${secretHits.slice(before)}`);
  });

  test('a file:// iframe or image in inline HTML does not load', async () => {
    const marker = `FILE-MARKER-${Date.now()}`;
    const file = path.join(tmpDir, 'local.html');
    fs.writeFileSync(file, `<h1>${marker}</h1>`);
    const context = await browser.newContext({ viewport: { width: 1200, height: 630 } });
    try {
      const page = await context.newPage();
      const failed = [];
      const blocked = [];
      page.on('requestfailed', (request) => failed.push(request.url()));
      page.on('console', (message) => message.text().includes('Not allowed to load local resource') && blocked.push(message.text()));
      await page.setContent(`<iframe src="file://${file}"></iframe><img src="file://${file}">`, { waitUntil: 'load', timeout: 10000 });
      await page.waitForTimeout(300);
      assert.ok(blocked.length > 0 || failed.length > 0, 'no sign that Chromium refused the file:// loads');
      assert.ok(page.frames().every((frame) => !frame.url().startsWith('file:')), page.frames().map((f) => f.url()).join());
      assert.ok(!(await page.mainFrame().evaluate(() => document.documentElement.innerText)).includes(marker));
    } finally {
      await context.close();
    }
  });

  test('Chromium runs with its sandbox on and every request through the guard', async () => {
    assert.equal(browser.sandbox, true);
    const proxy = await browser.egressProxy();
    assert.ok(proxy.refusals() > 0);
  });
});
