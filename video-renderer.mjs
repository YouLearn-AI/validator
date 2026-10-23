// A short looping clip of an interactive, for og:video in share-link previews (ops I-609).
//
// Filmed like the research harness (docs/research/product/2026-10-22-i609-og-video, record.mjs and encode.sh in
// the youlearn hub): a 1200x630 viewport, Playwright's fake clock paused so that every frame is exactly 1/30 s
// of page time after the one before, whatever the screenshot costs. CSS animations and transitions are not
// driven by that clock: their timeline is held still (CDP Animation.setPlaybackRate 0) and each step moves the
// Web Animations on by the same 1/30 s. The page is shown as loaded, then the first control is used (the I-610 rule: a button whose label
// says play/start/launch/..., else the first slider, else the first button, else the largest canvas or svg),
// then the clip runs on. A motion check drops a clip whose frames don't change. The last 0.3 s fade back into
// frame 0, so the clip loops without a jump. H.264 High, yuv420p, faststart, no audio: what iMessage plays.
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
  width: 1200,
  height: 630,
  fps: 30,
  beforeSeconds: 0.4, // the page as loaded
  afterSeconds: 3.6, // after the interaction; the clip is before + after = 4.0 s
  fadeSeconds: 0.3, // the tail fades into frame 0
  // Page time after load before frame 0. CSS animations are held still while the page loads, so reveal
  // animations need it: at 1500 ms frame 0 matched the share thumbnail on the I-610 set (SSIM 0.990-1.000;
  // at 500 ms one page was still fading in, SSIM 0.80).
  settleMs: 1500,
  crf: 24,
  preset: 'medium',
  jpegQuality: 80,
  // The filmed frames go to ffmpeg as JPEG, not PNG: a PNG of a busy canvas took 167 ms against 56 ms (ops I-609,
  // a projectile interactive on a Mac), and its 120 PNGs passed the deadline on Cloud Run's 2 vCPU.
  frameQuality: 90,
  // Motion check: per-frame mean change of luma (ffmpeg signalstats YDIF, 0-255). A caret or a ticking digit
  // stays far under it; a moving shape does not. A clip needs MIN_MOVING_FRAMES frames over the threshold.
  motionThreshold: 0.3,
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
function pickControl(preferSource) {
  const prefer = new RegExp(preferSource, 'i');
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4 && s.visibility !== 'hidden' && s.display !== 'none' && r.top >= 0 && r.left >= 0
      && r.top + r.height / 2 < innerHeight && r.left + r.width / 2 < innerWidth;
  };
  const label = (el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.tagName)
    .trim().replace(/\s+/g, ' ').slice(0, 60);
  const buttons = [...document.querySelectorAll('button,[role=button],input[type=button],input[type=submit]')]
    .filter(visible).filter((b) => !b.disabled);
  let el = buttons.find((b) => prefer.test(label(b)));
  let kind = 'button';
  if (!el) {
    const range = [...document.querySelectorAll('input[type=range]')].filter(visible)[0];
    if (range) { el = range; kind = 'range'; }
  }
  if (!el && buttons.length) el = buttons[0];
  if (!el) {
    const area = (e) => e.getBoundingClientRect().width * e.getBoundingClientRect().height;
    const surface = [...document.querySelectorAll('canvas,svg')].filter(visible).sort((a, b) => area(b) - area(a))[0];
    if (surface) { el = surface; kind = 'canvas/svg'; }
  }
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // The label stays in the page: it is the page's text, and nothing outside needs it.
  return { kind, x: r.left + r.width / 2, y: r.top + r.height / 2 };
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

/** Per-frame YDIF (mean absolute luma change from the previous frame) of the frames in `dir`. */
async function motionOf(ffmpeg, dir, fps, signal) {
  const out = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.jpg'),
    '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-', '-f', 'null', '-',
  ], { signal });
  return [...out.matchAll(/lavfi\.signalstats\.YDIF=([0-9.]+)/g)].map((m) => Number(m[1]));
}

async function encodeLoop(ffmpeg, dir, frames, o, signal) {
  // The fade ends exactly on the last frame, which is then frame 0 itself, so the loop wraps from frame 0 to
  // frame 0 (a 1/30 s hold) with nothing of the end left in it. The fading-in input needs one frame past the
  // fade for xfade to reach it.
  const offset = ((frames - 1) / o.fps - o.fadeSeconds).toFixed(4);
  const tail = (o.fadeSeconds + 1 / o.fps).toFixed(4);
  const out = path.join(dir, 'clip.mp4');
  const graph = [
    // JPEG frames are full range; players expect the limited range of yuv420p (else the clip is yuvj420p).
    `[0:v]scale=in_range=pc:out_range=tv,settb=1/${o.fps},format=yuv444p[a]`,
    `[1:v]scale=in_range=pc:out_range=tv,settb=1/${o.fps},format=yuv444p,trim=duration=${tail}[b]`,
    `[a][b]xfade=transition=fade:duration=${o.fadeSeconds}:offset=${offset},format=yuv420p[v]`,
  ].join(';');
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(o.fps), '-i', path.join(dir, 'f%04d.jpg'),
    '-loop', '1', '-framerate', String(o.fps), '-i', path.join(dir, 'f0000.jpg'),
    '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames),
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', o.preset, '-crf', String(o.crf), '-tune', 'animation',
    // A ceiling for pages full of noise: 4 s at 4 Mbit/s is about 2 MB, under iMessage's 10 MB.
    '-maxrate', o.maxrate, '-bufsize', o.bufsize,
    '-r', String(o.fps), '-movflags', '+faststart', '-an', out,
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

  async function film(url, signal, scope, files, frames, progress) {
    const t0 = Date.now();
    progress.stage = 'check_url';
    await checkUrl(url, { log, ...checkOptions });
    progress.stage = 'open';
    scope.check();
    const dir = await files.own(await fs.mkdtemp(path.join(os.tmpdir(), 'i609-')), (d) => fs.rm(d, { recursive: true, force: true }));
    frames.dir = dir;
    const context = await scope.own(
      await guardedBrowser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 }),
      (c) => c.close(),
    );
    const page = await context.newPage();
    // CSS animations and transitions don't follow the fake clock. Their timeline is held still from the first
    // document on (playback rate 0); stepAnimations moves them on with the page's clock.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    // The page's clock is paused before its first script runs, so timers and requestAnimationFrame move only
    // with runFor: however long the load takes, frame 0 is the same page time after it.
    const epoch = o.epochMs ?? Math.floor(Date.now() / 1000) * 1000;
    await page.clock.install({ time: epoch });
    // A whole second ahead, so the paused time doesn't depend on how long install took.
    await page.clock.pauseAt(epoch + 1000);
    progress.stage = 'navigate';
    await page.goto(url, { waitUntil: 'networkidle', timeout: o.gotoTimeoutMs });
    progress.stage = 'settle';
    await page.evaluate(() => document.fonts && document.fonts.ready);
    scope.check();
    await page.evaluate(stepAnimations, 0);
    await page.clock.runFor(o.settleMs);
    await page.evaluate(stepAnimations, o.settleMs);

    const step = 1000 / o.fps;
    const before = Math.round(o.beforeSeconds * o.fps);
    const total = before + Math.round(o.afterSeconds * o.fps);
    let frame0Jpeg = null;
    let actionKind = 'none';
    let target = null;
    progress.stage = 'capture';
    for (let i = 0; i < total; i += 1) {
      scope.check();
      if (i === before) {
        // What the page returns is the page's: only a known kind and a point inside the viewport are used.
        target = sanitizeTarget(await page.evaluate(pickControl, PREFER.source), o.width, o.height);
        if (target) {
          await page.mouse.click(target.x, target.y);
          actionKind = target.kind;
        }
      }
      // A slider moves one step every 3 frames for the first 1.2 s (12 steps), as the I-610 harness moved it.
      if (target?.kind === 'range' && i >= before && i < before + 36 && (i - before) % 3 === 0) {
        await page.keyboard.press('ArrowRight');
      }
      // To a buffer, then into the existing directory without creating it: a write that lands after cleanup
      // fails instead of bringing the directory back (Playwright's own path option makes the directory).
      progress.frame = i;
      const shot = await page.screenshot({ type: 'jpeg', quality: o.frameQuality });
      scope.check();
      await fs.writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.jpg`), shot);
      if (i === 0) frame0Jpeg = await page.screenshot({ type: 'jpeg', quality: o.jpegQuality });
      await page.clock.runFor(step);
      await page.evaluate(stepAnimations, step);
    }
    const captureMs = Date.now() - t0;
    await context.close().catch(() => {});

    progress.stage = 'motion';
    const ydif = await motionOf(ffmpeg, dir, o.fps, signal);
    const movingFrames = ydif.filter((v) => v > o.motionThreshold).length;
    const motion = { maxYdif: Math.max(0, ...ydif), movingFrames, threshold: o.motionThreshold };
    // actionKind (button, range, canvas/svg, none) is the only trace of the control: its label is page text.
    const meta = { url_host: new URL(url).host, frames: total, fps: o.fps, seconds: total / o.fps, actionKind, motion, captureMs };
    if (movingFrames < o.minMovingFrames) {
      return { video: null, frame: frame0Jpeg, reason: 'no_motion', meta: { ...meta, totalMs: Date.now() - t0 } };
    }
    scope.check();
    const tEncode = Date.now();
    progress.stage = 'encode';
    const video = await encodeLoop(ffmpeg, dir, total, o, signal);
    const done = { ...meta, encodeMs: Date.now() - tEncode, totalMs: Date.now() - t0, bytes: video.length };
    if (video.length > o.maxBytes) return { video: null, frame: frame0Jpeg, reason: 'too_large', meta: done };
    return { video, frame: frame0Jpeg, reason: null, meta: done };
  }

  /**
   * Film `url`. Resolves { video: Buffer|null, frame: Buffer, reason, meta }; video is null when nothing moved
   * ("no_motion") or the clip came out too large ("too_large").
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
    const timer = setTimeout(() => controller.abort(), o.deadlineMs);
    const frames = { dir: null };
    const progress = { stage: 'start' };
    const filming = film(String(url || '').trim(), controller.signal, scope, files, frames, progress);
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
      log.info(`[RENDER_VIDEO] host=${result.meta.url_host} video=${Boolean(result.video)} reason=${result.reason || '-'} `
        + `action=${result.meta.actionKind} max_ydif=${result.meta.motion.maxYdif.toFixed(2)} `
        + `moving=${result.meta.motion.movingFrames} ms=${result.meta.totalMs} bytes=${result.meta.bytes || 0}`);
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
