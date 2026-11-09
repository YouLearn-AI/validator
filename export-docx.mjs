// A Word file (.docx) of what the print page drew (ops I-1313): the same parts the PDF prints, made editable.
//
// The renderer draws the document on the web app's print page exactly as for a PDF, then:
//   1. wordSource (run in the page) reads the drawn page into HTML that pandoc reads: math as KaTeX's own MathML,
//      which holds the TeX (pandoc writes it as a Word equation); each picture (a diagram, a timeline, an image,
//      anything drawn) marked to be captured; each block of text wrapped in a <div dir> set from its own first
//      strong letter, as the page's dir="auto" and unicode-bidi: plaintext set it (pandoc writes right-to-left
//      paragraphs and runs from that).
//   2. The renderer captures each marked picture as a PNG from the page (wordPictures).
//   3. A WordConverter turns HTML and pictures into a .docx with pandoc (export-docx-worker.mjs), in a worker
//      thread that is terminated when the render's deadline passes.
// Nothing here parses the answer's text: the page draws it with the chat's components, and pandoc reads the
// page's HTML. Logs hold codes, counts and times only.

import { Worker } from 'node:worker_threads';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// A .docx is a zip file.
export const DOCX_MAGIC = Buffer.from('PK\u0003\u0004', 'latin1');

export const WORD_LIMITS = Object.freeze({
  // A picture's size in the file, in CSS pixels (pandoc reads them at 96 per inch): at most the text width of a
  // Letter or A4 page with pandoc's 1-inch margins (6.3 in) and its text height (9 in), so a tall timeline fits
  // on one page.
  maxWidth: 600,
  maxHeight: 860,
  // The most pictures one file captures (each is a screenshot); the rest are left out and counted.
  maxPictures: 120,
  // Pictures are captured at twice their CSS size, so they stay sharp when printed.
  deviceScaleFactor: 2,
});

export class WordFailed extends Error {
  constructor(code) {
    super(`Word conversion failed (${code})`);
    this.name = 'WordFailed';
    this.code = code;
  }
}

/**
 * Runs in the print page (page.evaluate) after it drew the document. Returns the drawn document as HTML for
 * pandoc, and the pictures to capture, each marked on the page with data-export-picture="<n>" and named
 * picture-<n>.png in the HTML. Must stay self-contained: Playwright sends its source to the page.
 * @param {{ maxWidth: number, maxHeight: number, maxPictures: number }} limits
 * @returns {{ html: string, pictures: { index: number, name: string }[], skipped: number }}
 */
export function wordSource(limits) {
  const root = document.querySelector('.export-print') || document.body;
  // Right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic Extended and their
  // presentation forms.
  const RTL = /[֐-ࣿיִ-﷿ﹰ-﻿]/u;
  const LETTER = /\p{L}/u;
  const PICTURES = 'figure, img, svg, canvas, video, picture';
  const TEXT_BLOCKS = 'p, h1, h2, h3, h4, h5, h6, blockquote, pre';
  const TEXT_CELLS = 'li, td, th, dt, dd, figcaption';

  // Hidden on the page (a diagram's controls, a collapsed part): left out of the file too.
  for (const element of root.querySelectorAll('*')) {
    if (getComputedStyle(element).display === 'none') element.setAttribute('data-export-hidden', '');
  }

  // Math: KaTeX's MathML holds the TeX the student saw, which pandoc reads into a Word equation. A formula
  // KaTeX drew without MathML is captured as a picture.
  const formulas = [...root.querySelectorAll('.katex-display, .katex')].filter(
    (element) => !element.parentElement?.closest('.katex-display, .katex'),
  );

  /** The direction a block's own text sets, as dir="auto": its first letter outside math, else its parent's. */
  const direction = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.parentElement?.closest('.katex, [data-export-hidden]')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const char of node.data) {
        if (LETTER.test(char)) return RTL.test(char) ? 'rtl' : 'ltr';
      }
    }
    return getComputedStyle(element).direction === 'rtl' ? 'rtl' : 'ltr';
  };

  const pictures = [];
  let skipped = 0;
  const picture = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    if (pictures.length >= limits.maxPictures) {
      skipped += 1;
      return;
    }
    const scale = Math.min(1, limits.maxWidth / box.width, limits.maxHeight / box.height);
    const index = pictures.length;
    element.setAttribute('data-export-picture', String(index));
    element.setAttribute('data-export-size', `${Math.round(box.width * scale)}x${Math.round(box.height * scale)}`);
    pictures.push({ index, name: `picture-${index}.png` });
  };
  for (const formula of formulas) {
    if (!formula.querySelector('math')) picture(formula);
  }
  for (const element of root.querySelectorAll(PICTURES)) {
    if (element.closest('[data-export-hidden], .katex') || element.parentElement?.closest(PICTURES)) continue;
    picture(element);
  }
  for (const block of root.querySelectorAll(`${TEXT_BLOCKS}, ${TEXT_CELLS}`)) {
    if (!block.closest('[data-export-hidden], [data-export-picture]')) {
      block.setAttribute('data-export-dir', direction(block));
    }
  }

  const copy = root.cloneNode(true);
  for (const element of root.querySelectorAll('[data-export-hidden], [data-export-picture], [data-export-dir]')) {
    element.removeAttribute('data-export-hidden');
    element.removeAttribute('data-export-dir');
  }
  copy.querySelectorAll('[data-export-hidden], script, style, link, noscript, template, button').forEach((e) => e.remove());
  for (const marked of copy.querySelectorAll('[data-export-picture]')) {
    const [width, height] = marked.getAttribute('data-export-size').split('x');
    const img = document.createElement('img');
    img.setAttribute('src', `picture-${marked.getAttribute('data-export-picture')}.png`);
    img.setAttribute('width', width);
    img.setAttribute('height', height);
    img.setAttribute('alt', '');
    marked.replaceWith(img);
  }
  for (const formula of copy.querySelectorAll('.katex-display, .katex')) {
    if (formula.parentElement?.closest('.katex-display, .katex')) continue;
    const math = formula.querySelector('math');
    if (math) formula.replaceWith(math);
  }
  for (const block of copy.querySelectorAll('[data-export-dir]')) {
    const wrapper = document.createElement('div');
    wrapper.setAttribute('dir', block.getAttribute('data-export-dir'));
    block.removeAttribute('data-export-dir');
    if (block.matches(TEXT_CELLS)) {
      wrapper.append(...block.childNodes);
      block.append(wrapper);
    } else {
      block.replaceWith(wrapper);
      wrapper.append(block);
    }
  }
  return { html: copy.innerHTML, pictures, skipped };
}

/** Each picture wordSource marked, as PNG bytes, in its order. */
export async function wordPictures(page, pictures, timeout) {
  const captured = [];
  for (const { index, name } of pictures) {
    const bytes = await page.locator(`[data-export-picture="${index}"]`).screenshot({
      type: 'png', animations: 'disabled', timeout,
    });
    captured.push({ name, bytes });
  }
  return captured;
}

const WORKER_URL = new URL('./export-docx-worker.mjs', import.meta.url);
// pandoc's own heap is WebAssembly memory, outside these limits; the deadline bounds a conversion's time.
const WORKER_LIMITS = Object.freeze({ maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 64 });

/**
 * pandoc in a worker thread, started on first use and kept warm; terminated (and started again on the next
 * conversion) when one passes its time or fails.
 */
export class WordConverter {
  constructor({ workerUrl = WORKER_URL } = {}) {
    this.workerUrl = workerUrl;
    this.worker = null;
    this.next = 0;
    this.pending = new Map();
  }

  start() {
    const worker = new Worker(this.workerUrl, { resourceLimits: WORKER_LIMITS });
    worker.on('message', ({ id, bytes, missing, code }) => {
      const job = this.pending.get(id);
      if (!job) return;
      this.settle(id);
      if (code) job.reject(new WordFailed(code));
      else job.resolve({ docx: Buffer.from(bytes), missing });
    });
    // A worker that dies (out of memory, a crash) fails what it held, and only that; the next conversion starts a
    // new one.
    const fail = () => {
      if (this.worker === worker) this.worker = null;
      for (const [id, job] of [...this.pending]) {
        if (job.worker !== worker) continue;
        this.settle(id);
        job.reject(new WordFailed('worker_died'));
      }
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    this.worker = worker;
    return worker;
  }

  settle(id) {
    clearTimeout(this.pending.get(id)?.timer);
    this.pending.delete(id);
  }

  /**
   * @param {{ html: string, pictures: { name: string, bytes: Buffer }[], language: string }} source
   * @param {number} timeoutMs the time it may take; past it the worker is terminated
   * @returns {Promise<{ docx: Buffer, missing: number }>}
   */
  convert({ html, pictures, language }, timeoutMs) {
    const worker = this.worker || this.start();
    this.next += 1;
    const id = this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(id);
        reject(new WordFailed('timeout'));
        if (this.worker === worker) this.worker = null;
        worker.terminate().catch(() => {});
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, worker });
      const images = pictures.map(({ name, bytes }) => ({ name, bytes: new Uint8Array(bytes) }));
      worker.postMessage({ id, html, images, metadata: { lang: language } });
    });
  }

  async close() {
    const { worker } = this;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => {});
  }
}
