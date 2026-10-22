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
import { checkUrl } from './egress-guard.mjs';

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
  // Motion check: per-frame mean change of luma (ffmpeg signalstats YDIF, 0-255). A caret or a ticking digit
  // stays far under it; a moving shape does not. A clip needs MIN_MOVING_FRAMES frames over the threshold.
  motionThreshold: 0.3,
  minMovingFrames: 3,
  gotoTimeoutMs: 30_000,
  deadlineMs: 100_000,
});

const PREFER = /\b(play|start|run|launch|fire|step|next|search|go|check|begin|animate|simulate|throw|shoot|explore|try|balance|compare)\b/i;

export class RenderBusy extends Error {
  constructor() {
    super('A render is already running on this instance');
    this.name = 'RenderBusy';
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
  return { kind, label: label(el), x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function run(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

/** Per-frame YDIF (mean absolute luma change from the previous frame) of the frames in `dir`. */
async function motionOf(ffmpeg, dir, fps, signal) {
  const out = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(dir, 'f%04d.png'),
    '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF:file=-', '-f', 'null', '-',
  ], { signal });
  return [...out.matchAll(/lavfi\.signalstats\.YDIF=([0-9.]+)/g)].map((m) => Number(m[1]));
}

async function encodeLoop(ffmpeg, dir, frames, o, signal) {
  // The fade ends on the last frame, which is then frame 0 itself: the loop wraps from frame 0 to frame 0.
  const offset = ((frames - 1) / o.fps - o.fadeSeconds).toFixed(4);
  const out = path.join(dir, 'clip.mp4');
  const graph = [
    `[0:v]settb=1/${o.fps},format=yuv444p[a]`,
    `[1:v]settb=1/${o.fps},format=yuv444p,trim=duration=${o.fadeSeconds}[b]`,
    `[a][b]xfade=transition=fade:duration=${o.fadeSeconds}:offset=${offset},format=yuv420p[v]`,
  ].join(';');
  await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-framerate', String(o.fps), '-i', path.join(dir, 'f%04d.png'),
    '-loop', '1', '-framerate', String(o.fps), '-i', path.join(dir, 'f0000.png'),
    '-filter_complex', graph, '-map', '[v]', '-frames:v', String(frames),
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', o.preset, '-crf', String(o.crf), '-tune', 'animation',
    '-r', String(o.fps), '-movflags', '+faststart', '-an', out,
  ], { signal });
  return fs.readFile(out);
}

/**
 * A renderVideo bound to one GuardedBrowser.
 * @param {import('./guarded-browser.mjs').GuardedBrowser} guardedBrowser
 * @param {{ ffmpeg?: string, checkOptions?: object, options?: object, log?: Console }} [config]
 */
export function createVideoRenderer(guardedBrowser, { ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg', checkOptions = {}, options = {}, log = console } = {}) {
  const o = { ...VIDEO_DEFAULTS, ...options };
  let busy = false;

  async function film(url, signal, cleanup) {
    const t0 = Date.now();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'i609-'));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
    const context = await guardedBrowser.newContext({ viewport: { width: o.width, height: o.height }, deviceScaleFactor: 1 });
    cleanup.push(() => context.close().catch(() => {}));
    const page = await context.newPage();
    // CSS animations and transitions don't follow the fake clock. Their timeline is held still from the first
    // document on (playback rate 0); stepAnimations moves them on with the page's clock.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    await page.clock.install({ time: new Date() });
    await page.goto(url, { waitUntil: 'networkidle', timeout: o.gotoTimeoutMs });
    await page.evaluate(() => document.fonts && document.fonts.ready);
    // From here only runFor moves the page's clock.
    const now = await page.evaluate(() => Date.now());
    await page.clock.pauseAt(now + 100);
    await page.evaluate(stepAnimations, 0);
    await page.clock.runFor(o.settleMs);
    await page.evaluate(stepAnimations, o.settleMs);

    const step = 1000 / o.fps;
    const before = Math.round(o.beforeSeconds * o.fps);
    const total = before + Math.round(o.afterSeconds * o.fps);
    let frame0Jpeg = null;
    let action = 'none';
    let target = null;
    for (let i = 0; i < total; i += 1) {
      if (signal.aborted) throw new RenderTimeout(o.deadlineMs);
      if (i === before) {
        target = await page.evaluate(pickControl, PREFER.source);
        if (target) {
          await page.mouse.click(target.x, target.y);
          action = target.kind === 'range' ? `slider "${target.label}"` : `clicked ${target.kind} "${target.label}"`;
        }
      }
      // A slider moves one step every 3 frames for the first 1.2 s (12 steps), as the I-610 harness moved it.
      if (target?.kind === 'range' && i >= before && i < before + 36 && (i - before) % 3 === 0) {
        await page.keyboard.press('ArrowRight');
      }
      await page.screenshot({ path: path.join(dir, `f${String(i).padStart(4, '0')}.png`), type: 'png' });
      if (i === 0) frame0Jpeg = await page.screenshot({ type: 'jpeg', quality: o.jpegQuality });
      await page.clock.runFor(step);
      await page.evaluate(stepAnimations, step);
    }
    const captureMs = Date.now() - t0;
    await context.close().catch(() => {});

    const ydif = await motionOf(ffmpeg, dir, o.fps, signal);
    const movingFrames = ydif.filter((v) => v > o.motionThreshold).length;
    const motion = { maxYdif: Math.max(0, ...ydif), movingFrames, threshold: o.motionThreshold };
    // The clip is one frame shorter than the capture: its last frame is the fade's end, frame 0.
    const meta = { url_host: new URL(url).host, frames: total, fps: o.fps, seconds: (total - 1) / o.fps, action, motion, captureMs };
    if (movingFrames < o.minMovingFrames) {
      return { video: null, frame: frame0Jpeg, reason: 'no_motion', meta: { ...meta, totalMs: Date.now() - t0 } };
    }
    const tEncode = Date.now();
    const video = await encodeLoop(ffmpeg, dir, total, o, signal);
    return {
      video,
      frame: frame0Jpeg,
      reason: null,
      meta: { ...meta, encodeMs: Date.now() - tEncode, totalMs: Date.now() - t0, bytes: video.length },
    };
  }

  /**
   * Film `url`. Resolves { video: Buffer|null, frame: Buffer, reason, meta }; video is null when nothing moved.
   * @throws {UrlRefused} the URL is not a public http(s) address
   * @throws {RenderBusy} another render is running here
   * @throws {RenderTimeout} the render passed the deadline
   */
  return async function renderVideo({ url }) {
    if (busy) throw new RenderBusy();
    busy = true;
    const controller = new AbortController();
    const cleanup = [];
    let timer;
    try {
      const target = String(url || '').trim();
      await checkUrl(target, { log, ...checkOptions });
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new RenderTimeout(o.deadlineMs));
        }, o.deadlineMs);
      });
      const result = await Promise.race([film(target, controller.signal, cleanup), deadline]);
      log.info(`[RENDER_VIDEO] host=${result.meta.url_host} video=${Boolean(result.video)} reason=${result.reason || '-'} `
        + `action=${JSON.stringify(result.meta.action)} max_ydif=${result.meta.motion.maxYdif.toFixed(2)} `
        + `moving=${result.meta.motion.movingFrames} ms=${result.meta.totalMs} bytes=${result.meta.bytes || 0}`);
      return result;
    } finally {
      clearTimeout(timer);
      controller.abort();
      for (const fn of cleanup.reverse()) await fn().catch(() => {});
      busy = false;
    }
  };
}
