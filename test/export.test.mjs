// The export renderer (ops I-1313): its HTTP app with a fake renderer, then the real renderer in headless
// Chromium against a stand-in print page served on loopback, the one origin the guard trusts. Every other
// loopback port stays refused: a "secret" server on another port must never be reached.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { GuardedBrowser } from '../guarded-browser.mjs';
import { startEgressProxy, trustedOriginKeys } from '../egress-guard.mjs';
import { createExportApp, documentProblem } from '../export-app.mjs';
import {
  createExportRenderer, ExportBusy, ExportFailed, ExportTimeout, printOrigin, printPageUrl,
} from '../export-renderer.mjs';

const KEY = 'test-export-key-0123456789';

function collectingLog() {
  const lines = [];
  const push = (...a) => lines.push(a.join(' '));
  return { lines, log: { info: push, warn: push, error: push, log: push } };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

const DOC = {
  title: 'Cell biology',
  language: 'en',
  outputs: [{ kind: 'answer', title: null, chunks: [{ type: 'response', content: 'Mitochondria make ATP.' }] }],
};

async function post(port, body, headers = { 'x-api-key': KEY }) {
  const response = await fetch(`http://127.0.0.1:${port}/render-pdf`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const type = response.headers.get('content-type') || '';
  return {
    status: response.status,
    headers: response.headers,
    body: type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()),
  };
}

describe('documentProblem', () => {
  test('accepts a document of outputs', () => {
    assert.equal(documentProblem({ document: DOC }), null);
  });
  test('refuses a URL in place of outputs, unknown kinds and empty lists', () => {
    assert.match(documentProblem({ url: 'http://169.254.169.254/' }), /document/);
    assert.match(documentProblem({ document: { ...DOC, outputs: [] } }), /outputs/);
    assert.match(documentProblem({ document: { ...DOC, outputs: [{ kind: 'html', chunks: [] }] } }), /kind/);
    assert.match(documentProblem({ document: { ...DOC, title: 'x'.repeat(301) } }), /title/);
    assert.match(documentProblem({ document: { ...DOC, direction: 'up' } }), /direction/);
  });
});

describe('printPageUrl and printOrigin', () => {
  test('appends a language tag, English for anything else', () => {
    assert.equal(printPageUrl('https://app.youlearn.ai/export-print/', 'ar'), 'https://app.youlearn.ai/export-print/ar');
    assert.equal(printPageUrl('https://app.youlearn.ai/export-print', '../../x'), 'https://app.youlearn.ai/export-print/en');
    assert.equal(printPageUrl('https://app.youlearn.ai/export-print?x=1', 'pt-BR'), 'https://app.youlearn.ai/export-print/pt-BR');
  });
  test('names loopback print pages', () => {
    assert.deepEqual(printOrigin('http://localhost:3000/export-print'), { host: 'localhost', port: 3000, loopback: true });
    assert.equal(printOrigin('https://app.youlearn.ai/export-print').loopback, false);
    assert.equal(printOrigin('file:///etc/passwd'), null);
  });
});

describe('export app', () => {
  let server;
  let port;
  const calls = [];
  let behaviour = 'ok';
  before(async () => {
    const { log } = collectingLog();
    const app = createExportApp({
      key: KEY,
      log,
      renderPdf: async (doc) => {
        calls.push(doc);
        if (behaviour === 'busy') throw new ExportBusy();
        if (behaviour === 'timeout') throw new ExportTimeout(10);
        if (behaviour === 'failed') throw new ExportFailed('draw', 'page_failed');
        return { pdf: Buffer.from('%PDF-1.7 test'), diagrams: 2, imagesFailed: 0, ms: 5 };
      },
    });
    server = http.createServer(app);
    port = await listen(server);
  });
  after(() => server.close());

  test('refuses a request without the key before reading the body', async () => {
    const before = calls.length;
    assert.equal((await post(port, { document: DOC }, {})).status, 401);
    assert.equal((await post(port, { document: DOC }, { 'x-api-key': 'wrong' })).status, 401);
    assert.equal(calls.length, before);
  });

  test('answers the PDF bytes with counts in headers', async () => {
    behaviour = 'ok';
    const answer = await post(port, { document: DOC });
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('content-type'), 'application/pdf');
    assert.equal(answer.body.toString(), '%PDF-1.7 test');
    assert.equal(answer.headers.get('x-export-diagrams'), '2');
  });

  test('a bad document is 400 and never renders', async () => {
    const before = calls.length;
    assert.equal((await post(port, { url: 'http://127.0.0.1:1/' })).status, 400);
    assert.equal(calls.length, before);
  });

  test('busy, timeout and failure map to 503, 504 and 500 with codes only', async () => {
    behaviour = 'busy';
    const busy = await post(port, { document: DOC });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    behaviour = 'timeout';
    assert.equal((await post(port, { document: DOC })).status, 504);
    behaviour = 'failed';
    const failed = await post(port, { document: DOC });
    assert.equal(failed.status, 500);
    assert.deepEqual(failed.body, { success: false, error: 'Export failed', stage: 'draw', code: 'page_failed' });
  });
});

describe('trusted origins in the egress guard', () => {
  test('keys are exact host and port', () => {
    const keys = trustedOriginKeys([{ host: 'LocalHost', port: 3000 }]);
    assert.ok(keys.has('localhost:3000'));
    assert.ok(!keys.has('localhost:3001'));
  });

  test('a trusted origin is reached; another port on the same host is refused', async () => {
    let secretHits = 0;
    const page = http.createServer((_req, res) => res.end('page'));
    const secret = http.createServer((_req, res) => { secretHits += 1; res.end('secret'); });
    const pagePort = await listen(page);
    const secretPort = await listen(secret);
    const { log } = collectingLog();
    const proxy = await startEgressProxy({ log, trusted: [{ host: '127.0.0.1', port: pagePort }] });
    const through = (target) => new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'GET', path: target }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.end();
    });
    try {
      assert.deepEqual(await through(`http://127.0.0.1:${pagePort}/`), { status: 200, body: 'page' });
      assert.equal((await through(`http://127.0.0.1:${secretPort}/`)).status, 403);
      assert.equal((await through(`http://localhost:${secretPort}/`)).status, 403);
      assert.equal(secretHits, 0);
    } finally {
      await proxy.close();
      page.close();
      secret.close();
    }
  });
});

// A stand-in for the web app's print route: the same handshake (data-export-state waiting -> ready), an image
// that points at the secret server on another loopback port, and text in Arabic.
function printPage(secretPort, { fail = false } = {}) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><main id="doc"></main><script>
    window.__youlearnExportRender = (doc) => {
      if (${fail}) { document.documentElement.dataset.exportState = 'failed'; return; }
      const main = document.getElementById('doc');
      const h = document.createElement('h1'); h.textContent = doc.title; main.appendChild(h);
      for (const output of doc.outputs) for (const chunk of output.chunks) {
        const p = document.createElement('p'); p.textContent = chunk.content; main.appendChild(p);
      }
      const img = new Image();
      img.onerror = img.onload = () => {
        document.documentElement.dataset.exportImagesFailed = img.naturalWidth ? '0' : '1';
        document.documentElement.dataset.exportDiagrams = '0';
        document.documentElement.dataset.exportState = 'ready';
      };
      img.src = 'http://127.0.0.1:${secretPort}/leak.png';
      main.appendChild(img);
    };
    document.documentElement.dataset.exportState = 'waiting';
  </script></body></html>`;
}

describe('export renderer in Chromium', () => {
  let browser;
  let page;
  let secret;
  let pagePort;
  let secretHits = 0;
  let failPage = false;
  const requested = [];
  before(async () => {
    secret = http.createServer((_req, res) => { secretHits += 1; res.end('secret'); });
    const secretPort = await listen(secret);
    page = http.createServer((req, res) => {
      requested.push(req.url);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(printPage(secretPort, { fail: failPage }));
    });
    pagePort = await listen(page);
    const { log } = collectingLog();
    browser = new GuardedBrowser({ killable: true, log, guard: { log, logHosts: false, trusted: [{ host: '127.0.0.1', port: pagePort }] } });
  });
  after(async () => {
    await browser.close();
    page.close();
    secret.close();
  });

  test('prints the outputs to a PDF and reaches nothing but the print page', async () => {
    const { log, lines } = collectingLog();
    const renderPdf = createExportRenderer(browser, { printUrl: `http://127.0.0.1:${pagePort}/export-print`, log });
    const doc = { ...DOC, language: 'ar', outputs: [{ kind: 'summary', chunks: [{ type: 'response', content: 'الخلية هي وحدة الحياة' }] }] };
    const result = await renderPdf(doc);
    assert.equal(result.pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(result.pdf.length > 1000);
    assert.equal(result.imagesFailed, 1);
    assert.equal(secretHits, 0);
    assert.deepEqual(requested.at(-1), '/export-print/ar');
    // Codes, counts and times only: neither the title nor the text reaches a log line.
    assert.ok(lines.some((l) => l.startsWith('[EXPORT_PDF] ok outputs=1')));
    assert.ok(lines.every((l) => !l.includes('Cell biology') && !l.includes('الخلية')));
  });

  test('a page that reports failure is ExportFailed with a code', async () => {
    failPage = true;
    const { log } = collectingLog();
    const renderPdf = createExportRenderer(browser, { printUrl: `http://127.0.0.1:${pagePort}/export-print`, log });
    await assert.rejects(renderPdf(DOC), (e) => e instanceof ExportFailed && e.code === 'page_failed');
    failPage = false;
  });

  test('a second export while one runs is ExportBusy; the deadline is ExportTimeout', async () => {
    const { log } = collectingLog();
    // A print page that never answers: the render waits on it until the deadline.
    const hanging = http.createServer(() => {});
    const hangPort = await listen(hanging);
    const own = new GuardedBrowser({ killable: true, log, guard: { log, trusted: [{ host: '127.0.0.1', port: hangPort }] } });
    const stuck = createExportRenderer(own, {
      printUrl: `http://127.0.0.1:${hangPort}/export-print`, log, options: { deadlineMs: 1500, teardownMs: 2000 },
    });
    try {
      const first = stuck(DOC);
      await assert.rejects(stuck(DOC), (e) => e instanceof ExportBusy);
      await assert.rejects(first, (e) => e instanceof ExportTimeout);
    } finally {
      await own.close();
      hanging.closeAllConnections?.();
      hanging.close();
    }
  });
});
