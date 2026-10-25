// POST /validate/latex refuses custom delimiters that would stall the scan, and the scan stops instead of
// repeating a pass that does not move forward (ops I-743 F-08). Every call runs in a worker thread with a
// deadline: without the fix, a bad call spins its thread forever, and here that fails the test instead of
// stopping the runner.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { defaultDelimiters } from '../latex-validator.mjs';

const WORKER = new URL('./fixtures/latex-worker.mjs', import.meta.url);
// The app loads jsdom and Mermaid, which can take seconds on a busy machine.
const READY_MS = 60_000;
// A sound call answers in milliseconds; a stalled one never answers.
const DEADLINE_MS = 3_000;
const TIMED_OUT = { timedOut: true };

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** One validator call in a new worker: { result }, { error: { name, message } }, or TIMED_OUT. */
async function callInWorker(fn, ...args) {
  const worker = new Worker(WORKER, { workerData: { mode: 'call' } });
  try {
    await withDeadline(once(worker, 'message'), READY_MS);
    worker.postMessage({ fn, args });
    return await withDeadline(once(worker, 'message').then(([message]) => message), DEADLINE_MS);
  } finally {
    await worker.terminate();
  }
}

/** The app in a worker. A request that times out restarts it, so one stall can't fail the tests after it. */
class AppInWorker {
  async start() {
    this.worker = new Worker(WORKER, { workerData: { mode: 'serve' } });
    const answer = await withDeadline(once(this.worker, 'message'), READY_MS);
    assert.notEqual(answer, TIMED_OUT, 'the app did not start');
    [this.port] = answer;
  }

  async stop() {
    await this.worker?.terminate();
  }

  /** { status, body } or TIMED_OUT. */
  async post(body) {
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/validate/latex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(DEADLINE_MS),
      });
      return { status: response.status, body: await response.json() };
    } catch (error) {
      if (error.name !== 'TimeoutError') throw error;
      await this.stop();
      await this.start();
      return TIMED_OUT;
    }
  }
}

const delimiter = (left, right, display = false) => ({ left, right, display });

describe('POST /validate/latex', () => {
  const app = new AppInWorker();
  before(() => app.start());
  after(() => app.stop());

  const refused = [
    ['an empty left and right', [delimiter('', '')], 'delimiters[0].left must be a non-empty string of at most 64 characters'],
    ['an empty left', [delimiter('', '$')], 'delimiters[0].left must be a non-empty string of at most 64 characters'],
    ['an empty left after a sound one', [delimiter('$$', '$$', true), delimiter('', '')], 'delimiters[1].left must be a non-empty string of at most 64 characters'],
    ['an object, not an array', delimiter('$', '$'), '"delimiters" must be an array'],
    ['null', null, '"delimiters" must be an array'],
    ['a string', '$', '"delimiters" must be an array'],
    ['an empty array', [], '"delimiters" must have 1 to 64 entries'],
    ['65 entries', Array.from({ length: 65 }, (_, i) => delimiter(`<${i}>`, `</${i}>`)), '"delimiters" must have 1 to 64 entries'],
    ['a null entry', [null], 'delimiters[0] must be an object'],
    ['an array entry', [['$', '$']], 'delimiters[0] must be an object'],
    ['a number left', [{ left: 5, right: '$', display: false }], 'delimiters[0].left must be a non-empty string of at most 64 characters'],
    ['a 65-character left', [delimiter('$'.repeat(65), '$')], 'delimiters[0].left must be a non-empty string of at most 64 characters'],
    ['no right', [{ left: '$', display: false }], 'delimiters[0].right must be a string of at most 64 characters'],
    ['a 65-character right', [delimiter('$', '$'.repeat(65))], 'delimiters[0].right must be a string of at most 64 characters'],
    ['no display', [{ left: '$', right: '$' }], 'delimiters[0].display must be true or false'],
    ['a string display', [{ left: '$', right: '$', display: 'true' }], 'delimiters[0].display must be true or false'],
  ];
  for (const [name, delimiters, error] of refused) {
    test(`refuses delimiters with ${name} (400) before any work`, async () => {
      const answer = await app.post({ text: 'x $y$ z', delimiters });
      assert.notEqual(answer, TIMED_OUT, 'the request stalled');
      assert.deepEqual(answer, { status: 400, body: { valid: false, error } });
    });
  }

  test('accepts 64 custom delimiters, and the defaults sent as custom ones', async () => {
    const many = Array.from({ length: 64 }, (_, i) => delimiter(`<${i}>`, `</${i}>`));
    assert.deepEqual(await app.post({ text: 'a <3>x^2</3> b', delimiters: many }), { status: 200, body: { valid: true } });
    assert.deepEqual(
      await app.post({ text: 'Display \\[E = mc^2\\] and \\item one', delimiters: defaultDelimiters }),
      { status: 200, body: { valid: true } },
    );
  });

  test('custom delimiters still find math and its errors', async () => {
    const dollars = [delimiter('$$', '$$', true)];
    assert.deepEqual(await app.post({ text: 'so $$x^2$$ holds', delimiters: dollars }), { status: 200, body: { valid: true } });
    const answer = await app.post({ text: 'so $$\\frac{a}$$ holds', delimiters: dollars });
    assert.equal(answer.status, 400);
    assert.equal(answer.body.errors[0].type, 'katex_error');
  });

  // The backend's only request shape (youlearn-backend providers/validator.py): text alone, default delimiters.
  test("the backend's request (text only) answers as before", async () => {
    assert.deepEqual(
      await app.post({ text: 'This is valid LaTeX: \\(x = \\frac{a}{b}\\)' }),
      { status: 200, body: { valid: true } },
    );
    assert.deepEqual(await app.post({ text: 'Unclosed: \\( x + 1' }), {
      status: 400,
      body: {
        valid: false,
        errors: [{
          message: 'Unclosed LaTeX delimiter: "\\(" at position 10',
          position: 10,
          length: 2,
          latex: '\\( x + 1...',
          type: 'unclosed',
        }],
        error: 'Found 1 LaTeX error(s)',
      },
    });
    const katexError = await app.post({ text: 'This has invalid LaTeX: \\[x = \\frac{a}\\]' });
    assert.equal(katexError.status, 400);
    assert.equal(katexError.body.error, 'Found 1 LaTeX error(s)');
    assert.equal(katexError.body.errors[0].type, 'katex_error');
    assert.equal(katexError.body.errors[0].position, 24);
  });

  // Macros need no check of their own: KaTeX stops a self-expanding macro after maxExpand (1000) expansions.
  test('a macro that expands itself answers at once', async () => {
    const answer = await app.post({ text: 'a \\(\\loop\\) b', macros: { '\\loop': '\\loop' } });
    assert.notEqual(answer, TIMED_OUT, 'the request stalled');
    assert.equal(answer.status, 400);
    assert.match(answer.body.errors[0].message, /Too many expansions/);
  });
});

describe('the scan never repeats a pass in place', () => {
  test('validateLatex stops on an empty left and right', async () => {
    const answer = await callInWorker('validateLatex', 'x', [delimiter('', '')]);
    assert.notEqual(answer, TIMED_OUT, 'the scan stalled');
    assert.deepEqual(answer, { error: { name: 'LatexScanStalled', message: 'LaTeX scan made no progress at position 0' } });
  });

  test('validateLatex stops on an empty left whose right closes once', async () => {
    const answer = await callInWorker('validateLatex', 'a$b', [delimiter('', '$')]);
    assert.notEqual(answer, TIMED_OUT, 'the scan stalled');
    assert.deepEqual(answer, { error: { name: 'LatexScanStalled', message: 'LaTeX scan made no progress at position 2' } });
  });

  test('validateLatexUsingSplitter answers invalid on an empty left and right', async () => {
    const answer = await callInWorker('validateLatexUsingSplitter', 'x', [delimiter('', '')]);
    assert.notEqual(answer, TIMED_OUT, 'the scan stalled');
    assert.equal(answer.result.isValid, false);
    assert.equal(answer.result.errors[0].message, 'Parsing error: LaTeX scan made no progress at position 0');
  });

  test('the default delimiters scan as before', async () => {
    const answer = await callInWorker('validateLatex', 'a \\(x\\) \\item b \\[\\frac{1}{2}\\] c');
    assert.deepEqual(answer, { result: { isValid: true, errors: [] } });
  });
});
