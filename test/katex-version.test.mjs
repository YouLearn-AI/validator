// The check runs the KaTeX the web app draws with (frontend pnpm-lock.yaml: katex 0.19.0), so it refuses only what
// the app can't draw (ops I-515). KaTeX 0.16.22 read a middle dot in \text{} as the math command \cdotp and refused
// it ("Undefined control sequence: \cdotp"); 0.16.39 fixed that (KaTeX #3641). On 2026-11-17 the backend's formula
// repair got such a formula, the model's fix kept the dot, and 0.16.22 refused the fix, so the summary kept it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import katex from 'katex';
import { validateLatex } from '../latex-validator.mjs';

test('the check runs the KaTeX the web app draws with', () => {
  assert.equal(katex.version, '0.19.0');
});

test('a middle dot in \\text{} passes, as the web app draws it', () => {
  assert.deepEqual(validateLatex('The product \\(\\text{a·b}\\) is defined.').errors, []);
  assert.deepEqual(validateLatex('So \\(\\frac{\\text{x·y}}{2}\\) holds.').errors, []);
});

test('a middle dot in math mode still passes, and an unknown command still fails', () => {
  assert.deepEqual(validateLatex('\\(a·b\\)').errors, []);
  const broken = validateLatex('\\(\\text{a·b} \\oops\\)');
  assert.equal(broken.errors.length, 1);
  assert.match(broken.errors[0].message, /Undefined control sequence: \\oops/);
});
