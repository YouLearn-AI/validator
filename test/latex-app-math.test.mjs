// Without custom delimiters, POST /validate/latex reads a text as the web and mobile apps draw it (ops I-1237):
// app-math.mjs ports their shared math scan. The backend asks summaries for $$ math only, and the scan before this
// had no $$ delimiter, so broken $$ math passed and students saw it raw. Most tests below give a verdict the scan
// before I-1237 (validator 1b2c5e8) gets wrong; the passing controls (currency, shell variables, Markdown emphasis)
// pass on both and guard against false alarms. The inputs are synthetic.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../app.mjs';
import { validateLatex } from '../latex-validator.mjs';
import {
  appMathScan, BLOCK_ENVIRONMENTS, findCitations, INLINE_ENVIRONMENTS, isSpace, MATH_DELIMITERS, SOURCE_PATTERN,
} from '../app-math.mjs';

const types = (text) => validateLatex(text).errors.map((error) => error.type);

describe('math in $$, as the apps draw it (I-1237)', () => {
  test('broken math inside $$ fails', () => {
    for (const text of ['So $$\\oops x$$ here.', 'So $$\\frac{a}$$ here.', '$$\n\\sqrt[3]{x}^{\n$$']) {
      const { errors } = validateLatex(text);
      assert.equal(errors.length > 0, true, text);
    }
    assert.deepEqual(types('So $$\\oops x$$ here.'), ['katex_error']);
  });

  test('valid math inside $$ passes, in a line and on its own lines', () => {
    assert.deepEqual(validateLatex('So $$x^2 + \\frac{1}{2}$$ here.').errors, []);
    assert.deepEqual(validateLatex('So\n$$\n\\int_0^1 x\\,dx = \\tfrac{1}{2}\n$$\nhere.').errors, []);
  });

  test('$$ math whose braces or brackets do not pair is shown as text', () => {
    // The apps reject the structure before KaTeX sees it (tokenizer.ts isValidMathStructure), so the student sees
    // "$$x^{2$$" as typed. The closing $$ then opens nothing.
    const { errors } = validateLatex('So $$x^{2$$ here.');
    assert.deepEqual(errors.map((error) => error.type), ['shown_as_text', 'unclosed']);
    assert.equal(errors[0].position, 3);
    assert.match(errors[0].message, /because a \{ or \[ is never closed/);
    assert.match(validateLatex('$$a} + b$$').errors[0].message, /because a \} or \] has no matching/);
    assert.match(validateLatex('$$a ** b$$').errors[0].message, /because it holds "\*\*"/);
  });

  test('a lone bracket written as \\lbrack or \\rbrack passes', () => {
    assert.deepEqual(validateLatex('On $$\\lbrack 0, 1)$$ it holds.').errors, []);
  });

  test('$$ never closes across a blank line', () => {
    const { errors } = validateLatex('So\n\n$$a = b\n\nc = d$$\n\nhere.');
    assert.deepEqual(errors.map((error) => error.type), ['unclosed', 'unclosed']);
    assert.match(errors[0].message, /the apps never close \$\$ across a blank line/);
  });

  test('a $$ pair inside a line is drawn inline, so an environment that needs display mode fails there', () => {
    const math = '$$\\begin{align} a &= b \\end{align}$$';
    assert.deepEqual(types(`The sum ${math} holds.`), ['katex_error']);
    assert.match(validateLatex(`The sum ${math} holds.`).errors[0].message, /can be used only in display mode/);
    assert.deepEqual(validateLatex(`The sum\n${math}\nholds.`).errors, []);
  });

  test('a citation inside math is removed before the check, as the apps do', () => {
    assert.deepEqual(validateLatex('$$\\frac{a}{b}【3, source: "x}"】$$').errors, []);
    assert.deepEqual(validateLatex('$$E = mc^2 【12】$$').errors, []);
    assert.deepEqual(types('$$\\frac{a}{b} x}$$'), ['shown_as_text', 'unclosed']);
  });
});

describe('bare environments, as the apps draw them (I-1237)', () => {
  test('a bare equation or align-family environment is drawn by its body alone', () => {
    assert.deepEqual(validateLatex('Then\n\\begin{equation} E = mc^2 \\end{equation}\nholds.').errors, []);
    const align = 'Then\n\\begin{align} a &= b \\\\ c &= d \\end{align}\nholds.';
    const { errors } = validateLatex(align);
    assert.deepEqual(errors.map((error) => error.type), ['katex_error']);
    assert.match(errors[0].message, /The apps draw a bare \\begin\{align\} by its body alone: put it inside \$\$ \.\.\. \$\$/);
  });

  for (const name of ['cases', 'matrix', 'pmatrix', 'bmatrix', 'array', 'vmatrix', 'Bmatrix', 'dcases', 'smallmatrix']) {
    test(`a bare ${name} is shown as text`, () => {
      const body = name === 'array' ? '{cc} a & b \\\\ c & d' : 'a & b \\\\ c & d';
      const { errors } = validateLatex(`Then \\begin{${name}}${body} \\end{${name}} holds.`);
      assert.deepEqual(errors.map((error) => error.type), ['shown_as_text']);
      assert.equal(errors[0].position, 5);
      assert.match(errors[0].message, /is outside math, and the apps draw it only inside \$\$ \.\.\. \$\$/);
    });
  }

  test('an environment KaTeX lacks is not an error for being bare', () => {
    assert.deepEqual(validateLatex('\\begin{theorem} Every bounded sequence converges \\end{theorem}').errors, []);
  });
});

describe('math between single dollars is shown as text (I-1237)', () => {
  // Both apps call the tokenizer with singleDollarMath false, so $...$ is never math there.
  for (const text of [
    'Half is $\\frac{1}{2$ here.', 'So $\\foo{x}$ here.', 'So $x^2$ here.', 'Let $a_1$ be the first.', 'So $2^{10}$ bytes.',
    'Then $A^T A$ is square.', 'The solution is $2^x + C$.', 'So $2 \\times X$ here.', 'So $2^n I$ here.',
  ]) {
    test(`${JSON.stringify(text)} fails`, () => {
      assert.deepEqual(types(text), ['shown_as_text']);
    });
  }

  test('an escaped dollar inside the math does not end it', () => {
    const { errors } = validateLatex('$x^2+\\$5$');
    assert.deepEqual(errors.map(({ type, latex }) => [type, latex]), [['shown_as_text', '$x^2+\\$5$']]);
  });

  for (const text of [
    'Costs $5 and $10.', 'From $5-$10 a day.', 'It is \\$5 or \\$x^2\\$.', 'A $ sign and a ^ caret.', 'Pay $3, get $x',
    'Set $HOME_DIR/$USER_NAME first.', 'Use $HOME_DIR/$USER for the path.', 'Price: $5 _each_ (US$).', '$$x$$',
    'The rate is $5/m^2 (US$).', 'Rent is $12/m^2, or HK$9 a day.', '| Price ($/m^2) | Total ($) |\n| --- | --- |\n| 5 | 100 |',
  ]) {
    test(`${JSON.stringify(text)} passes`, () => {
      assert.deepEqual(validateLatex(text).errors, []);
    });
  }
});

describe('code is code (I-1237)', () => {
  test('LaTeX inside inline or fenced code is not checked', () => {
    assert.deepEqual(validateLatex('Type `\\(` to open math.').errors, []);
    assert.deepEqual(validateLatex('```\n\\begin{cases} x\n$$x^{$$\n```\nDone.').errors, []);
    assert.deepEqual(types('Type `\\(` then \\( alone.'), ['unclosed']);
  });

  test('a citation inside code is removed before code is found, as the apps do, which can end a code span', () => {
    // Without the citation, "``" opens a span that " `" closes, and the $$ after it is math.
    const { errors } = validateLatex('`【3】` `$$\\oops$$`');
    assert.deepEqual(errors.map(({ type, position, latex }) => [type, position, latex]), [['katex_error', 7, '$$\\oops$$']]);
  });
});

describe('citations, as the apps read them (I-1237)', () => {
  test('findCitations finds what the apps\' pattern finds, in whole texts and slices', () => {
    // Random near-citations: each field present or not, quoted or not, values that hold the characters the
    // pattern stops at, and closings that are missing or doubled. 600,000 such texts agreed when this was written.
    let seed = 1237;
    const random = (n) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return Math.floor((seed / 0x80000000) * n);
    };
    const pick = (list) => list[random(list.length)];
    const noise = ['', ' ', '\n', '】', ',', '"', '【', 'a', '1', '-', '.', ':', '　'];
    const values = ['', ' ', '  ', '1', '1, 2', '1.5,-2 ', ' , ', '"a"', '"a】b"', '"', '""', 'a】', 'x,y', ' \n', ', source: s'];
    const citation = () => {
      let text = `【${pick(['1', 'a b', ' ', '', 'x【', '"', '1 '])}`;
      for (let i = random(4); i > 0; i--) {
        text += pick([', type:', ', bbox:', ', source:', ',type:', ', bbox :', ',']) + pick(values);
      }
      return text + pick(['', ' ', '  ']) + pick(['】', '】', '', ',', '"】', '】】']);
    };
    const byPattern = (text) => [...text.matchAll(SOURCE_PATTERN)].map((m) => [m.index, m.index + m[0].length]);
    let found = 0;
    for (let n = 0; n < 20_000; n++) {
      let text = '';
      for (let i = 1 + random(3); i > 0; i--) text += pick(noise) + citation() + pick(noise);
      const from = random(3) === 0 ? random(text.length + 1) : 0;
      const limit = random(3) === 0 ? from + random(text.length - from + 1) : text.length;
      const want = byPattern(text.slice(from, limit)).map(([start, end]) => [start + from, end + from]);
      assert.deepEqual(findCitations(text, from, limit), want, JSON.stringify([text, from, limit]));
      found += want.length;
    }
    assert.ok(found > 5_000, `only ${found} citations in the sample`);
  });

  test('isSpace is the patterns\' \\s for every UTF-16 code unit', () => {
    for (let code = 0; code <= 0xffff; code++) {
      assert.equal(isSpace(code), /\s/.test(String.fromCharCode(code)), `U+${code.toString(16)}`);
    }
  });

  test('what a citation outside math holds is drawn as a source chip, not checked as LaTeX', () => {
    assert.deepEqual(validateLatex('As 【3, source: "Use $$ for math"】 says.').errors, []);
    assert.deepEqual(validateLatex('【3, source: "$x^2$ and \\begin{cases}"】').errors, []);
    assert.deepEqual(types('Use $$ here 【3, source: "x"】.'), ['unclosed']);
  });

  test('what a citation removed from code held is not checked as prose', () => {
    // Without its citations, "```【3】```" closes as one fence, and the second span's text is gone with its citation.
    assert.deepEqual(validateLatex('```【3】``` `【3, source: "$x^2$"】`').errors, []);
  });

  test('single-dollar math around a source chip is still shown as text', () => {
    for (const [text, latex] of [['Let $x^2【3】$ be the area.', '$x^2【3】$'], ['Let $【3】x^2$ be.', '$【3】x^2$']]) {
      const { errors } = validateLatex(text);
      assert.deepEqual(errors.map(({ type, position, latex: quoted }) => [type, position, quoted]), [['shown_as_text', 4, latex]]);
    }
  });

  test('math the scan finds inside a citation is drawn, since the apps find math before citations', () => {
    assert.deepEqual(types('【3, source: "$$\\oops$$"】'), ['katex_error']);
  });

  test('a citation of any length is removed from math', () => {
    for (const length of [510, 5_000]) {
      assert.deepEqual(validateLatex(`$$x 【3, source: "${'a'.repeat(length)}}"】$$`).errors, [], String(length));
    }
  });

  test('openers inside source chips count toward the stop at 50, and a text the check did not finish is not valid', () => {
    const result = validateLatex(`【1, source: "${'\\( '.repeat(60)}"】 and $$\\oops$$`);
    assert.deepEqual(result, { isValid: false, errors: [], truncated: true });
  });
});

// Where plain $$ pairing (each $$ with the next) places math differently from the apps: E-40700 found 3 of 109
// environments in a week's 25 repaired summaries, all three a pmatrix the apps draw inside $$ after $$ they refuse
// (a blank line, braces that don't pair), where plain pairing put it outside. These rebuild that shape and the
// others with made-up math.
describe('environments the apps place differently from plain $$ pairing (I-1237, E-40700)', () => {
  test('after a $$ the apps refuse, they draw the next $$ pair, where plain pairing puts the matrix outside', () => {
    const text = 'The cost is $$\n\nso $$A = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$$ in all.';
    const math = [...appMathScan(text)].filter(({ kind }) => kind === 'math');
    assert.deepEqual(math.map(({ start, end }) => text.slice(start, end)), [text.slice(text.indexOf('$$', 13), -8)]);
    const { errors } = validateLatex(text);
    assert.deepEqual(errors.map(({ type, position }) => [type, position]), [['unclosed', 12]]);
    assert.match(errors[0].message, /across a blank line/);
  });

  test('a $$ block with a blank line inside leaves its matrix as text', () => {
    const text = 'Let\n$$\nA = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\n\nB = A^2$$\nhere.';
    assert.deepEqual(types(text), ['unclosed', 'shown_as_text', 'unclosed']);
  });

  test('a half-open interval inside $$ keeps the apps from drawing its cases', () => {
    const text = 'Then $$f(x) = \\begin{cases} 1 & x \\in [0, 1) \\\\ 0 & \\text{otherwise} \\end{cases}$$ here.';
    assert.deepEqual(types(text), ['shown_as_text', 'shown_as_text', 'unclosed']);
    assert.match(validateLatex(text).errors[1].message, /\\begin\{cases\} at position 14 is outside math/);
  });

  test('an earlier $$ the apps refuse shifts the pairs, and a later cases ends up bare', () => {
    // The refused $$[0, 1)$$ leaves its closing $$ to open math up to the next $$, which was meant to open the cases.
    const text = 'On $$[0, 1)$$ we set $$g(x) = \\begin{cases} x & x > 0 \\\\ 0 & x \\le 0 \\end{cases}$$ here.';
    const parts = [...appMathScan(text)].map(({ kind, start, end }) => [kind, start, end]);
    assert.deepEqual(parts, [['refused', 3, 13], ['math', 11, 23], ['refused', 80, undefined]]);
    assert.deepEqual(types(text), ['shown_as_text', 'shown_as_text', 'unclosed']);
  });
});

// The pin: the frontend commit and files the port follows, and the lists they hold. The hub monitor's sweep compares
// the pin and these lists with the frontend's main; this test keeps the port and the pin together.
const PIN = JSON.parse(readFileSync(new URL('./fixtures/frontend-math.json', import.meta.url), 'utf8'));

describe('the port keeps the apps\' lists and order', () => {
  test('the environment lists are the pinned frontend\'s', () => {
    assert.deepEqual(BLOCK_ENVIRONMENTS, PIN.BLOCK_ENVIRONMENTS);
    assert.deepEqual(INLINE_ENVIRONMENTS, PIN.INLINE_ENVIRONMENTS);
  });

  test('$$ first, then \\[ and \\(, then the bare environments; the first that matches wins', () => {
    assert.deepEqual(
      MATH_DELIMITERS.map(({ open, display }) => [open, display]),
      [
        ['$$', true],
        ['\\[', true],
        ['\\(', false],
        ...PIN.BLOCK_ENVIRONMENTS.map((env) => [`\\begin{${env}}`, true]),
        ...PIN.INLINE_ENVIRONMENTS.map((env) => [`\\begin{${env}}`, false]),
      ],
    );
  });
});

describe('POST /validate/latex reads text as the apps draw it (I-1237)', () => {
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

  async function post(body) {
    const response = await fetch(`${base}/validate/latex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  test('the backend\'s request (text only) fails broken $$ math', async () => {
    for (const text of ['$$x^{2$$', '$\\frac{1}{2$', '$\\foo{x}$']) {
      const answer = await post({ text });
      assert.equal(answer.status, 400, text);
      assert.equal(answer.body.errors[0].type, 'shown_as_text', text);
    }
  });

  test('valid $$ math passes', async () => {
    assert.deepEqual(await post({ text: '$$\\sum_{i=1}^n i = \\frac{n(n+1)}{2}$$' }), { status: 200, body: { valid: true } });
  });

  test('custom delimiters keep the scan they name', async () => {
    const answer = await post({ text: '$$x^{2$$', delimiters: [{ left: '\\(', right: '\\)', display: false }] });
    assert.deepEqual(answer, { status: 200, body: { valid: true } });
  });
});
