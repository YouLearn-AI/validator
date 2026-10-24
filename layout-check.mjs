// The layout check for a generated interactive (ops I-610, plan 012 in the youlearn hub).
//
// After the model writes an interactive, the backend sends its HTML here. The page is mounted the way the web app's
// modal shows it (a sandboxed srcdoc iframe in a dialog of 95vw x 95vh under a 52 px header), at a phone width (390,
// 2x, touch) and a desktop width (1280), both at once in two browser contexts. Text is measured, not judged by a
// vision model (round 3: DOM measurement found 16 of 22 human-marked defects on 8 pages and agreed on 8 of 8 pages):
//   overlap  - two pieces of text overlap (HTML, SVG <text>, and canvas fillText/strokeText, hooked before the page's
//              scripts)
//   cut      - text runs past the edge of its canvas, its SVG, a clipping (overflow hidden) box, or the screen
//   crossed  - canvas text drawn over strokes or edges, or SVG text crossed by another shape's stroke
//   covered  - canvas text painted over later, or SVG text under a shape drawn after it
//   wide     - the page is wider than the screen
// The page is measured 2.5, 4.5 and 6.5 s after its frame's load event; a finding counts when seen in 2 of the 3
// samples (a page-too-wide finding always counts). Then the page's first control is used once, as the clip renderer
// picks it (pickControl, video-renderer.mjs), and uncaught script errors are watched for 2 s more, so a repair that
// breaks a button shows. The answer: the findings (at most 20, in priority order), the script errors as fingerprints
// per width and phase, each width's screenshot with its findings boxed and numbered, and timings.
//
// The page runs in the GuardedBrowser (guarded-browser.mjs): the sandbox on and every request through the egress
// guard. Everything a page frame returns to Node is the page's own and may be forged (a page can replace the
// built-ins the measurement uses), so only checked types, clamped numbers and shortened strings pass. Logs carry
// codes, counts and times only: an error's message and the page's text go to the caller in the answer and never
// into a log line. One check at a time per instance; a hard deadline ends a check that runs too long.

import { createHash } from 'node:crypto';
import { errorCode } from './request-errors.mjs';
import { AVOID, PREFER, pickControl, sanitizeTarget } from './video-renderer.mjs';

export const CHECK_DEFAULTS = Object.freeze({
  widths: Object.freeze([390, 1280]),
  minWidth: 320,
  maxWidth: 1920,
  // Under this width the page is opened as on a phone: 844 px tall, 2 device pixels per CSS pixel, touch.
  phoneBelow: 768,
  // Sample moments after the frame's load event. Round 3's checker and the round-4 spike used these three; samples
  // ending at 4.5 s flagged a heart animation people judged clean (15 of 16 pages agreed instead of 16 of 16).
  samplesMs: Object.freeze([2500, 4500, 6500]),
  minSeen: 2,
  // A frame that has not fired its load event by then makes the answer "inconclusive" (the page ships as written).
  loadTimeoutMs: 8000,
  // After the control is used, how long script errors are still counted (the clip renderer films 3.6 s after its use).
  controlWatchMs: 2000,
  // A slider is moved this many steps with the arrow key after it is clicked.
  rangeSteps: 3,
  // The whole check; past it the answer is "timed_out". Load (8 s) + samples (6.5 s) + control (2 s) fits.
  deadlineMs: 20_000,
  // Closing the contexts after a check, before Chromium is reset when that stalls.
  teardownMs: 5000,
  maxFindings: 20,
  maxErrors: 10,
  shotQuality: 70,
});

// Finding types in the order they are sent and numbered: what students notice first.
export const FINDING_TYPES = Object.freeze(['overlap', 'cut', 'wide', 'covered', 'crossed']);
const TYPE_RANK = new Map(FINDING_TYPES.map((t, i) => [t, i]));
const MAX_SAMPLE_FINDINGS = 200;
const TEXT_MAX = 120;
const MESSAGE_MAX = 200;
const BOX_LIMIT = 100_000;

export class CheckBusy extends Error {
  constructor() {
    super('A check is already running on this instance');
    this.name = 'CheckBusy';
  }
}

/** A check that failed, named by stage and an allowlisted code only (a Playwright error quotes page text). */
export class CheckFailed extends Error {
  constructor(stage, code) {
    super(`Check failed at ${stage} (${code})`);
    this.name = 'CheckFailed';
    this.stage = stage;
    this.code = code;
  }
}

class CheckTimeout extends Error {
  constructor() {
    super('Check passed its deadline');
    this.name = 'CheckTimeout';
  }
}

class StepTimeout extends Error {}

// `promise`, or a StepTimeout after `ms`.
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new StepTimeout(`step over ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// Resolves at `at` (a Date.now() time), or rejects with CheckTimeout when the check is stopped first.
function waitUntil(at, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new CheckTimeout());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CheckTimeout());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, Math.max(0, at - Date.now()));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The browser context settings for a width: a phone under phoneBelow, else a desktop. */
export function profileFor(width, o = CHECK_DEFAULTS) {
  if (width < o.phoneBelow) {
    return { viewport: { width, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  }
  return { viewport: { width, height: 800 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
}

/** The widths a request asked for, checked: 1 or 2 distinct integers in [minWidth, maxWidth]; else null. */
export function parseWidths(raw, o = CHECK_DEFAULTS) {
  if (raw === undefined) return [...o.widths];
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 2) return null;
  if (!raw.every((w) => Number.isInteger(w) && w >= o.minWidth && w <= o.maxWidth)) return null;
  return new Set(raw).size === raw.length ? [...raw] : null;
}

// The host page: the web modal's dialog, the page's iframe (sandbox allow-scripts, as interactive-ui-modal.tsx
// mounts it), and an overlay for the numbered boxes on the screenshot. The iframe's opaque origin can't reach it.
const HOST = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>html,body{margin:0;height:100%;background:rgba(0,0,0,.8);font-family:-apple-system,system-ui,sans-serif}
.dlg{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:100%;height:100%;max-width:95vw;max-height:95vh;border-radius:12px;overflow:hidden;background:#fff;display:flex;flex-direction:column}
.hdr{flex-shrink:0;background:#f5f5f5;padding:12px 16px;height:28px}.body{flex:1;min-height:0;background:#fff}iframe{display:block;height:100%;width:100%;border:0}
#ov{position:fixed;inset:0;pointer-events:none;z-index:9}</style></head>
<body><div class="dlg"><div class="hdr"></div><div class="body"><iframe id="f" sandbox="allow-scripts"></iframe></div></div><div id="ov"></div></body></html>`;

// Runs in the host page: puts the page into the iframe and resolves on the frame's load event.
function mountPage(html) {
  return new Promise((resolve) => {
    const frame = document.getElementById('f');
    frame.addEventListener('load', () => resolve(), { once: true });
    frame.srcdoc = html;
  });
}

// Runs in the host page: draws each finding's box and number over the iframe (boxes in frame CSS px).
function drawBoxes({ boxes, left, top }) {
  const overlay = document.getElementById('ov');
  overlay.textContent = '';
  for (const { n, box } of boxes) {
    const mark = document.createElement('div');
    mark.style.cssText = `position:absolute;box-sizing:border-box;border:2px solid #e60000;left:${left + box[0] - 2}px;`
      + `top:${top + box[1] - 2}px;width:${box[2] - box[0] + 4}px;height:${box[3] - box[1] + 4}px`;
    const tag = document.createElement('span');
    tag.textContent = String(n);
    tag.style.cssText = `position:absolute;left:-2px;${box[1] < 16 ? 'top:0' : 'top:-16px'};background:#e60000;`
      + 'color:#fff;font:bold 12px/14px Arial,sans-serif;padding:0 3px';
    mark.appendChild(tag);
    overlay.appendChild(mark);
  }
}

// Runs in every frame before the page's scripts. Records each canvas text draw with its box in canvas pixels, the
// edge density of the pixels under it (before drawing) and a copy of its pixels just after drawing. A full-canvas
// clearRect/fillRect or a width/height reset forgets that canvas's earlier texts, so the list is what is on screen.
const HOOK = () => {
  if (window.__lc || window === window.top) return;
  const LC = (window.__lc = { texts: [], seq: 0, ids: new WeakMap(), n: 0, tainted: false });
  const P = CanvasRenderingContext2D.prototype;
  const cid = (cv) => { if (!LC.ids.has(cv)) LC.ids.set(cv, ++LC.n); return LC.ids.get(cv); };
  const forget = (cv) => { const id = cid(cv); LC.texts = LC.texts.filter((t) => t.canvas !== id); };
  const edgeFrac = (img, w, h) => {
    if (w < 3 || h < 3) return 0;
    const d = img.data, L = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) { const a = d[i * 4 + 3] / 255; L[i] = a * (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) + (1 - a) * 255; }
    let e = 0;
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) { const i = y * w + x; if (Math.abs(L[i + 1] - L[i]) + Math.abs(L[i + w] - L[i]) > 60) e++; }
    return e / ((w - 1) * (h - 1));
  };
  const box = (ctx, text, x, y, maxW) => {
    const m = ctx.measureText(text);
    let l = x - m.actualBoundingBoxLeft, r = x + m.actualBoundingBoxRight;
    if (maxW !== undefined && m.width > maxW && m.width > 0) { const s = maxW / m.width; l = x - m.actualBoundingBoxLeft * s; r = x + m.actualBoundingBoxRight * s; }
    const t = y - m.actualBoundingBoxAscent, b = y + m.actualBoundingBoxDescent;
    const T = ctx.getTransform();
    const pts = [[l, t], [r, t], [l, b], [r, b]].map(([px, py]) => [T.a * px + T.c * py + T.e, T.b * px + T.d * py + T.f]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  };
  const read = (ctx, bx) => {
    const cv = ctx.canvas, x0 = Math.max(0, Math.floor(bx[0])), y0 = Math.max(0, Math.floor(bx[1]));
    const x1 = Math.min(cv.width, Math.ceil(bx[2])), y1 = Math.min(cv.height, Math.ceil(bx[3]));
    if (x1 - x0 < 2 || y1 - y0 < 2 || LC.tainted) return null;
    try { return { img: ctx.getImageData(x0, y0, x1 - x0, y1 - y0), x0, y0, w: x1 - x0, h: y1 - y0 }; } catch { LC.tainted = true; return null; }
  };
  for (const k of ["fillText", "strokeText"]) {
    const orig = P[k];
    P[k] = function (text, x, y, maxW) {
      const s = String(text);
      if (!s.trim() || !this.canvas || !(this.canvas instanceof HTMLCanvasElement)) return orig.apply(this, arguments);
      let bx = null, under = null;
      try { bx = box(this, s, x, y, maxW); const r = read(this, bx); if (r) under = edgeFrac(r.img, r.w, r.h); } catch {}
      const out = orig.apply(this, arguments);
      if (bx) {
        const id = cid(this.canvas);
        // replace an earlier draw of the same text at the same spot (static labels redrawn each frame)
        LC.texts = LC.texts.filter((t) => !(t.canvas === id && t.full === s && Math.abs(t.box[0] - bx[0]) < 0.5 && Math.abs(t.box[1] - bx[1]) < 0.5));
        const after = read(this, bx);
        LC.texts.push({ seq: ++LC.seq, canvas: id, full: s, text: s.slice(0, 60), font: this.font, box: bx, under, after, ctx: this });
        if (LC.texts.length > 400) LC.texts.splice(0, LC.texts.length - 400);
      }
      return out;
    };
  }
  const full = (ctx, x, y, w, h) => {
    const T = ctx.getTransform(), cv = ctx.canvas;
    const x0 = T.a * x + T.e, y0 = T.d * y + T.f, x1 = T.a * (x + w) + T.e, y1 = T.d * (y + h) + T.f;
    return Math.abs(x1 - x0) * Math.abs(y1 - y0) >= 0.9 * cv.width * cv.height;
  };
  const cr = P.clearRect; P.clearRect = function (x, y, w, h) { if (this.canvas instanceof HTMLCanvasElement && full(this, x, y, w, h)) forget(this.canvas); return cr.apply(this, arguments); };
  const fr = P.fillRect; P.fillRect = function (x, y, w, h) { if (this.canvas instanceof HTMLCanvasElement && full(this, x, y, w, h)) forget(this.canvas); return fr.apply(this, arguments); };
  for (const dim of ["width", "height"]) {
    const d = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dim);
    Object.defineProperty(HTMLCanvasElement.prototype, dim, { get: d.get, set(v) { forget(this); d.set.call(this, v); }, configurable: true });
  }
};

// Runs inside the page frame at a sample moment; returns findings in frame CSS px.
function measure() {
  const W = document.documentElement.clientWidth, H = innerHeight;
  const out = [];
  const short = (s) => s.replace(/\s+/g, " ").trim().slice(0, 50);
  const desc = (el) => { if (!el) return "?"; let s = el.tagName.toLowerCase(); if (el.id) s += "#" + el.id; else if (el.classList && el.classList.length) s += "." + [...el.classList].slice(0, 2).join("."); return s; };
  const visible = (el) => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) < 0.15) return false; if (cs.clipPath && /inset\((50|100)%/.test(cs.clipPath)) return false; if (cs.position === "absolute" && cs.clip && cs.clip.startsWith("rect(0")) return false; } return true; };
  // clip rect of a label: the intersection of its own element (a text's container clips it too; a canvas's own box is
  // the canvas-edge check) and its ancestors with overflow other than visible, and any ancestor <svg>. Overflow does
  // not apply to inline boxes, so they never clip.
  const clips = new Map();
  const clipOf = (el, self) => {
    const memo = `${self}`;
    if (!clips.has(el)) clips.set(el, {});
    const cached = clips.get(el);
    if (cached[memo]) return cached[memo];
    let c = { l: -1e9, t: -1e9, r: 1e9, b: 1e9, by: null };
    for (let e = self ? el : el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === "inline") continue;
      const isSvgRoot = e.tagName.toLowerCase() === "svg" && cs.overflow !== "visible";
      const clips = isSvgRoot || ["hidden", "clip"].includes(cs.overflowX) || ["hidden", "clip"].includes(cs.overflowY);
      if (!clips) continue;
      const r = e.getBoundingClientRect();
      const nc = { l: Math.max(c.l, r.left), t: Math.max(c.t, r.top), r: Math.min(c.r, r.right), b: Math.min(c.b, r.bottom) };
      if (nc.r - nc.l < c.r - c.l || nc.b - nc.t < c.b - c.t) nc.by = desc(e); else nc.by = c.by;
      c = nc;
    }
    cached[memo] = c;
    return c;
  };
  const labels = [];
  // HTML and SVG text: one box per line fragment
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode())) {
    const t = n.data.trim(); if (!t || (t.match(/[\p{L}\p{N}]/gu) || []).length < 2) continue;
    const el = n.parentElement; if (!el || ["SCRIPT", "STYLE", "TITLE", "OPTION", "NOSCRIPT"].includes(el.tagName) || !visible(el)) continue;
    if (el.closest(".katex-mathml, .MathJax, mjx-assistive-mml")) continue;
    const rg = document.createRange(); rg.selectNodeContents(n);
    for (const r of rg.getClientRects()) {
      if (r.width < 2 || r.height < 2) continue;
      // the line box is taller than the ink: keep the band from 20% to 85% of its height (caps and x-height)
      labels.push({ kind: el instanceof SVGElement ? "svg" : "html", text: short(t), el, box: [r.left, r.top + 0.2 * r.height, r.right, r.bottom - 0.15 * r.height] });
    }
  }
  // canvas text from the hook, mapped to CSS px
  const LC = window.__lc;
  const canvases = [...document.querySelectorAll("canvas")];
  const cvById = new Map();
  if (LC) for (const cv of canvases) if (LC.ids.has(cv)) cvById.set(LC.ids.get(cv), cv);
  const changed = (a, b) => { // fraction of text pixels in `a` that differ now in `b`
    if (!a || !b || a.data.length !== b.data.length) return 0;
    let n = 0, ch = 0; for (let i = 0; i < a.data.length; i += 4) { n++; if (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]) + Math.abs(a.data[i + 3] - b.data[i + 3]) > 80) ch++; }
    return n ? ch / n : 0;
  };
  if (LC) for (const t of LC.texts) {
    if ((t.text.match(/[\p{L}\p{N}]/gu) || []).length < 2) continue; // particle glyphs (+, -, dots) and single letters
    const cv = cvById.get(t.canvas); if (!cv || !cv.isConnected || !visible(cv)) continue;
    const r = cv.getBoundingClientRect(); if (r.width < 4 || !cv.width) continue;
    const sx = r.width / cv.width, sy = r.height / cv.height;
    const b = [r.left + t.box[0] * sx, r.top + t.box[1] * sy, r.left + t.box[2] * sx, r.top + t.box[3] * sy];
    let cov = 0;
    if (t.after) { try { const now = t.ctx.getImageData(t.after.x0, t.after.y0, t.after.w, t.after.h); cov = changed(t.after.img, now); } catch {} }
    const cutBy = [];
    if (t.box[0] < -1 || t.box[2] > cv.width + 1 || t.box[1] < -1 || t.box[3] > cv.height + 1) cutBy.push("the canvas edge");
    labels.push({ kind: "canvas", text: short(t.text), el: cv, cvbox: true, box: b, under: t.under, covered: cov, cutBy, seq: t.seq });
  }
  // the part of each label that can be seen: its box inside its clip rect and the screen's width (null: none)
  for (const L of labels) {
    const c = clipOf(L.el, L.kind !== "canvas");
    const v = [Math.max(L.box[0], c.l, 0), Math.max(L.box[1], c.t), Math.min(L.box[2], c.r, W), Math.min(L.box[3], c.b)];
    L.vis = v[2] - v[0] > 1 && v[3] - v[1] > 1 ? v : null;
  }
  // cut text
  for (const L of labels) {
    const [l, t, r, b] = L.box;
    if (L.kind === "canvas" && L.cutBy.length) { out.push({ type: "cut", where: L.cutBy[0], text: L.text, kind: L.kind, box: L.box }); continue; }
    const c = clipOf(L.el, L.kind !== "canvas");
    const vis = { l: Math.max(c.l, 0), r: Math.min(c.r, W), t: c.t, b: c.b };
    const outX = Math.max(0, vis.l - l) + Math.max(0, r - vis.r), outY = Math.max(0, c.t - t) + Math.max(0, b - c.b);
    if (b < c.t || t > c.b || r < vis.l || l > vis.r) continue; // fully hidden (scrolled away in a clipped box): not a visible defect
    if (outX > 2 || outY > 3) out.push({ type: "cut", where: (r > W || l < 0) && !(c.r < W && c.l > 0) ? "the screen edge" : (c.by || "a clipping box"), text: L.text, kind: L.kind, box: L.box, by_px: Math.round(Math.max(outX, outY)) });
  }
  // overlaps between texts from different elements / draw calls
  const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i], b = labels[j];
    if (a.el === b.el && a.kind !== "canvas") continue;
    if (a.kind === "canvas" && b.kind === "canvas" && a.seq === b.seq) continue;
    if (a.kind !== "canvas" && b.kind !== "canvas" && (a.el.contains(b.el) || b.el.contains(a.el))) continue;
    // the parts that can be seen: text clipped away by an overflow box is not painted where its box says
    const av = a.vis, bv = b.vis;
    if (!av || !bv) continue;
    const ix = Math.min(av[2], bv[2]) - Math.max(av[0], bv[0]), iy = Math.min(av[3], bv[3]) - Math.max(av[1], bv[1]);
    if (ix <= 1 || iy <= 2) continue;
    const frac = (ix * iy) / Math.max(1, Math.min(area(av), area(bv)));
    if (frac > 0.15) out.push({ type: "overlap", text: `${a.text} | ${b.text}`, kind: `${a.kind}+${b.kind}`, box: [Math.min(av[0], bv[0]), Math.min(av[1], bv[1]), Math.max(av[2], bv[2]), Math.max(av[3], bv[3])], frac: +frac.toFixed(2) });
  }
  // canvas text crossed by drawing under it, or covered by drawing after it
  for (const L of labels.filter((x) => x.kind === "canvas" && x.vis)) {
    if (L.covered > 0.25) out.push({ type: "covered", text: L.text, kind: "canvas", box: L.box, frac: +L.covered.toFixed(2), note: "painted over after the text was drawn" });
    else if (L.under != null && L.under > 0.06) out.push({ type: "crossed", text: L.text, kind: "canvas", box: L.box, frac: +L.under.toFixed(2), note: "drawn over lines or shape edges" });
  }
  // HTML text over a canvas: edge density of the canvas pixels under it
  for (const L of labels.filter((x) => x.kind === "html" && x.vis)) {
    const [l, t, r, b] = L.box, cx = (l + r) / 2, cy = (t + b) / 2;
    for (const cv of canvases) {
      const cr = cv.getBoundingClientRect();
      if (cx < cr.left || cx > cr.right || cy < cr.top || cy > cr.bottom || !cv.width) continue;
      if (L.el.compareDocumentPosition(cv) & Node.DOCUMENT_POSITION_FOLLOWING && getComputedStyle(cv).position === "static") continue;
      try {
        const ctx = cv.getContext("2d"); if (!ctx) continue;
        const sx = cv.width / cr.width, sy = cv.height / cr.height;
        const x0 = Math.max(0, Math.floor((l - cr.left) * sx)), y0 = Math.max(0, Math.floor((t - cr.top) * sy));
        const w = Math.min(cv.width - x0, Math.ceil((r - l) * sx)), h = Math.min(cv.height - y0, Math.ceil((b - t) * sy));
        if (w < 3 || h < 3) continue;
        const img = ctx.getImageData(x0, y0, w, h), d = img.data, Lm = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) { const a = d[i * 4 + 3] / 255; Lm[i] = a * (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) + (1 - a) * 255; }
        let e = 0; for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) { const i = y * w + x; if (Math.abs(Lm[i + 1] - Lm[i]) + Math.abs(Lm[i + w] - Lm[i]) > 60) e++; }
        const f = e / ((w - 1) * (h - 1));
        if (f > 0.06) out.push({ type: "crossed", text: L.text, kind: "html-over-canvas", box: L.box, frac: +f.toFixed(2), note: "sits on lines or shape edges of the canvas drawing" });
      } catch {}
    }
  }
  // SVG text crossed by strokes or partly covered by fills of other shapes in the same <svg>
  for (const L of labels.filter((x) => x.kind === "svg" && x.vis)) {
    const svg = L.el.ownerSVGElement || L.el.closest("svg"); if (!svg) continue;
    const [l, t, r, b] = L.box; const pts = [];
    for (let i = 1; i <= 7; i++) for (let j = 1; j <= 3; j++) pts.push([l + (r - l) * i / 8, t + (b - t) * j / 4]);
    const textEl = L.el.closest("text") || L.el;
    let worst = null;
    for (const g of svg.querySelectorAll("path,line,polyline,polygon,rect,circle,ellipse")) {
      if (g.closest("defs,clipPath,mask,marker,pattern,symbol") || !visible(g) || textEl.contains(g) || g.contains(textEl)) continue;
      const cs = getComputedStyle(g);
      const gr = g.getBoundingClientRect(); if (gr.right < l || gr.left > r || gr.bottom < t || gr.top > b) continue;
      const M = g.getScreenCTM(); if (!M) continue; const inv = M.inverse();
      const hasStroke = cs.stroke !== "none" && parseFloat(cs.strokeWidth) > 0 && parseFloat(cs.strokeOpacity) > 0.2;
      const hasFill = cs.fill !== "none" && parseFloat(cs.fillOpacity) > 0.35 && parseFloat(cs.opacity) > 0.35;
      let inStroke = 0, inFill = 0;
      for (const [x, y] of pts) {
        const p = new DOMPoint(x, y).matrixTransform(inv);
        try { if (hasStroke && g.isPointInStroke(p)) inStroke++; if (hasFill && g.isPointInFill(p)) inFill++; } catch {}
      }
      const after = textEl.compareDocumentPosition(g) & Node.DOCUMENT_POSITION_FOLLOWING;
      let kind = null;
      if (inStroke >= 2) kind = "crossed";
      else if (hasFill && inFill > 2 && inFill < pts.length - 2) kind = after ? "covered" : "crossed";
      else if (hasFill && after && inFill >= pts.length - 2) kind = "covered";
      if (kind && (!worst || inStroke + inFill > worst.n)) worst = { kind, n: inStroke + inFill, by: desc(g) };
    }
    if (worst) out.push({ type: worst.kind, text: L.text, kind: "svg", box: L.box, note: worst.kind === "covered" ? `under ${worst.by}` : `crossed by ${worst.by}` });
  }
  // page wider than the screen
  const sw = Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  if (sw > W + 1) {
    const wide = [...document.body.querySelectorAll("*")].filter((e) => { const r = e.getBoundingClientRect(); return r.right > W + 1 && r.width > 0 && visible(e); })
      .filter((e, _, all) => !all.some((o) => o !== e && o.contains(e))).slice(0, 4).map((e) => `${desc(e)} (${Math.round(e.getBoundingClientRect().width)} px wide, right edge at ${Math.round(e.getBoundingClientRect().right)})`);
    out.push({ type: "wide", text: `page is ${sw - W} px wider than the screen`, kind: "page", box: [W, 0, sw, H], note: wide.join("; ") });
  }
  return { W, H, scrollW: sw, labels: labels.length, canvasTexts: labels.filter((x) => x.kind === "canvas").length, tainted: !!(LC && LC.tainted), findings: out };
}

// Strings from the page: control characters out, shortened. Anything that isn't a string is empty.
function pageText(value, max) {
  if (typeof value !== 'string') return '';
  let out = '';
  for (const ch of value.slice(0, max * 2)) {
    const code = ch.codePointAt(0);
    out += code < 32 || code === 127 ? ' ' : ch;
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

function clampNumber(value) {
  return Number.isFinite(value) ? Math.round(Math.min(Math.max(value, -BOX_LIMIT), BOX_LIMIT)) : null;
}

/**
 * One sample as measure() reported it, checked in Node (a page can forge it): known finding types only, a box of
 * four finite numbers, short strings, at most MAX_SAMPLE_FINDINGS findings. Returns { viewportWidth, viewportHeight,
 * pageWidth, findings }.
 */
export function sanitizeSample(raw) {
  const sample = raw && typeof raw === 'object' ? raw : {};
  const findings = [];
  for (const f of Array.isArray(sample.findings) ? sample.findings.slice(0, MAX_SAMPLE_FINDINGS) : []) {
    if (!f || typeof f !== 'object' || !TYPE_RANK.has(f.type) || !Array.isArray(f.box) || f.box.length !== 4) continue;
    const box = f.box.map(clampNumber);
    if (box.some((v) => v === null)) continue;
    const kind = /^[a-z+-]{1,40}$/.test(f.kind) ? f.kind : 'unknown';
    findings.push({
      type: f.type,
      kind,
      text: pageText(f.text, TEXT_MAX),
      box,
      where: typeof f.where === 'string' ? pageText(f.where, TEXT_MAX) : null,
      note: typeof f.note === 'string' ? pageText(f.note, TEXT_MAX) : null,
    });
  }
  const size = (v) => (Number.isFinite(v) && v >= 0 ? Math.round(Math.min(v, BOX_LIMIT)) : 0);
  return {
    viewportWidth: size(sample.W),
    viewportHeight: size(sample.H),
    pageWidth: size(sample.scrollW),
    findings,
  };
}

/**
 * An uncaught page error as a record: its name (a plain identifier, else "Error"), the first line of its message
 * (shortened) and a fingerprint of the two. The message goes to the caller only, never into a log.
 */
export function errorRecord(error, phase) {
  const rawName = typeof error?.name === 'string' ? error.name : '';
  const name = /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(rawName) ? rawName : 'Error';
  const rawMessage = typeof error?.message === 'string' ? error.message : String(error ?? '');
  const firstLine = rawMessage.split('\n', 1)[0];
  const fp = createHash('sha256').update(`${name}\n${firstLine}`, 'utf8').digest('hex').slice(0, 12);
  return { phase, fp, name, message: pageText(firstLine, MESSAGE_MAX) };
}

/**
 * The findings to send: every width's persistent findings in priority order (type, then how many samples saw it,
 * then width order), at most `max`, numbered 1, 2, ... per width in that order (the numbers drawn on its screenshot).
 * @param {Map<number, object[]|null>} perWidth persistent findings per width, in the request's width order
 * @returns {{ ordered: object[], byWidth: Map<number, object[]> }}
 */
export function selectFindings(perWidth, max) {
  const widthOrder = [...perWidth.keys()];
  const all = [];
  for (const [width, list] of perWidth) for (const [i, f] of (list || []).entries()) all.push({ ...f, width, i });
  all.sort((a, b) => TYPE_RANK.get(a.type) - TYPE_RANK.get(b.type) || b.seen - a.seen
    || widthOrder.indexOf(a.width) - widthOrder.indexOf(b.width) || a.i - b.i);
  const byWidth = new Map(widthOrder.map((w) => [w, []]));
  const ordered = all.slice(0, max).map(({ i: _i, ...f }) => {
    const mine = byWidth.get(f.width);
    const numbered = { n: mine.length + 1, ...f };
    mine.push(numbered);
    return numbered;
  });
  return { ordered, byWidth };
}

// Each width's task reports its persistent findings once; all of them get the selection when the last one has.
function createGate(widths, max) {
  const reported = new Map();
  let release;
  const selection = new Promise((resolve) => { release = resolve; });
  return {
    selection,
    arrive(width, list) {
      if (!reported.has(width)) {
        reported.set(width, list);
        if (reported.size === widths.length) {
          release(selectFindings(new Map(widths.map((w) => [w, reported.get(w)])), max));
        }
      }
      return selection.then((s) => s.byWidth.get(width) || []);
    },
  };
}

/**
 * A checkLayout bound to one GuardedBrowser.
 * @param {import('./guarded-browser.mjs').GuardedBrowser} guardedBrowser
 * @param {{ options?: object, log?: Console }} [config]
 */
export function createLayoutChecker(guardedBrowser, { options = {}, log = console } = {}) {
  const o = { ...CHECK_DEFAULTS, ...options };
  let busy = false;

  // One width: open, load, sample, report to the gate, screenshot with the boxes, use the first control, watch.
  async function checkWidth(width, html, { signal, contexts, gate, progress }) {
    let arrived = false;
    try {
      progress.stage = 'open';
      const context = await guardedBrowser.newContext(profileFor(width, o));
      if (signal.aborted) {
        // The deadline passed while it opened: the teardown may have run already, so it is closed here.
        await within(context.close(), o.teardownMs).catch(() => {});
        throw new CheckTimeout();
      }
      contexts.push(context);
      await context.addInitScript(HOOK);
      const page = await context.newPage();
      // Distinct by phase and fingerprint as they come, so an error thrown every frame can't crowd out a new one.
      const errors = new Map();
      let phase = 'load';
      page.on('pageerror', (error) => {
        const record = errorRecord(error, phase);
        const key = `${record.phase}|${record.fp}`;
        if (!errors.has(key) && errors.size < o.maxErrors) errors.set(key, record);
      });
      await page.setContent(HOST, { waitUntil: 'load' });
      const frameElement = await page.$('#f');
      const frame = await frameElement.contentFrame();

      progress.stage = 'load';
      const tMount = Date.now();
      const loaded = await within(page.evaluate(mountPage, html), o.loadTimeoutMs).then(
        () => true,
        (error) => {
          if (error instanceof StepTimeout) return false;
          throw error;
        },
      );
      if (signal.aborted) throw new CheckTimeout();
      if (!loaded) {
        arrived = true;
        gate.arrive(width, null);
        return {
          width, loaded: false, loadMs: null, pageWidth: 0, wide: false, control: 'none', shot: null, persistentCount: 0,
          errors: [...errors.values()],
        };
      }
      const tLoad = Date.now();
      const loadMs = tLoad - tMount;

      progress.stage = 'sample';
      const seen = new Map();
      let last = sanitizeSample(null);
      // Wider than the screen at any sample: also when the cap leaves its finding out, the guard needs it.
      let wide = false;
      for (const [sample, ms] of o.samplesMs.entries()) {
        await waitUntil(tLoad + ms, signal);
        // A page that breaks the measurement (it replaced a built-in it uses) gives an empty sample.
        last = sanitizeSample(await frame.evaluate(measure).catch(() => null));
        if (last.viewportWidth > 0 && last.pageWidth > last.viewportWidth + 1) wide = true;
        for (const f of last.findings) {
          const key = `${f.type}|${f.kind}|${f.text}`;
          const entry = seen.get(key) || { ...f, seen: 0, sample: -1 };
          // Once per sample (two labels with the same text count once), with that sample's first box: the latest
          // box, since the screenshot is taken right after the last sample.
          if (entry.sample === sample) continue;
          seen.set(key, { ...entry, box: f.box, where: f.where, note: f.note, seen: entry.seen + 1, sample });
        }
      }
      const persistent = [...seen.values()].filter((f) => f.type === 'wide' || f.seen >= o.minSeen);
      arrived = true;
      const mine = await gate.arrive(width, persistent);
      if (signal.aborted) throw new CheckTimeout();

      progress.stage = 'screenshot';
      let shot = null;
      const frameBox = await frameElement.boundingBox();
      if (mine.length > 0 && frameBox) {
        await page.evaluate(drawBoxes, {
          boxes: mine.filter((f) => f.type !== 'wide').map((f) => ({ n: f.n, box: f.box })),
          left: frameBox.x,
          top: frameBox.y,
        });
        shot = (await page.screenshot({ type: 'jpeg', quality: o.shotQuality, clip: frameBox })).toString('base64');
        await page.evaluate(drawBoxes, { boxes: [], left: 0, top: 0 });
      }

      progress.stage = 'control';
      phase = 'control';
      const target = sanitizeTarget(
        await frame.evaluate(pickControl, { preferSource: PREFER.source, avoidSource: AVOID.source }).catch(() => null),
        last.viewportWidth || width,
        last.viewportHeight || 1,
      );
      let control = 'none';
      if (target && frameBox) {
        await page.mouse.click(frameBox.x + target.x, frameBox.y + target.y);
        control = target.kind;
        if (target.kind === 'range') for (let i = 0; i < o.rangeSteps; i += 1) await page.keyboard.press('ArrowRight');
      }
      await waitUntil(Date.now() + o.controlWatchMs, signal);
      return {
        width, loaded: true, loadMs, pageWidth: last.pageWidth, wide, control, shot, persistentCount: persistent.length,
        errors: [...errors.values()],
      };
    } finally {
      // A width that ends early (an error, the deadline) still reports, so the other width never waits on it.
      if (!arrived) gate.arrive(width, null);
    }
  }

  /**
   * Check the layout of `html` at `widths`. Resolves the answer the HTTP route returns (without `success`).
   * @throws {CheckBusy} another check is running here
   * @throws {CheckFailed} anything but the deadline, named by stage and code only
   */
  return async function checkLayout({ html, widths = [...o.widths] }) {
    if (busy) throw new CheckBusy();
    busy = true;
    const t0 = Date.now();
    const warm = guardedBrowser.running();
    const controller = new AbortController();
    const { signal } = controller;
    const contexts = [];
    const progress = { stage: 'launch' };
    const stopped = new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new CheckTimeout()), { once: true });
    });
    stopped.catch(() => {});
    const timer = setTimeout(() => controller.abort(), o.deadlineMs);
    let launchMs = 0;
    let work = Promise.resolve();
    try {
      let results;
      try {
        await Promise.race([guardedBrowser.browser(), stopped]);
        launchMs = Date.now() - t0;
        const gate = createGate(widths, o.maxFindings);
        work = Promise.all(widths.map((w) => checkWidth(w, html, { signal, contexts, gate, progress })));
        results = await Promise.race([work, stopped]);
        const { ordered } = await gate.selection;
        const status = results.every((r) => r.loaded) ? 'ok' : 'inconclusive';
        const errors = results.flatMap((r) => r.errors.map((e) => ({ width: r.width, ...e }))).slice(0, o.maxErrors);
        const answer = {
          status,
          warm,
          findings_total: results.reduce((sum, r) => sum + r.persistentCount, 0),
          findings: ordered.map(({ n, width, type, kind, text, box, where, note, seen }) => (
            { n, width, type, kind, text, box, where, note, seen })),
          errors,
          widths: Object.fromEntries(results.map((r) => [String(r.width), {
            loaded: r.loaded, load_ms: r.loadMs, page_width: r.pageWidth, wide: r.wide, control: r.control, shot: r.shot,
          }])),
          timings: { total_ms: Date.now() - t0, launch_ms: launchMs },
        };
        log.info(`[CHECK_LAYOUT] status=${status} widths=${widths.join(',')} findings=${ordered.length} `
          + `errors=${errors.length} loaded=${results.map((r) => Number(r.loaded)).join(',')} `
          + `load_ms=${results.map((r) => r.loadMs ?? '-').join(',')} control=${results.map((r) => r.control).join(',')} `
          + `warm=${warm} launch_ms=${launchMs} ms=${answer.timings.total_ms}`);
        return answer;
      } catch (error) {
        if (error instanceof CheckTimeout) {
          log.warn(`[CHECK_LAYOUT] status=timed_out stage=${progress.stage} warm=${warm} ms=${Date.now() - t0}`);
          return {
            status: 'timed_out', warm, findings_total: 0, findings: [], errors: [], widths: {},
            timings: { total_ms: Date.now() - t0, launch_ms: launchMs },
          };
        }
        // Its stage and code only: the error's message can quote the page.
        const code = errorCode(error);
        log.error(`[CHECK_LAYOUT] failed stage=${progress.stage} code=${code}`);
        throw new CheckFailed(progress.stage, code);
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      // Close the contexts within the teardown budget; a context that won't close (a page stuck in a loop holds
      // its renderer) ends with Chromium, and the next check launches a new one.
      const until = Date.now() + o.teardownMs;
      const closed = await within(Promise.all(contexts.map((c) => c.close().catch(() => {}))), o.teardownMs)
        .then(() => true, () => false);
      const ended = await within(work.then(() => {}, () => {}), Math.max(0, until - Date.now()))
        .then(() => true, () => false);
      if (!closed || !ended) {
        log.warn(`[CHECK_LAYOUT] teardown stalled (closed=${closed} ended=${ended}); resetting the browser`);
        await guardedBrowser.reset().catch(() => {});
      }
      busy = false;
    }
  };
}

