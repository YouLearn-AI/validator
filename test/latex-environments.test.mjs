// A math environment KaTeX supports (cases, the matrices, array, align, equation) is checked whole inside math, its
// \begin and \end included (ops I-1691). The scan used to check only the rows between them, where '&' and '\\' are
// errors, so valid display math such as a cases function in $$ was flagged, and the backend rewrote the whole
// summary to "fix" it. Outside math, an environment is checked as the apps draw it (ops I-1237). Broken math inside
// an environment must still fail.

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

// How a summary carries display math: the backend's prompts ask for $$, and the apps also draw \[ \] and a bare
// equation or align. $$ and \[ \] draw an environment whole.
const PLACEMENTS = [
  ['inside $$', (math) => `The rule is\n\n$$${math}$$\n\nfor every case.`],
  ['inside \\[ \\]', (math) => `The rule is \\[${math}\\] for every case.`],
  ['bare', (math) => `The rule is\n\n${math}\n\nfor every case.`],
];

// Bare, the apps (frontend tokenizer.ts:307) draw an equation or align by its body alone, where the rows' '&' fail,
// and show a cases, matrix or array as text. The first error each gives bare, or null when the apps draw it.
const BARE_FIRST_ERROR = {
  cases: 'shown_as_text',
  matrix: 'shown_as_text',
  pmatrix: 'shown_as_text',
  bmatrix: 'shown_as_text',
  array: 'shown_as_text',
  align: 'katex_error',
  'align*': 'katex_error',
  equation: null,
};

// The defaults sent as custom delimiters, with $$ in front: the scan's list before I-1237, plus $$.
const WITH_DOLLARS = [{ left: '$$', right: '$$', display: true }, ...defaultDelimiters];

describe('KaTeX math environments are checked whole (I-1691)', () => {
  for (const [name, math] of ENVIRONMENTS) {
    for (const [where, place] of PLACEMENTS) {
      const expected = where === 'bare' ? BARE_FIRST_ERROR[name] : null;
      test(expected ? `${name} ${where} fails as the apps draw it (${expected})` : `valid ${name} ${where} passes`, () => {
        const { errors } = validateLatex(place(math));
        if (expected) assert.equal(errors[0]?.type, expected);
        else assert.deepEqual(errors, []);
      });
    }
  }

  for (const [name, math] of ENVIRONMENTS) {
    const close = `\\end{${name}}`;
    // In $$ on its own lines, the apps draw the math whole; braces that don't pair keep them from drawing it.
    const broken = [
      ['an unknown command', math.replace(close, `\\notacommand ${close}`), 'katex_error', /Undefined control sequence: \\notacommand/],
      ['an unclosed brace', math.replace(close, `\\frac{1}{2 ${close}`), 'shown_as_text', /LaTeX shown as text/],
      ['a stray closing brace', math.replace(close, `x} ${close}`), 'shown_as_text', /LaTeX shown as text/],
    ];
    for (const [fault, text, type, message] of broken) {
      test(`${name} with ${fault} still fails, inside $$ and bare`, () => {
        const inDollars = validateLatex(`\n$$${text}$$\n`);
        assert.equal(inDollars.errors[0].type, type);
        assert.match(inDollars.errors[0].message, message);
        assert.equal(validateLatex(text).isValid, false, text);
      });
    }
  }

  test('an unclosed environment fails', () => {
    const { errors } = validateLatex('$$\\begin{cases} x & y$$');
    assert.equal(errors[0].type, 'shown_as_text');
    assert.match(errors[0].message, /because a \\begin has no \\end/);
  });

  test('the error spans the whole $$ math the environment sits in', () => {
    const text = 'So $$\\begin{pmatrix} 1 & \\oops \\end{pmatrix}$$.';
    const [error] = validateLatex(text).errors;
    assert.equal(error.position, 3);
    assert.equal(error.latex, '$$\\begin{pmatrix} 1 & \\oops \\end{pmatrix}$$');
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

  test('with $$ as a custom delimiter, an environment is checked as part of its $$, never alone', () => {
    const valid = 'The sign is $$\\operatorname{sgn}(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x = 0 \\\\ -1 & x < 0 \\end{cases}$$ here.';
    assert.deepEqual(validateLatex(valid, WITH_DOLLARS).errors, []);
    const broken = 'The sign is $$\\operatorname{sgn}(x) = \\begin{cases} \\oops & x > 0 \\end{cases}$$ here.';
    const { errors } = validateLatex(broken, WITH_DOLLARS);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].position, broken.indexOf('$$'));
    assert.ok(errors[0].latex.startsWith('$$'), errors[0].latex);
  });

  test('with $$ as a custom delimiter, broken math around an environment in $$ fails too', () => {
    for (const text of ['$$\\oops \\begin{cases} x & y \\end{cases}$$', '$$\\begin{cases} x & y \\end{cases}}$$']) {
      const { errors } = validateLatex(text, WITH_DOLLARS);
      assert.equal(errors.length, 1, text);
      assert.equal(errors[0].position, 0, text);
    }
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
