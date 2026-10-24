// A short looping clip of an interactive, for og:video in share-link previews (ops I-609).
//
// Filmed like the research harness (docs/research/product/2026-10-22-i609-og-video, record.mjs and encode.sh in
// the youlearn hub): a 1200x630 viewport (1920x1008 filmed at 0.625, the same pixels, for a page whose docked
// panels cover 30% or more of it), Playwright's fake clock paused so that every frame is exactly 1/30 s
// of page time after the one before (1/15 or 1/10 s for a page too slow to film at 30), whatever the screenshot
// costs. CSS animations and transitions are not driven by that clock: their timeline is held still (CDP
// Animation.setPlaybackRate 0) and each step moves the Web Animations on by the same page time. The page is
// shown as loaded, then the first control is used (the I-610 rule: a button whose label
// says play/start/launch/..., else the first slider, else the first button, else the largest canvas or svg; never
// a button that says pause/stop/reset/clear, which would stop what the page already shows), then the clip runs on. A motion check drops a clip whose frames don't change. The last 0.3 s fade back into
// frame 0, so the clip loops without a jump. H.264 High, yuv420p, faststart, no audio: what iMessage plays.
//
// The clock runs frame by frame (runFor fires every 16 ms animation frame on the way) while that is cheap, as it
// is for most pages: then frame 0 shows the page settleMs after load with its fades and eases done (generated pages
// mostly clamp a frame's time step, to 50 ms say, so one jump would leave them at their start). A page whose
// frames are expensive (a WebGL scene drawn in software: ~280 ms a draw on a Mac, 94 draws for the settle alone,
// ops I-609) is moved with fastForward instead, which fires each timer that falls due at most once per step: one
// draw per filmed frame. Its page-time animations are where they would be; a clamped or fixed per-frame step moves
// once per filmed frame. When the first frames show the clip can't be filmed by the deadline, it drops to 15 or 10
// frames a second, then gets shorter; when even the shortest clip can't be filmed, the answer is the first frame
// and reason "too_slow", a final answer like "no_motion".
//
// The page runs in the GuardedBrowser (guarded-browser.mjs): the sandbox on and every request through the
// egress guard. Its URL must be public http(s) (checkUrl). One render at a time per instance; a hard deadline
// ends a render that runs too long, its browser context and its ffmpeg with it.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkUrl, UrlRefused } from './egress-guard.mjs';
import { errorCode } from './request-errors.mjs';

export const VIDEO_DEFAULTS = Object.freeze({
  // The clip, in pixels.
  width: 1200,
  height: 630,
  // A page laid out for a taller screen can dock panels over its scene (position: fixed). When they cover
  // dockedShare or more of the clip's viewport after the settle, the page is loaded again in a viewport
  // dockedLayoutScale times the clip and filmed at 1/dockedLayoutScale device pixels per CSS pixel: the clip is
  // still width x height pixels, and the panels take a smaller share of it (one interactive's control panel: 45% of
  // the frame at 1200x630, about 18% at 1920x1008, ops I-609). Every other page is filmed as before: in the larger
  // layout a page centred in a max-width column shrinks, its motion with it, and a render takes 1.3-2x as long.
  dockedShare: 0.3,
  dockedLayoutScale: 1.6,
  fps: 30,
  // The slower frame rates a clip may drop to when the page draws too slowly to film every frame by the deadline;
  // each divides fps, so the frames already filmed hold every frame of the slower clip.
  slowerFps: [15, 10],
  // The shortest clip worth sending, once the slowest frame rate can't film the whole clip either.
  minSeconds: 2.0,
  // Frames filmed and timed before the frame rate may drop.
  probeFrames: 3,
  // Kept from the deadline for what follows the filming: closing the page, the motion check and the encode
  // (about 5 s for 120 frames on Cloud Run's 2 vCPU, ops I-609).
  reserveMs: 10_000,
  beforeSeconds: 0.4, // the page as loaded
  afterSeconds: 3.6, // after the interaction; the clip is before + after = 4.0 s
  fadeSeconds: 0.3, // the tail fades into frame 0
  // Page time after load before frame 0. CSS animations are held still while the page loads, so reveal
  // animations need it: at 1500 ms frame 0 matched the share thumbnail on the I-610 set (SSIM 0.990-1.000;
  // at 500 ms one page was still fading in, SSIM 0.80).
  settleMs: 1500,
  // Real time the settle may take frame by frame; a page that would take longer jumps the rest of the settle with
  // one fastForward, and its frames are stepped that way too. A canvas page settles in 0.5-1.3 s on a Mac.
  // (Three runFor frames of a three.js page took 22 s on a loaded Mac, one fastForward 1.5 s, ops I-609.)
  settleBudgetMs: 3000,
  crf: 24,
  preset: 'medium',
  jpegQuality: 80,
  // The filmed frames go to ffmpeg as JPEG, not PNG: a PNG of a busy canvas took 167 ms against 56 ms (ops I-609,
  // a projectile interactive on a Mac), and its 120 PNGs passed the deadline on Cloud Run's 2 vCPU.
  frameQuality: 90,
  // Motion check: a frame moves when its mean change of luma (ffmpeg signalstats YDIF, 0-255) is over
  // motionThreshold, or when motionMinBlocks or more blocks of a motionGrid have more than motionBlockShare of their
  // pixels changed in luma by more than motionPixelLuma. The first catches a moving shape; the second faint motion
  // spread over the frame that the mean misses, such as particles flowing on a diagram beside a pulsing 3D heart
  // (5-28 blocks a frame at YDIF 0.09-2.3, ops I-609). Something smaller than a block (75x79 px), a spinner, a
  // ticking digit or a caret, touches at most 4 and stays under both. A clip needs minMovingFrames.
  motionThreshold: 0.3,
  motionGrid: Object.freeze({ cols: 16, rows: 8 }),
  motionBlockShare: 0.01,
  motionPixelLuma: 12,
  motionMinBlocks: 5,
  minMovingFrames: 3,
  maxrate: '4M',
  bufsize: '8M',
  maxBytes: 9_000_000, // iMessage downloads a clip only under 10 MB in all (TN3156)
  gotoTimeoutMs: 30_000,
  deadlineMs: 85_000,
  // The whole teardown after a render (or its deadline): release, wait, kill if needed, remove the frames.
  // deadlineMs + teardownMs + a browser reset (it waits at most 15 s for a launch under way,
  // guarded-browser.mjs) = 115 s, under the service's 120 s request timeout.
  teardownMs: 15_000,
});

const FFMPEG_KILL_GRACE_MS = 2_000;

const PREFER = /\b(play|start|run|launch|fire|step|next|search|go|check|begin|animate|simulate|throw|shoot|explore|try|balance|compare)\b/i;
// A control that stops or clears what the page shows is never pressed: a heart interactive's first button was
// "⏸ Pause", and the clip of it paused had no motion (ops I-609).
const AVOID = /⏸|⏹|\b(pause|stop|halt|freeze|reset|clear)\b/i;

export class RenderBusy extends Error {
  constructor() {
    super('A render is already running on this instance');
    this.name = 'RenderBusy';
  }
}

/**
 * A render that failed for another reason. Its message names only the stage and an allowlisted code: the
 * underlying error (a Playwright error quotes the URL and page text) is never kept.
 */
export class RenderFailed extends Error {
  constructor(stage, code) {
    super(`Render failed at ${stage} (${code})`);
    this.name = 'RenderFailed';
    this.stage = stage;
    this.code = code;
  }
}

class FfmpegFailed extends Error {
  constructor(result) {
    super(`ffmpeg ended (${result})`);
    this.name = 'FfmpegFailed';
  }
}

export class RenderTimeout extends Error {
  constructor(ms) {
    super(`Render exceeded ${ms} ms`);
    this.name = 'RenderTimeout';
  }
}

// Runs in the page: pause the running Web Animations (CSS animations and transitions included) and move the
// ones this renderer paused on by dt milliseconds. An animation the page paused itself is left alone.
function stepAnimations(dt) {
  const owned = (window.__i609OwnedAnimations ||= new WeakSet());
  for (const animation of document.getAnimations()) {
    if (animation.playState === 'running') {
      animation.pause();
      owned.add(animation);
    }
    if (dt > 0 && owned.has(animation) && animation.playState === 'paused') {
      animation.currentTime = (Number(animation.currentTime) || 0) + dt;
    }
  }
}

// Runs in the page: the control to use, as the I-610 harness picks it.
function pickControl({ preferSource, avoidSource }) {
  const prefer = new RegExp(preferSource, 'i');
  const avoid = new RegExp(avoidSource, 'i');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.top >= 0 && r.left >= 0
      && r.top + r.height / 2 < innerHeight && r.left + r.width / 2 < innerWidth;
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.tagName)
    .trim().replace(/\s+/g, ' ').slice(0, 60);
  const BUTTONS = 'button,[role=button],input[type=button],input[type=submit]';
  const buttons = [...document.querySelectorAll(BUTTONS)].filter(visible).filter((b) => !b.disabled && !avoid.test(label(b)));
  let el = buttons.find((b) => prefer.test(label(b)));
  let kind = 'button';
  if (!el) {
    const range = [...document.querySelectorAll('input[type=range]')].filter(visible)[0];
    if (range) { el = range; kind = 'range'; }
  }
  if (!el && buttons.length) el = buttons[0];
  if (!el) {
    const area = (e) => e.getBoundingClientRect().width * e.getBoundingClientRect().height;
    const surface = [...document.querySelectorAll('canvas,svg')].filter(visible).filter((e) => !e.closest(BUTTONS))
      .sort((a, b) => area(b) - area(a))[0];
    if (surface) { el = surface; kind = 'canvas/svg'; }
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  // Nothing is pressed when an avoided control lies over that point (a pause button over the canvas).
  const hit = document.elementFromPoint(x, y)?.closest(BUTTONS);
  if (hit && avoid.test(label(hit))) return null;
  // The label stays in the page: it is the page's text, and nothing outside needs it.
  return { kind, x, y };
}

// Runs in the page: the share of the viewport (0-1) whose topmost element is in a docked panel, a box with
// position fixed that covers less than `maxBox` of the viewport (a full-screen fixed canvas is the scene, not a
// panel). Sampled at the centres of a cols x rows grid. A sticky box is not counted: unscrolled, as filmed, it sits
// in the page's flow (a sticky sidebar measured 31% on one page, and the larger layout cost its clip its motion).
function dockedShareOf({ maxBox, cols, rows }) {
  const docked = new Map();
  const inPanel = (el) => {
    if (!el || el === document.documentElement || el === document.body) return false;
    if (!docked.has(el)) {
      let value;
      if (getComputedStyle(el).position === 'fixed') {
        const r = el.getBoundingClientRect();
        value = r.width * r.height < maxBox * innerWidth * innerHeight || inPanel(el.parentElement);
      } else {
        value = inPanel(el.parentElement);
      }
      docked.set(el, value);
    }
    return docked.get(el);
  };
  let hits = 0;
  for (let i = 0; i < cols; i += 1) {
    for (let j = 0; j < rows; j += 1) {
      if (inPanel(document.elementFromPoint(((i + 0.5) * innerWidth) / cols, ((j + 0.5) * innerHeight) / rows))) hits += 1;
    }
  }
  return hits / (cols * rows);
}

/** The share dockedShareOf reported, checked in Node (a page can tamper with it): a number in [0, 1], else 0. */
export function sanitizeShare(raw) {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.min(Math.max(raw, 0), 1) : 0;
}

// Runs a command and settles only once it has exited. On abort it gets SIGTERM, then SIGKILL after a grace.
const CONTROL_KINDS = new Set(['button', 'range', 'canvas/svg']);

/**
 * The control pickControl reported, checked in Node: a page can tamper with what an evaluate returns, so only a
 * known kind and a finite point (clamped to the viewport) pass; anything else is no control.
 */
export function sanitizeTarget(raw, width, height) {
  if (!raw || typeof raw !== 'object' || !CONTROL_KINDS.has(raw.kind)) return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { kind: raw.kind, x: Math.min(Math.max(x, 0), width - 1), y: Math.min(Math.max(y, 0), height - 1) };
}

/**
 * What is left to film, so that the filming ends in the time it has (ops I-609). Frames sit on a grid of ticks of
 * 1/fps s; a clip at `stride` is every stride-th tick of [0, end). `next` is the first tick not filmed yet,
 * `frameMs` the cost of one more frame (its screenshot and its step of the clock), `msLeft` the time left to film.
 * The whole clip at the fastest frame rate that can film it in time. Else a shorter clip: the frames filmed so far
 * when no more fit, else as many as fit at the slowest frame rate (the longest clip, and the most room if frames
 * get slower). Null when that is under `minTicks`. Only a stride that is a multiple of the current one can be
 * taken: the frames filmed so far must hold every tick of the slower grid.
 * @param {{ next: number, stride: number, end: number, frameMs: number|null, msLeft: number }} now
 * @param {{ strides: number[], minTicks: number }} limits
 * @returns {{ stride: number, end: number } | null}
 */
export function fitCapture({ next, stride, end, frameMs, msLeft }, { strides, minTicks }) {
  const options = strides.filter((s) => s >= stride && s % stride === 0).sort((x, y) => x - y);
  const first = (s) => Math.ceil(next / s) * s; // the first tick still to film on the grid of stride s
  const whole = (s) => Math.floor(end / s) * s; // the end of the whole clip on that grid
  const fit = frameMs > 0 ? Math.max(0, Math.floor(msLeft / frameMs)) : Infinity; // frames that fit
  const fastest = options.find((s) => first(s) + fit * s >= whole(s));
  if (fastest) return { stride: fastest, end: whole(fastest) };
  const cut = fit === 0 ? stride : options[options.length - 1];
  const last = Math.min(whole(cut), first(cut) + fit * cut);
  return last >= minTicks ? { stride: cut, end: last } : null;
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;

function run(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let killTimer;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), FFMPEG_KILL_GRACE_MS);
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', () => {}); // ffmpeg's messages can name page-derived files; never kept
    child.on('error', () => {}); // a failed spawn is followed by 'close'
    child.on('close', (code, sig) => {
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      if (code === 0) resolve(stdout);
      else reject(new FfmpegFailed(code ?? sig));
    });
  });
}

/**
 * The motion of the frames in `dir`, frame by frame from the second: `ydif`, the mean absolute luma change from
 * the frame before (0-255), and `blocks`, how many blocks of a cols x rows grid have more than `blockShare` of their
 * pixels changed in luma by more than `luma`.
 */
async function motionOf(ffmpeg, dir, fps, { luma, blockShare, grid }, signal) {
  const input = ['-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.jpg')];
  const values = (out, key) => [...out.matchAll(new RegExp(`lavfi\\.signalstats\\.${key}=([0-9.]+)`, 'g'))].map((m) => Number(m[1]));
  const ydif = values(await run(ffmpeg, [...input,
    '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-', '-f', 'null', '-'], { signal }), 'YDIF');
  // The difference of each frame from the one before, white where it is over `luma`, averaged over each block
  // (area scaling to the grid), then white where a block's share is over `blockShare`: the mean, times the number of
  // blocks, is the count.
  const cells = grid.cols * grid.rows;
  const blocks = values(await run(ffmpeg, [...input,
    '-vf', `format=gray,tblend=all_mode=difference,lut=y='if(gt(val,${luma}),255,0)',scale=${grid.cols}:${grid.rows}:flags=area,`
      + `lut=y='if(gt(val,${255 * blockShare}),255,0)',signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-`,
    '-f', 'null', '-'], { signal }), 'YAVG').map((v) => Math.round((v / 255) * cells));
  // signalstats gives the first frame a YDIF of 0; tblend starts at the second frame.
  return { ydif: ydif.slice(1), blocks };
}

/**
 * Encodes the frames f0000.jpg... in `dir` as the looping clip (exported for its tests).
 * The fade ends exactly on the last frame, which is then frame 0 itself, so the loop wraps from frame 0 to
 * frame 0 (a one-frame hold) with nothing of the end left in it. The fade is a whole number of frames (0.3 s is
 * 4.5 frames at 15 fps, and a fade that ends between two frames left a fifth of the end in the last one). The
 * fading-in input needs one frame past the fade for xfade to reach it.
 */
export async function encodeLoop(ffmpeg, dir, frames, fps, o, signal) {
  const fade = Math.max(1, Math.round(o.fadeSeconds * fps)) / fps;
  const offset = ((frames - 1) / fps - fade).toFixed(6);
  const tail = (fade + 1 / fps).toFixed(6);
  const out = path.join(dir, 'clip.mp4');
  const graph = [
    // JPEG frames are full range; players expect the limited range of yuv420p (else the clip is yuvj420p).
    `[0:v]scale=in_range=pc:out_range=tv,settb=1/${fps},format=yuv444p[a]`,
    `[1:v]scale=in_range=pc:out_range=tv,settb=1/${fps},format=yuv444p,trim=duration=${tail}[b]`,
    `[a][b]xfade=transition=fade:duration=${fade.toFixed(6)}:offset=${offset},format=yuv420p[v]`,
  ].join(';');
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(fps), '-i', path.join(dir, 'f%04d.jpg'),
    '-loop', '1', '-framerate', String(fps), '-i', path.join(dir, 'f0000.jpg'),
    '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames),
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', o.preset, '-crf', String(o.crf), '-tune', 'animation',
    // A ceiling for pages full of noise: 4 s at 4 Mbit/s is about 2 MB, under iMessage's 10 MB.
    '-maxrate', o.maxrate, '-bufsize', o.bufsize,
    '-r', String(fps), '-movflags', '+faststart', '-an', out,
  ], { signal });
  return fs.readFile(out);
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

/**
 * A renderVideo bound to one GuardedBrowser.
 * @param {import('./guarded-browser.mjs').GuardedBrowser} guardedBrowser
 * @param {{ ffmpeg?: string, checkOptions?: object, options?: object, log?: Console }} [config]
 */
export function createVideoRenderer(guardedBrowser, { ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', checkOptions = {}, options = {}, log = console } = {}) {
  const o = { ...VIDEO_DEFAULTS, ...options };
  if (!(Number.isFinite(o.dockedLayoutScale) && o.dockedLayoutScale >= 1)) throw new Error('dockedLayoutScale must be a number >= 1');
  if (!(typeof o.dockedShare === 'number' && o.dockedShare > 0)) throw new Error('dockedShare must be a number > 0');
  // A layout: the CSS viewport the page is laid out in, and the device pixels per CSS pixel that film it at the
  // clip's size.
  const layoutAt = (scale) => {
    const viewport = { width: Math.round(o.width * scale), height: Math.round(o.height * scale) };
    return { viewport, deviceScaleFactor: o.width / viewport.width };
  };
  const CLIP_LAYOUT = layoutAt(1);
  const DOCKED_LAYOUT = layoutAt(o.dockedLayoutScale);
  const DOCKED_SAMPLE = { maxBox: 0.6, cols: 60, rows: 32 };
  let busy = false;

  // What one render holds, released once, last first, each step within o.teardownMs. A resource acquired
  // after the render was stopped is released at once.
  function createScope(signal) {
    const disposers = [];
    let closed = false;
    return {
      async own(resource, dispose) {
        if (closed || signal.aborted) {
          await within(dispose(resource), o.teardownMs).catch(() => {});
          throw new RenderTimeout(o.deadlineMs);
        }
        disposers.push(() => dispose(resource));
        return resource;
      },
      check() {
        if (signal.aborted) throw new RenderTimeout(o.deadlineMs);
      },
      // Releases everything within the time left before `until` (an absolute time); false if a step stalled.
      async close(until) {
        closed = true;
        let stalled = false;
        while (disposers.length) {
          const dispose = disposers.pop();
          const ok = await within(Promise.resolve().then(dispose), Math.max(0, until - Date.now()))
            .then(() => true, (e) => !(e instanceof StepTimeout));
          if (!ok) stalled = true;
        }
        return !stalled;
      },
    };
  }

  // Frames are filmed on a grid of ticks of 1/fps s; a slower clip films every stride-th tick.
  const strides = [o.fps, ...o.slowerFps].map((f) => o.fps / f);
  if (!strides.every((s) => Number.isInteger(s) && s >= 1)) throw new Error('Each slower fps must divide fps');
  // The cost of a frame is the mean of the last few: one draw's work can land in its step or in the next
  // screenshot (WebGL draws asynchronously), so one frame alone says little.
  const COST_FRAMES = 10;
  const SETTLE_FIRST_SLICE_MS = 32;
  const SLIDER_STEPS = 12;
  const SLIDER_EVERY_TICKS = 3;
  const tickName = (tick) => `t${String(tick).padStart(4, '0')}.jpg`;
  const frameName = (i) => `f${String(i).padStart(4, '0')}.jpg`;

  const settledMs = Math.round(o.settleMs);

  // Opens the page in `layout` with its clock paused before its first script, loads it and settles it to
  // settledMs. Returns the context, the page, and whether the page is cheap enough to step frame by frame.
  async function load(url, layout, scope, progress) {
    progress.stage = 'open';
    scope.check();
    const context = await scope.own(await guardedBrowser.newContext(layout), (c) => c.close());
    const page = await context.newPage();
    // CSS animations and transitions don't follow the fake clock. Their timeline is held still from the first
    // document on (playback rate 0); stepAnimations moves them on with the page's clock.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    // The page's clock is paused before its first script runs, so timers and requestAnimationFrame move only
    // with runFor or fastForward: however long the load takes, frame 0 is the same page time after it.
    const epoch = o.epochMs ?? Math.floor(Date.now() / 1000) * 1000;
    await page.clock.install({ time: epoch });
    // A whole second ahead, so the paused time doesn't depend on how long install took.
    await page.clock.pauseAt(epoch + 1000);
    progress.stage = 'navigate';
    await page.goto(url, { waitUntil: 'networkidle', timeout: o.gotoTimeoutMs });
    progress.stage = 'settle';
    await page.evaluate(() => document.fonts && document.fonts.ready);
    scope.check();
    // Whole milliseconds throughout: fastForward drops the fraction (Playwright 1.64 takes `ticks | 0`), and the
    // Web Animations move by the same amount, so the two clocks stay together.
    let everyFrame = true; // runFor while the page is cheap, else fastForward
    const advance = (ms) => (everyFrame ? page.clock.runFor(ms) : page.clock.fastForward(ms));
    let pageMs = 0;
    const tSettle = Date.now();
    await page.evaluate(stepAnimations, 0);
    // Slices that double from two animation frames, so the first one, one or two draws, already tells a slow page:
    // frame by frame only while the whole settle, at the rate so far, stays within its budget.
    for (let slice = SETTLE_FIRST_SLICE_MS; pageMs < settledMs; slice *= 2) {
      scope.check();
      const spent = Date.now() - tSettle;
      if (pageMs > 0 && spent + (spent / pageMs) * (settledMs - pageMs) > o.settleBudgetMs) everyFrame = false;
      const ms = everyFrame ? Math.min(slice, settledMs - pageMs) : settledMs - pageMs;
      await advance(ms);
      pageMs += ms;
    }
    if (Date.now() - tSettle > o.settleBudgetMs) everyFrame = false;
    await page.evaluate(stepAnimations, settledMs);
    return { context, page, everyFrame };
  }

  async function film(url, signal, scope, files, frames, progress, deadlineAt) {
    const t0 = Date.now();
    progress.stage = 'check_url';
    await checkUrl(url, { log, ...checkOptions });
    progress.stage = 'open';
    scope.check();
    const dir = await files.own(await fs.mkdtemp(path.join(os.tmpdir(), 'i609-')), (d) => fs.rm(d, { recursive: true, force: true }));
    frames.dir = dir;
    let layout = CLIP_LAYOUT;
    const tLoad = Date.now();
    let { context, page, everyFrame } = await load(url, layout, scope, progress);
    const loadMs = Date.now() - tLoad;
    // Panels docked over the page: measured as frame 0 shows it. With enough of them the page is loaded again in
    // the larger layout, while a second load as long as the first still leaves half the deadline to film.
    // A dockedShare over 1 turns the measurement off.
    progress.stage = 'measure';
    const docked = o.dockedShare <= 1 ? sanitizeShare(await page.evaluate(dockedShareOf, DOCKED_SAMPLE)) : 0;
    if (docked >= o.dockedShare && o.dockedLayoutScale > 1 && loadMs * 4 <= o.deadlineMs) {
      await context.close().catch(() => {});
      layout = DOCKED_LAYOUT;
      ({ context, page, everyFrame } = await load(url, layout, scope, progress));
    }
    const { viewport } = layout;
    const advance = (ms) => (everyFrame ? page.clock.runFor(ms) : page.clock.fastForward(ms));
    let pageMs = settledMs;

    const before = Math.round(o.beforeSeconds * o.fps);
    const minTicks = Math.round(o.minSeconds * o.fps);
    const captureUntil = deadlineAt - o.reserveMs;
    const total = before + Math.round(o.afterSeconds * o.fps);
    let plan = { stride: 1, end: total };
    const filmed = [];
    const shotMs = [];
    const stepMs = [];
    const recent = (values) => values.slice(-COST_FRAMES);
    let frameMs = null;
    let frame0Jpeg = null;
    let actionKind = 'none';
    let target = null;
    let picked = false;
    let pressed = 0;
    let tooSlow = false;
    progress.stage = 'capture';
    for (let tick = 0; tick < plan.end;) {
      scope.check();
      progress.frame = tick;
      if (!picked && tick >= before) {
        picked = true;
        // What the page returns is the page's: only a known kind and a point inside the viewport are used.
        target = sanitizeTarget(await page.evaluate(pickControl, { preferSource: PREFER.source, avoidSource: AVOID.source }), viewport.width, viewport.height);
        if (target) {
          await page.mouse.click(target.x, target.y);
          actionKind = target.kind;
        }
      }
      // A slider moves one step every 3 ticks (0.1 s) for the first 1.2 s (12 steps), as the I-610 harness moved
      // it: the steps due by this frame's page time, however many ticks the last frame step covered.
      if (target?.kind === 'range') {
        const due = Math.min(SLIDER_STEPS, Math.floor((tick - before) / SLIDER_EVERY_TICKS) + 1);
        for (; pressed < due; pressed += 1) await page.keyboard.press('ArrowRight');
      }
      // To a buffer, then into the existing directory without creating it: a write that lands after cleanup
      // fails instead of bringing the directory back (Playwright's own path option makes the directory).
      const tShot = Date.now();
      const shot = await page.screenshot({ type: 'jpeg', quality: o.frameQuality });
      scope.check();
      await fs.writeFile(path.join(dir, tickName(tick)), shot);
      shotMs.push(Date.now() - tShot);
      filmed.push(tick);
      if (tick === 0) frame0Jpeg = await page.screenshot({ type: 'jpeg', quality: o.jpegQuality });

      // The time budget: once the first frames are timed, what is left must be filmed by the deadline less what
      // the encode needs; else a slower or shorter clip, or none.
      if (filmed.length >= o.probeFrames && stepMs.length > 0) {
        frameMs = mean(recent(shotMs)) + mean(recent(stepMs));
        const fitted = fitCapture(
          // Against the whole clip each time: a cut made on a slow frame grows back when frames get faster.
          { next: tick + 1, stride: plan.stride, end: total, frameMs, msLeft: captureUntil - Date.now() },
          { strides, minTicks },
        );
        if (!fitted) {
          tooSlow = true;
          break;
        }
        // A page too slow for the plan is stepped one draw per frame from here on.
        if (fitted.stride !== plan.stride || fitted.end !== plan.end) everyFrame = false;
        plan = fitted;
      }
      const next = Math.ceil((tick + 1) / plan.stride) * plan.stride;
      if (next >= plan.end) break;
      const tStep = Date.now();
      const targetMs = settledMs + Math.round((next * 1000) / o.fps);
      await advance(targetMs - pageMs);
      await page.evaluate(stepAnimations, targetMs - pageMs);
      pageMs = targetMs;
      stepMs.push(Date.now() - tStep);
      tick = next;
    }
    const captureMs = Date.now() - t0;
    await context.close().catch(() => {});

    const fps = o.fps / plan.stride;
    // actionKind (button, range, canvas/svg, none) is the only trace of the control: its label is page text.
    const base = {
      url_host: new URL(url).host, fps, actionKind, captureMs, frameMs: frameMs === null ? null : Math.round(frameMs),
      // The share of the clip's viewport under docked panels, and the CSS viewport the clip was filmed in.
      dockedShare: Math.round(docked * 100) / 100, layout: `${viewport.width}x${viewport.height}`,
    };
    if (tooSlow) {
      const meta = { ...base, frames: filmed.length, seconds: 0, motion: null, totalMs: Date.now() - t0 };
      return { video: null, frame: frame0Jpeg, reason: 'too_slow', meta };
    }
    // The frames of the clip, in order, as ffmpeg reads them (f0000.jpg, f0001.jpg, ...).
    const kept = filmed.filter((tick) => tick % plan.stride === 0 && tick < plan.end);
    if (kept.length !== plan.end / plan.stride) throw new Error('A frame of the clip was not filmed');
    for (const [i, tick] of kept.entries()) {
      await fs.rename(path.join(dir, tickName(tick)), path.join(dir, frameName(i)));
    }

    progress.stage = 'motion';
    const { ydif, blocks } = await motionOf(ffmpeg, dir, fps,
      { luma: o.motionPixelLuma, blockShare: o.motionBlockShare, grid: o.motionGrid }, signal);
    const movingFrames = ydif.filter((v, i) => v > o.motionThreshold || blocks[i] >= o.motionMinBlocks).length;
    const motion = {
      maxYdif: Math.max(0, ...ydif), maxBlocks: Math.max(0, ...blocks), movingFrames, threshold: o.motionThreshold,
    };
    const meta = { ...base, frames: kept.length, seconds: kept.length / fps, motion };
    if (movingFrames < o.minMovingFrames) {
      return { video: null, frame: frame0Jpeg, reason: 'no_motion', meta: { ...meta, totalMs: Date.now() - t0 } };
    }
    scope.check();
    const tEncode = Date.now();
    progress.stage = 'encode';
    const video = await encodeLoop(ffmpeg, dir, kept.length, fps, o, signal);
    const done = { ...meta, encodeMs: Date.now() - tEncode, totalMs: Date.now() - t0, bytes: video.length };
    if (video.length > o.maxBytes) return { video: null, frame: frame0Jpeg, reason: 'too_large', meta: done };
    return { video, frame: frame0Jpeg, reason: null, meta: done };
  }

  /**
   * Film `url`. Resolves { video: Buffer|null, frame: Buffer, reason, meta }; video is null when nothing moved
   * ("no_motion"), the clip came out too large ("too_large") or the page draws too slowly to film even the
   * shortest clip at the slowest frame rate by the deadline ("too_slow").
   * @throws {UrlRefused} the URL is not a public http(s) address
   * @throws {RenderBusy} another render is running here
   * @throws {RenderTimeout} the render passed the deadline (the lookup and the cleanup count)
   * @throws {RenderFailed} anything else, named by stage and code only
   */
  return async function renderVideo({ url }) {
    if (busy) throw new RenderBusy();
    busy = true;
    const controller = new AbortController();
    const scope = createScope(controller.signal); // the browser context
    const files = createScope(controller.signal); // the frames directory, removed last
    const stopped = new Promise((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new RenderTimeout(o.deadlineMs)), { once: true });
    });
    stopped.catch(() => {});
    const deadlineAt = Date.now() + o.deadlineMs;
    const timer = setTimeout(() => controller.abort(), o.deadlineMs);
    const frames = { dir: null };
    const progress = { stage: 'start' };
    const filming = film(String(url || '').trim(), controller.signal, scope, files, frames, progress, deadlineAt);
    const settled = filming.then(() => {}, () => {});
    try {
      let result;
      try {
        result = await Promise.race([filming, stopped]);
      } catch (error) {
        if (error instanceof RenderTimeout) {
          // The stage and frame only: enough to tell a slow capture from a page that never loads.
          log.warn(`[RENDER_VIDEO] timeout stage=${progress.stage} frame=${progress.frame ?? '-'} ms=${o.deadlineMs}`);
          throw error;
        }
        if (error instanceof UrlRefused) throw error;
        // Anything else leaves only its stage and code: its message can quote the URL or the page.
        throw new RenderFailed(progress.stage, errorCode(error));
      }
      const { meta } = result;
      log.info(`[RENDER_VIDEO] host=${meta.url_host} video=${Boolean(result.video)} reason=${result.reason || '-'} `
        + `action=${meta.actionKind} max_ydif=${meta.motion ? meta.motion.maxYdif.toFixed(2) : '-'} `
        + `max_blocks=${meta.motion ? meta.motion.maxBlocks : '-'} `
        + `moving=${meta.motion ? meta.motion.movingFrames : '-'} fps=${meta.fps} frames=${meta.frames} `
        + `frame_ms=${meta.frameMs ?? '-'} docked=${Math.round(meta.dockedShare * 100)} layout=${meta.layout} `
        + `ms=${meta.totalMs} bytes=${meta.bytes || 0}`);
      return result;
    } finally {
      clearTimeout(timer);
      controller.abort();
      // One budget for the whole teardown, so a render holds this instance at most deadlineMs + teardownMs.
      // Stop the browser work first (ffmpeg stops on the abort), wait for the render to end, end Chromium if
      // either stalls, and only then remove the frames, so no screenshot write can land after it.
      const until = Date.now() + o.teardownMs;
      const left = () => Math.max(0, until - Date.now());
      const released = await scope.close(until);
      let ended = await within(settled, left()).then(() => true, () => false);
      if (!released || !ended) {
        log.warn(`[RENDER_VIDEO] teardown stalled (released=${released} ended=${ended}); killing the browser`);
        // Awaited in full: reset() is bounded on its own (it waits at most 15 s for a launch under way, the
        // watchdogs in guarded-browser.mjs), so the slot is freed only after Chromium is gone or given up.
        await guardedBrowser.reset().catch(() => {});
        ended = await within(settled, left()).then(() => true, () => false);
      }
      await files.close(Math.max(until, Date.now() + 1000));
      if (!ended) {
        log.warn('[RENDER_VIDEO] the render had not ended at the end of the teardown budget');
        // Whatever it still writes goes when it ends.
        settled.then(() => (frames.dir ? fs.rm(frames.dir, { recursive: true, force: true }) : null)).catch(() => {});
      }
      busy = false;
    }
  };
}
