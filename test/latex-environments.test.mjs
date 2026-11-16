// A math environment KaTeX supports (cases, the matrices, array, align, equation) is checked whole, its \begin
// and \end included, in display mode (ops I-1691). The scan used to check only the rows between them, where '&'
// and '\\' are errors, so valid display math such as a cases function in $$ was flagged, and the backend
// rewrote the whole summary to "fix" it. Broken math inside an environment must still fail.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { createApp } from '../app.mjs';
import { KATEX_ENVIRONMENTS, defaultDelimiters, validateLatex } from '../latex-validator.mjs';

// Each default math environment, with a valid body that has cells or rows where it can.
const ENVIRONMENTS = [
  ['cases', 'f(x) = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}'],
  ['matrix', '\\begin{matrix} a & b \\\\ c & d \\end{matrix}'],
  ['pmatrix', 'A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}'],
  ['bmatrix', 'B = \\begin{bmatrix} \\cos\\theta & -\\sin\\theta \\\\ \\sin\\theta & \\cos\\theta \\end{bmatrix}'],
  ['array', '\\left[\\begin{array}{cc|c} 1 & 2 & 3 \\\\ 4 & 5 & 6 \\end{array}\\right]'],
  ['align', '\\begin{align} (a+b)^2 &= a^2 + 2ab + b^2 \\\\ &\\ge 0 \\end{align}'],
  ['align*', '\\begin{align*} \\nabla \\cdot E &= \\frac{\\rho}{\\varepsilon_0} \\\\ \\nabla \\cdot B &= 0 \\end{align*}'],
  ['equation', '\\begin{equation} E = mc^2 \\end{equation}'],
];

// How a summary carries display math: the backend's prompts ask for $$, the frontend also draws \[ \], and the
// align family stands bare.
const PLACEMENTS = [
  ['inside $$', (math) => `The rule is\n\n$$${math}$$\n\nfor every case.`],
  ['inside \\[ \\]', (math) => `The rule is \\[${math}\\] for every case.`],
  ['bare', (math) => `The rule is\n\n${math}\n\nfor every case.`],
];

// I-1237 may add $$ to the defaults; an environment inside it must then be checked as part of its $$, not alone.
const WITH_DOLLARS = [{ left: '$$', right: '$$', display: true }, ...defaultDelimiters];

describe('KaTeX math environments are checked whole (I-1691)', () => {
  for (const [name, math] of ENVIRONMENTS) {
    for (const [where, place] of PLACEMENTS) {
      test(`valid ${name} ${where} passes`, () => {
        assert.deepEqual(validateLatex(place(math)).errors, []);
      });
    }
  }

  for (const [name, math] of ENVIRONMENTS) {
    const close = `\\end{${name}}`;
    const broken = [
      ['an unknown command', math.replace(close, `\\notacommand ${close}`), 'katex_error', /Undefined control sequence: \\notacommand/],
      ['an unclosed brace', math.replace(close, `\\frac{1}{2 ${close}`), 'unclosed', /Unclosed LaTeX delimiter/],
      ['a stray closing brace', math.replace(close, `x} ${close}`), 'katex_error', /Invalid LaTeX syntax/],
    ];
    for (const [fault, text, type, message] of broken) {
      test(`${name} with ${fault} still fails, inside $$ and bare`, () => {
        for (const placed of [`$$${text}$$`, text]) {
          const { isValid, errors } = validateLatex(placed);
          assert.equal(isValid, false, placed);
          assert.equal(errors[0].type, type, placed);
          assert.match(errors[0].message, message, placed);
        }
      });
    }
  }

  test('an unclosed environment fails', () => {
    const { errors } = validateLatex('$$\\begin{cases} x & y$$');
    assert.deepEqual(errors.map((error) => error.message), ['Unclosed LaTeX delimiter: "\\begin{cases}" at position 2']);
  });

  test('the error spans the whole environment', () => {
    const text = 'So $$\\begin{pmatrix} 1 & \\oops \\end{pmatrix}$$.';
    const [error] = validateLatex(text).errors;
    assert.equal(error.position, 5);
    assert.equal(error.latex, '\\begin{pmatrix} 1 & \\oops \\end{pmatrix}');
    assert.equal(error.length, error.latex.length);
  });

  test('a matrix or cases inside inline \\( \\) passes', () => {
    assert.deepEqual(validateLatex('Let \\(v = \\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix}\\) be the vector.').errors, []);
    assert.deepEqual(validateLatex('So \\(|x| = \\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}\\).').errors, []);
  });

  test('an environment nested in one of its own name ends at the outer \\end', () => {
    const blocks = '$$M = \\begin{pmatrix} \\begin{pmatrix} 1 & 0 \\\\ 0 & 1 \\end{pmatrix} & 0 \\\\ 0 & 1 \\end{pmatrix}$$';
    const piecewise = '$$g(x) = \\begin{cases} \\begin{cases} 1 & x > 1 \\\\ x & 0 < x \\le 1 \\end{cases} & x > 0 \\\\ 0 & x \\le 0 \\end{cases}$$';
    assert.deepEqual(validateLatex(blocks).errors, []);
    assert.deepEqual(validateLatex(piecewise).errors, []);
    const broken = validateLatex(blocks.replace('1 & 0', '1 & \\oops'));
    assert.equal(broken.errors.length, 1);
    assert.match(broken.errors[0].message, /Undefined control sequence: \\oops/);
  });

  test('an environment KaTeX supports but the defaults do not list still lets a listed one inside it pass', () => {
    const text = '$$\\det \\begin{vmatrix} \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases} & 2 \\\\ 3 & 4 \\end{vmatrix}$$';
    assert.deepEqual(validateLatex(text).errors, []);
  });

  test('with $$ as a delimiter (I-1237), an environment is checked as part of its $$, never alone', () => {
    const valid = 'The sign is $$\\operatorname{sgn}(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x = 0 \\\\ -1 & x < 0 \\end{cases}$$ here.';
    assert.deepEqual(validateLatex(valid, WITH_DOLLARS).errors, []);
    const broken = 'The sign is $$\\operatorname{sgn}(x) = \\begin{cases} \\oops & x > 0 \\end{cases}$$ here.';
    const { errors } = validateLatex(broken, WITH_DOLLARS);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].position, broken.indexOf('$$'));
    assert.ok(errors[0].latex.startsWith('$$'), errors[0].latex);
  });

  test("environments KaTeX lacks keep today's check of their body", () => {
    // Their body is checked as math, as before; checking them whole would flag every one ("No such environment").
    const list = validateLatex('\\begin{itemize} \\item one \\end{itemize}');
    assert.match(list.errors[0].message, /Undefined control sequence: \\item/);
    assert.deepEqual(validateLatex('\\begin{theorem} Every bounded sequence converges \\end{theorem}').errors, []);
  });

  test('a custom delimiter for a KaTeX environment is checked whole too', () => {
    const gather = [{ left: '\\begin{gather}', right: '\\end{gather}', display: true }];
    assert.deepEqual(validateLatex('\\begin{gather} a = b \\\\ c = d \\end{gather}', gather).errors, []);
  });

  test('every environment the scan checks whole is one the installed KaTeX defines', () => {
    const katexError = (name) => {
      try {
        katex.renderToString(`\\begin{${name}}{1}x\\end{${name}}`, { displayMode: true, throwOnError: true });
        return '';
      } catch (error) {
        return error.message;
      }
    };
    assert.match(katexError('itemize'), /No such environment: itemize/);
    for (const name of KATEX_ENVIRONMENTS) {
      assert.doesNotMatch(katexError(name), /No such environment/, name);
    }
  });
});

describe('POST /validate/latex with a cases function in $$ (I-1691)', () => {
  let server;
  let base;

  before(async () => {
    const app = createApp({
      renderScreenshot: async () => 'AA==',
      validateAuth: (_req, _res, next) => next(),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => server.close());

  async function post(text) {
    const response = await fetch(`${base}/validate/latex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return { status: response.status, body: await response.json() };
  }

  test('answers valid, as KaTeX draws it', async () => {
    const text = '$$f(x)=\\begin{cases}x & x\\ge0\\\\-x & x<0\\end{cases}$$';
    assert.deepEqual(await post(text), { status: 200, body: { valid: true } });
  });

  test('still answers 400 for broken math in it', async () => {
    const answer = await post('$$f(x)=\\begin{cases}x & \\badcommand\\end{cases}$$');
    assert.equal(answer.status, 400);
    assert.equal(answer.body.errors[0].type, 'katex_error');
  });
});
