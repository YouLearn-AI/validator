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
//      thread that is terminated when the render's deadline passes. Its tables get a thin grid, as the chat's do,
//      a right-to-left table lays its columns out right to left (rightToLeftTables), and a part the page starts on
//      a new page (an answer key) starts a new page in Word too (pageBreaks).
// Nothing here parses the answer's text: the page draws it with the chat's components, and pandoc reads the
// page's HTML. Logs hold codes, counts and times only.

import { Worker } from 'node:worker_threads';

export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
// A .docx is a zip file.
export const DOCX_MAGIC = Buffer.from('PK\u0003\u0004', 'latin1');

// The bookmark wordSource gives each part the page starts on a new page; pageBreaks removes it once it placed the
// break. (pandoc renames a name that starts with "_", Word's hidden bookmarks: Word names start with a letter.)
export const PAGE_BREAK_BOOKMARK = 'export_page_break_';

export const WORD_LIMITS = Object.freeze({
  // wordSource runs in the page and can't import: the bookmark it names each new page's part with.
  pageBreakBookmark: PAGE_BREAK_BOOKMARK,
  // A picture's size in the file, in CSS pixels (pandoc reads them at 96 per inch): at most the text width of a
  // Letter or A4 page with pandoc's 1-inch margins (6.3 in) and its text height (9 in).
  maxWidth: 600,
  maxHeight: 860,
  // A picture taller than a page at that width (a long timeline) goes in as several pictures, one per page, cut
  // between its parts where it can be; no capture is larger than a page.
  // The most captures one file makes, and their total area in CSS pixels (about 40 pages at the print page's
  // width); the rest are left out and counted.
  maxPictures: 120,
  maxArea: 688 * 40_000,
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
 * pandoc, and the captures it names (picture-<n>.png), each a rectangle of the page in document coordinates.
 * Must stay self-contained: Playwright sends its source to the page.
 * @param {{ pageBreakBookmark: string, maxWidth: number, maxHeight: number, maxPictures: number,
 *   maxArea: number }} limits
 * @returns {{ html: string, pictures: { name: string, clip: { x: number, y: number, width: number,
 *   height: number } }[], skipped: number }}
 */
export function wordSource(limits) {
  const root = document.querySelector('.export-print') || document.body;
  // Right-to-left scripts: Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic Extended and their
  // presentation forms.
  const RTL = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/u;
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

  /** Where to cut a picture `height` tall into slices of at most `slice`: between its parts where it can. */
  const cuts = (element, top, height, slice) => {
    const parts = [...element.querySelectorAll('*')]
      .map((part) => part.getBoundingClientRect())
      .filter((box) => box.height > 0 && box.height < slice)
      .map((box) => [box.top - top, box.bottom - top]);
    const inside = (y) => parts.some(([a, b]) => a < y - 0.5 && y + 0.5 < b);
    const ends = [];
    for (let from = 0; height - from > slice;) {
      const limit = from + slice;
      const candidates = parts.flatMap(([a, b]) => [a, b]).filter((y) => y > from + slice / 2 && y <= limit);
      const cut = Math.floor([limit, ...candidates].filter((y) => !inside(y)).sort((a, b) => b - a)[0] ?? limit);
      ends.push(cut);
      from = cut;
    }
    ends.push(height);
    return ends;
  };

  // Each picture: its captures (one, or one per page for a tall one) and their size in the file.
  const groups = [];
  let captures = 0;
  let area = 0;
  let skipped = 0;
  const picture = (element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return;
    const scale = Math.min(1, limits.maxWidth / box.width);
    const slice = limits.maxHeight / scale;
    const ends = box.height > slice ? cuts(element, box.top, box.height, slice) : [box.height];
    if (captures + ends.length > limits.maxPictures || area + box.width * box.height > limits.maxArea) {
      skipped += 1;
      element.setAttribute('data-export-hidden', '');
      return;
    }
    const x = box.left + window.scrollX;
    const y = box.top + window.scrollY;
    const slices = ends.map((end, n) => {
      const from = n ? ends[n - 1] : 0;
      captures += 1;
      return {
        name: `picture-${captures - 1}.png`,
        clip: { x, y: y + from, width: box.width, height: end - from },
        size: [Math.round(box.width * scale), Math.round((end - from) * scale)],
      };
    });
    area += box.width * box.height;
    element.setAttribute('data-export-picture', String(groups.length));
    groups.push(slices);
  };
  for (const formula of formulas) {
    if (!formula.querySelector('math')) picture(formula);
  }
  for (const element of root.querySelectorAll(PICTURES)) {
    if (element.closest('[data-export-hidden], [data-export-picture], .katex')) continue;
    if (element.parentElement?.closest(PICTURES)) continue;
    picture(element);
  }
  for (const block of root.querySelectorAll(`${TEXT_BLOCKS}, ${TEXT_CELLS}`)) {
    if (!block.closest('[data-export-hidden], [data-export-picture]')) {
      block.setAttribute('data-export-dir', direction(block));
    }
  }
  // A part the page starts on a new page (its CSS break-before: an answer key): pandoc writes the element's id as a
  // bookmark before its first paragraph, and pageBreaks starts that paragraph on a new page.
  let breaks = 0;
  for (const element of root.querySelectorAll('*')) {
    if (element.closest('[data-export-hidden], [data-export-picture]')) continue;
    if (['page', 'left', 'right', 'recto', 'verso'].includes(getComputedStyle(element).breakBefore)) {
      element.setAttribute('data-export-break', String(breaks));
      breaks += 1;
    }
  }

  const copy = root.cloneNode(true);
  const MARKS = ['data-export-hidden', 'data-export-picture', 'data-export-dir', 'data-export-break'];
  for (const element of root.querySelectorAll(MARKS.map((name) => `[${name}]`).join(', '))) {
    for (const name of MARKS) element.removeAttribute(name);
  }
  for (const element of copy.querySelectorAll('[data-export-break]')) {
    element.setAttribute('id', `${limits.pageBreakBookmark}${element.getAttribute('data-export-break')}`);
    element.removeAttribute('data-export-break');
  }
  copy.querySelectorAll('[data-export-hidden], script, style, link, noscript, template').forEach((e) => e.remove());
  // dir="auto" is the browser's to resolve: pandoc keeps it on a heading, where it outweighs the direction the
  // heading's wrapper sets below, and Word then sets an Arabic title left to right. The wrappers carry it instead.
  for (const element of copy.querySelectorAll('[dir]')) {
    if (!['ltr', 'rtl'].includes(element.getAttribute('dir'))) element.removeAttribute('dir');
  }
  // A button is a control and is left out, unless it holds a picture: the chat draws an image whiteboard's pictures
  // as buttons that open a viewer (image-whiteboard.tsx); the picture stays, its button goes (Codex review).
  for (const button of copy.querySelectorAll('button')) {
    if (button.querySelector('[data-export-picture]')) button.replaceWith(...button.childNodes);
    else button.remove();
  }
  for (const marked of copy.querySelectorAll('[data-export-picture]')) {
    const images = groups[Number(marked.getAttribute('data-export-picture'))].map(({ name, size }) => {
      const img = document.createElement('img');
      img.setAttribute('src', name);
      img.setAttribute('width', String(size[0]));
      img.setAttribute('height', String(size[1]));
      img.setAttribute('alt', '');
      if (groups[Number(marked.getAttribute('data-export-picture'))].length === 1) return img;
      // Slices of one picture, each in its own paragraph: they stack, a page each.
      const paragraph = document.createElement('p');
      paragraph.append(img);
      return paragraph;
    });
    marked.replaceWith(...images);
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
  return { html: copy.innerHTML, pictures: groups.flat().map(({ name, clip }) => ({ name, clip })), skipped };
}

/** Each capture wordSource named, as PNG bytes, in its order: a rectangle of the page, never larger than a page. */
export async function wordPictures(page, pictures, timeout) {
  const captured = [];
  for (const { name, clip } of pictures) {
    // fullPage: the clip is in document coordinates, so a picture below the first screen is captured where it is.
    const bytes = await page.screenshot({ type: 'png', clip, fullPage: true, animations: 'disabled', timeout });
    captured.push({ name, bytes });
  }
  return captured;
}

/**
 * pandoc writes no right-to-left layout for a table (jgm/pandoc#7695: its columns run left to right in Word, though
 * each cell's text is right to left). This gives each table of word/document.xml whose paragraphs are mostly right to
 * left (wordSource set each cell's direction from its own text) the table property that lays its columns out right to
 * left, <w:bidiVisual />, after its style as OOXML orders them. Only pandoc's own markup is read: a cell's text is
 * escaped inside <w:t>, so it can't open or close a table.
 * @param {string} xml word/document.xml as pandoc wrote it
 * @returns {string} the same, each right-to-left table marked
 */
export function rightToLeftTables(xml) {
  const tables = [];
  const open = [];
  for (const match of xml.matchAll(/<w:tbl>|<\/w:tbl>/g)) {
    if (match[0] === '<w:tbl>') open.push(match.index);
    else if (open.length) tables.push([open.pop(), match.index]);
  }
  const marks = [];
  for (const [start, end] of tables) {
    // The table's own paragraphs: a table nested in it is judged on its own.
    let own = '';
    let from = start;
    for (const [innerStart, innerEnd] of tables.filter(([a, b]) => a > start && b < end).sort((x, y) => x[0] - y[0])) {
      if (innerStart < from) continue;
      own += xml.slice(from, innerStart);
      from = innerEnd;
    }
    own += xml.slice(from, end);
    const paragraphs = own.split(/(?=<w:p>|<w:p )/).slice(1).filter((p) => p.includes('<w:t'));
    const rtl = paragraphs.filter((p) => /<w:bidi\s*\/>/.test(p.split('</w:pPr>')[0])).length;
    if (!paragraphs.length || rtl * 2 <= paragraphs.length) continue;
    const props = xml.indexOf('<w:tblPr>', start);
    if (props < 0 || props > end) continue;
    const style = /^<w:tblStyle [^>]*\/>/.exec(xml.slice(props + '<w:tblPr>'.length));
    marks.push(props + '<w:tblPr>'.length + (style ? style[0].length : 0));
  }
  let out = xml;
  for (const at of marks.sort((a, b) => b - a)) out = `${out.slice(0, at)}<w:bidiVisual />${out.slice(at)}`;
  return out;
}

/**
 * pandoc has no page break, so each part the page starts on a new page (wordSource bookmarked it
 * PAGE_BREAK_BOOKMARK<n>) gets one here: its first paragraph starts a new page (<w:pageBreakBefore />, in the place
 * OOXML orders it: after the style, keepNext and keepLines), or, when the part opens with a table, a paragraph that
 * holds only a page break goes before it. The bookmark then goes, so the student's file has none of ours. Only
 * pandoc's own markup is read: text is escaped inside <w:t>, so it can't hold a bookmark.
 * @param {string} xml word/document.xml as pandoc wrote it
 * @returns {string} the same, each such part on a new page
 */
export function pageBreaks(xml) {
  const marks = [...xml.matchAll(/<w:bookmarkStart w:id="(\d+)" w:name="([^"]*)" \/>/g)]
    .filter((match) => match[2].startsWith(PAGE_BREAK_BOOKMARK));
  let out = xml;
  // Last mark first: each break goes in after its own mark, so the marks before it keep their places.
  for (const match of [...marks].reverse()) {
    const at = match.index + match[0].length;
    const rest = out.slice(at);
    const paragraph = /<w:p>|<w:p /.exec(rest);
    const table = rest.indexOf('<w:tbl>');
    if (!paragraph || (table >= 0 && table < paragraph.index)) {
      if (table < 0) continue;
      out = `${out.slice(0, at + table)}<w:p><w:r><w:br w:type="page" /></w:r></w:p>${out.slice(at + table)}`;
      continue;
    }
    const open = at + paragraph.index + rest.slice(paragraph.index).indexOf('>') + 1;
    if (out.startsWith('<w:pPr>', open)) {
      const props = open + '<w:pPr>'.length;
      const lead = /^(<w:pStyle [^>]*\/>)?(<w:keepNext\s*\/>)?(<w:keepLines\s*\/>)?/.exec(out.slice(props))[0];
      out = `${out.slice(0, props + lead.length)}<w:pageBreakBefore />${out.slice(props + lead.length)}`;
    } else {
      out = `${out.slice(0, open)}<w:pPr><w:pageBreakBefore /></w:pPr>${out.slice(open)}`;
    }
  }
  // Then our bookmarks go: each start tag is unique by its id, and so is its end.
  for (const [tag, id] of marks) out = out.replace(tag, '').replace(`<w:bookmarkEnd w:id="${id}" />`, '');
  return out;
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

  /** Ends the worker and fails what it holds (a render that passed its deadline); the next conversion starts a
   * new one. */
  async close() {
    const { worker } = this;
    this.worker = null;
    if (worker) await worker.terminate().catch(() => {});
  }
}
