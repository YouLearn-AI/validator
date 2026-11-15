// The PDF renderer (ops I-1177) with a real headless Chromium and the fixture print page
// (test/fixtures/print-page/index.html, which implements print-page-contract.mjs).
// "print.test" stands for the web app, as "public.test" does in render-guard.test.mjs: its lookup answers a public
// address and its connections go to a local server, so the egress guard runs unchanged.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GuardedBrowser } from '../guarded-browser.mjs';
import { createPdfApp } from '../pdf-app.mjs';
import {
  PDF_DEFAULTS, PDF_GUARD, PageRefused, checkPageUrl, createPdfRenderer, pageInput, parseOrigins,
} from '../pdf-renderer.mjs';

const FAKE_PUBLIC = '93.184.216.34';
const KEY = 'test-pdf-key-0123456789';
const FIXTURE = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'print-page', 'index.html'),
);

function collectingLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, log: { info: push, warn: push, error: push, log: push } };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function hasPdftotext() {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// A synthetic summary: headings, paragraphs, a table, citations with text after them, a diagram, an Arabic
// paragraph, and a chunk that does not print.
const SECRET_TITLE = 'TITLE-SECRET-3307 Cell biology';
const CHUNKS = [
  { type: 'response', content: '## Membranes\n\nPhospholipids form a bilayer around every cell.' },
  { type: 'source', content: '【1】', og_source: 'doc-1' },
  { type: 'response', content: ' Proteins float within the bilayer like icebergs.\n\n' },
  { type: 'whiteboard', wtype: 'xml', identifier: 'd1', title: 'Fluid mosaic', content: '<whiteboard/>' },
  { type: 'space_source', content: '【2】', source: 'content-1', og_source: 'doc-2' },
  { type: 'response', content: ' Cholesterol keeps the membrane fluid in the cold.\n\n'
    + '| Molecule | Role |\n|---|---|\n| Cholesterol | Fluidity |\n| Glycoprotein | Signalling |\n\n'
    + 'تتكون الأغشية الخلوية من طبقتين من الدهون الفوسفاتية.' },
  { type: 'follow_up_questions', questions: ['Not printed'] },
];
const PARAGRAPHS = [
  'Phospholipids form a bilayer around every cell.',
  'Proteins float within the bilayer like icebergs.',
  'Cholesterol keeps the membrane fluid in the cold.',
  'Glycoprotein',
];

describe('settings and input', () => {
  test('PDF_PAGE_ORIGINS keeps http(s) origins only', () => {
    const { lines, log } = collectingLog();
    const origins = parseOrigins(' https://app.youlearn.ai, http://print.test:8080/ ,https://x.test/path,ftp://f.test,,nope', log);
    assert.deepEqual([...origins], ['https://app.youlearn.ai', 'http://print.test:8080']);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => !l.includes('x.test') && !l.includes('nope')), 'no entry is quoted');
    assert.equal(parseOrigins(undefined).size, 0);
  });

  test('a page URL off the listed origins is refused', () => {
    const origins = new Set(['https://app.youlearn.ai']);
    assert.equal(checkPageUrl('https://app.youlearn.ai/print/summary', origins).pathname, '/print/summary');
    for (const [url, reason] of [
      ['https://evil.test/print', 'origin'],
      ['http://app.youlearn.ai/print', 'origin'],
      ['https://app.youlearn.ai:444/print', 'origin'],
      ['https://user:pw@app.youlearn.ai/print', 'credentials'],
      ['not a url', 'malformed'],
    ]) {
      assert.throws(() => checkPageUrl(url, origins), (e) => e instanceof PageRefused && e.reason === reason, url);
    }
  });

  test('the document is checked', () => {
    assert.deepEqual(pageInput({ chunks: [{ type: 'response', content: 'x' }] }),
      { version: 1, title: null, language: null, chunks: [{ type: 'response', content: 'x' }] });
    assert.equal(pageInput({ title: 'T', language: 'ar', chunks: [{}] }).language, 'ar');
    assert.equal(pageInput({ language: 'zh-Hant', chunks: [{}] }).language, 'zh-Hant');
    for (const bad of [
      null, 'x', {}, { chunks: [] }, { chunks: 'x' }, { chunks: [1] }, { chunks: [[]] }, { chunks: [null] },
      { chunks: [{}], title: 5 }, { chunks: [{}], title: 'x'.repeat(PDF_DEFAULTS.maxTitleLength + 1) },
      { chunks: [{}], language: 'en"><script>' }, { chunks: Array(PDF_DEFAULTS.maxChunks + 1).fill({}) },
    ]) {
      assert.equal(pageInput(bad), null, JSON.stringify(bad)?.slice(0, 80));
    }
  });
});

describe('/render-pdf', { timeout: 180_000 }, () => {
  let fixturePort;
  let fixture;
  const hits = [];
  const hosts = [];
  const elsewhere = () => hosts.filter((host) => host === 'elsewhere.test').length;
  let browser;
  let guardLog;
  const servers = [];

  // print.test is the listed origin; elsewhere.test is a second public origin that is not listed. Both are served by
  // the fixture server, which records each request's host, so a test can show nothing reached elsewhere.test.
  const FAKE_HOSTS = new Set(['print.test', 'elsewhere.test']);
  const lookup = async (host) => {
    if (FAKE_HOSTS.has(host)) return [{ address: FAKE_PUBLIC, family: 4 }];
    return dns.lookup(host, { all: true, verbatim: true });
  };
  // Connections to the fake hosts go to the fixture server; the socket reports the fake public address.
  const connect = (options) => {
    if (!FAKE_HOSTS.has(options.host)) return net.connect(options);
    const socket = net.connect({
      ...options,
      port: fixturePort,
      lookup: (hostname, opts, callback) => options.lookup(hostname, opts, (error, records, family) => {
        if (error) return callback(error);
        if (Array.isArray(records)) return callback(null, records.map((r) => ({ ...r, address: '127.0.0.1' })));
        return callback(null, '127.0.0.1', family);
      }),
    });
    Object.defineProperty(socket, 'remoteAddress', { get: () => FAKE_PUBLIC });
    return socket;
  };

  const page = (mode = '') => `http://print.test:${fixturePort}/print/summary${mode ? `?mode=${mode}` : ''}`;

  async function startApp({ key = KEY, options = {} } = {}) {
    const collected = collectingLog();
    const origins = new Set([`http://print.test:${fixturePort}`]);
    const renderPdf = createPdfRenderer(browser, {
      origins, options, log: collected.log, checkOptions: { ...PDF_GUARD, lookup, log: collected.log },
    });
    const server = http.createServer(createPdfApp({ renderPdf, key, log: collected.log }));
    const port = await listen(server);
    servers.push(server);
    return { base: `http://127.0.0.1:${port}`, lines: collected.lines };
  }

  async function post(base, body, headers = { 'x-api-key': KEY }) {
    const response = await fetch(`${base}/render-pdf`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      type,
      length: response.headers.get('content-length'),
      encoding: response.headers.get('transfer-encoding'),
      bytes,
      json: type.includes('json') ? JSON.parse(bytes.toString('utf8')) : null,
    };
  }

  const summary = { title: SECRET_TITLE, language: 'en', chunks: CHUNKS };

  before(async () => {
    fixture = http.createServer((req, res) => {
      hits.push(req.url);
      hosts.push(String(req.headers.host).split(':')[0]);
      if (req.url.startsWith('/print/summary')) {
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(FIXTURE);
      }
      if (req.url === '/redirect-away') return res.writeHead(302, { location: 'http://elsewhere.test/' }).end();
      return res.writeHead(404).end();
    });
    fixturePort = await listen(fixture);
    guardLog = collectingLog();
    browser = new GuardedBrowser({ guard: { ...PDF_GUARD, lookup, connect }, log: guardLog.log });
  });

  after(async () => {
    await browser.close();
    for (const server of servers) server.close();
    fixture.close();
  });

  test('the key is required: missing, wrong, or none configured', async () => {
    const { base } = await startApp();
    assert.equal((await post(base, { url: page(), document: summary }, {})).status, 401);
    assert.equal((await post(base, { url: page(), document: summary }, { 'x-api-key': 'wrong' })).status, 401);
    const unconfigured = await startApp({ key: '' });
    assert.equal((await post(unconfigured.base, { url: page(), document: summary })).status, 503);
  });

  test('a body without a URL or chunks is a 400', async () => {
    const { base } = await startApp();
    for (const body of [{}, { url: page() }, { url: page(), document: { chunks: [] } }, { url: 5, document: summary }]) {
      const r = await post(base, body);
      assert.equal(r.status, 400);
      assert.equal(r.json.code, 'bad_request');
    }
  });

  test('a page off the listed origins is refused before anything opens it', async () => {
    const { base } = await startApp();
    const before = hits.length;
    for (const url of ['http://evil.test/print', `http://127.0.0.1:${fixturePort}/print/summary`, 'file:///etc/passwd']) {
      const r = await post(base, { url, document: summary });
      assert.equal(r.status, 400, url);
      assert.equal(r.json.code, 'origin_refused', url);
    }
    assert.equal(hits.length, before, 'the fixture server was not asked');
  });

  test('the print page prints the summary, streamed as a PDF', async (t) => {
    const { base, lines } = await startApp();
    const r = await post(base, { url: page(), document: summary });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.type, 'application/pdf');
    assert.equal(r.length, null, 'no Content-Length');
    assert.equal(r.encoding, 'chunked');
    assert.equal(r.bytes.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.ok(r.bytes.length > 1000);
    assert.ok(lines.some((l) => /^\[RENDER_PDF\] status=ok chunks=7 bytes=\d+ /.test(l)), lines.join('\n'));
    if (hasPdftotext()) {
      // The PDF goes in on stdin: no file is written.
      const text = execFileSync('pdftotext', ['-', '-'], { input: r.bytes, encoding: 'utf8' }).replace(/\s+/g, ' ');
      for (const paragraph of PARAGRAPHS) assert.ok(text.includes(paragraph), paragraph);
      assert.ok(text.includes('Diagram: Fluid mosaic'));
      assert.ok(!text.includes('Not printed'));
      assert.ok(text.includes('الدهون'), 'the Arabic paragraph');
    } else {
      t.diagnostic('pdftotext is not installed: the PDF text was not read');
    }
  });

  test('the page\'s error signal is a 502 with its code', async () => {
    const { base } = await startApp();
    const r = await post(base, { url: page('error'), document: summary });
    assert.equal(r.status, 502);
    assert.deepEqual([r.json.code, r.json.page_code], ['page_error', 'render_failed']);
  });

  test('a page that never says ready is a 504 at its deadline', async () => {
    const { base, lines } = await startApp({ options: { deadlineMs: 3000 } });
    const t0 = Date.now();
    const r = await post(base, { url: page('never'), document: summary });
    assert.equal(r.status, 504);
    assert.deepEqual([r.json.code, r.json.stage], ['timeout', 'ready']);
    assert.ok(Date.now() - t0 < 8000);
    assert.ok(lines.some((l) => l.startsWith('[RENDER_PDF] status=timed_out stage=ready')), lines.join('\n'));
  });

  test('a page without the contract fails at its stage', async () => {
    const { base } = await startApp({ options: { contractTimeoutMs: 1000 } });
    const r = await post(base, { url: page('nocontract'), document: summary });
    assert.equal(r.status, 500);
    assert.deepEqual([r.json.code, r.json.stage, r.json.failure], ['failed', 'contract', 'timeout']);
  });

  test('a page that navigates away is stopped before the request leaves, and gets no PDF', async () => {
    const { base } = await startApp();
    const before = elsewhere();
    const away = await post(base, { url: page('navigate'), document: summary });
    assert.equal(away.status, 502);
    assert.equal(away.json.code, 'page_navigated');
    assert.equal(elsewhere(), before, 'elsewhere.test was never asked');
  });

  test('a redirect off the origins gets no document and no PDF', async () => {
    // Playwright routes only a redirect's first request, so the hop itself is sent (with no document, no cookies).
    const { base } = await startApp();
    const redirected = await post(base, { url: `http://print.test:${fixturePort}/redirect-away`, document: summary });
    assert.equal(redirected.status, 502);
    assert.equal(redirected.json.code, 'page_navigated');
  });

  test('a popup is stopped before its request leaves, and the print goes on', async () => {
    const { base } = await startApp();
    const before = elsewhere();
    const r = await post(base, { url: page('popup'), document: summary });
    assert.equal(r.status, 200);
    assert.equal(elsewhere(), before, 'elsewhere.test was never asked');
  });

  test('one render at a time: a second one meanwhile is a 503', async () => {
    const { base } = await startApp({ options: { deadlineMs: 4000 } });
    const first = post(base, { url: page('never'), document: summary });
    await new Promise((resolve) => { setTimeout(resolve, 500); });
    const second = await post(base, { url: page(), document: summary });
    assert.equal(second.status, 503);
    assert.equal(second.json.code, 'busy');
    assert.equal((await first).status, 504);
    assert.equal((await post(base, { url: page(), document: summary })).status, 200, 'free again');
  });

  test('logs carry codes, counts and times, never the summary, page errors or console text', async () => {
    const { base, lines } = await startApp();
    assert.equal((await post(base, { url: page('throw'), document: summary })).status, 200);
    assert.equal((await post(base, { url: page('error'), document: summary })).status, 502);
    assert.equal((await post(base, { url: page('hostleak'), document: summary })).status, 200);
    assert.ok(guardLog.lines.some((l) => l.startsWith('[EGRESS_REFUSED] reason=loopback host=-')), guardLog.lines.join('\n'));
    const all = [...lines, ...guardLog.lines].join('\n');
    for (const secret of ['TITLE-SECRET-3307', 'PAGE-ERROR-SECRET-5521', 'CONSOLE-SECRET-8830', 'Phospholipids', 'print/summary',
      'host-secret-4471']) {
      assert.ok(!all.includes(secret), `${secret} in the logs`);
    }
    assert.ok(lines.some((l) => /status=ok .*page_errors=1 /.test(l)), lines.join('\n'));
  });
});
