// The interactive video renderer (ops I-609), with a real headless Chromium and ffmpeg.
// "public.test" stands for a public site, as in render-guard.test.mjs: its lookup answers a public address and
// its connections go to a local server; every other name and address is resolved and connected for real.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { UrlRefused } from '../egress-guard.mjs';
import { chromium } from 'playwright';
import { GuardedBrowser } from '../guarded-browser.mjs';
import { createVideoApp } from '../video-app.mjs';
import { createVideoRenderer, fitCapture, RenderBusy, RenderTimeout, sanitizeTarget } from '../video-renderer.mjs';

const FAKE_PUBLIC = '93.184.216.34';
const KEY = 'test-video-key-0123456789';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

const PAGES = {
  // Moves only after its Start button: a square driven by requestAnimationFrame.
  '/moving': `<!doctype html><body style="margin:0;background:#fff">
    <button id="go" style="position:absolute;left:20px;top:20px;font-size:24px">Start</button>
    <canvas id="c" width="1200" height="630"></canvas>
    <script>
      const c = document.getElementById('c').getContext('2d'); let x = 0, on = false;
      function draw() { c.fillStyle = '#fff'; c.fillRect(0, 0, 1200, 630); c.fillStyle = '#c40'; c.fillRect(x, 250, 120, 120); }
      function tick() { if (on) { x = (x + 12) % 1080; draw(); } requestAnimationFrame(tick); }
      document.getElementById('go').onclick = () => { on = true; };
      draw(); tick();
    </script></body>`,
  // Nothing moves, and there is nothing to click.
  '/static': '<!doctype html><body style="background:#eef"><h1>Static page</h1><p>Nothing moves here.</p></body>',
  // A CSS animation only: moved by the renderer's Web Animations stepping, not by the fake clock.
  '/css': `<!doctype html><style>
      @keyframes slide { from { transform: translateX(0) } to { transform: translateX(900px) } }
      #b { width: 150px; height: 150px; background: #06c; animation: slide 2s linear infinite; }
    </style><body style="margin:40px"><div id="b"></div></body>`,
  // A slider drives a bar.
  '/slider': `<!doctype html><body style="margin:40px">
    <input id="r" type="range" min="0" max="100" value="10" style="width:600px">
    <div id="bar" style="height:200px;background:#393;width:60px;margin-top:40px"></div>
    <script>document.getElementById('r').oninput = (e) => { document.getElementById('bar').style.width = (e.target.value * 10) + 'px'; };</script></body>`,
  // A button whose label is the user's text; pressing it starts the motion.
  '/labelled': `<!doctype html><body style="margin:0;background:#fff">
    <button id="go" style="position:absolute;left:20px;top:20px;font-size:24px">Start LABEL-SECRET-4410</button>
    <div id="b" style="position:absolute;top:200px;left:0;width:120px;height:120px;background:#c40"></div>
    <script>let x = 0, on = false; document.getElementById('go').onclick = () => { on = true; };
      (function tick() { if (on) { x = (x + 12) % 1080; document.getElementById('b').style.left = x + 'px'; } requestAnimationFrame(tick); })();
    </script></body>`,
  // Tampers with what the renderer's page calls return: its own text as the control's kind.
  '/hostile': `<!doctype html><body style="margin:0"><p id="t">HOSTILE-SECRET-9032</p><script>
      const realEval = window.eval;
      window.eval = function (src) {
        const value = realEval(src);
        if (typeof value !== 'function') return value;
        return function (...args) {
          const out = value.apply(this, args);
          return out && typeof out === 'object' && 'kind' in out
            ? { kind: document.getElementById('t').innerText, x: 50, y: 50 } : out;
        };
      };
</script>
    <canvas id="c" width="1200" height="400"></canvas><script>
      const c = document.getElementById('c').getContext('2d'); let x = 0;
      (function tick() { x = (x + 9) % 1080; c.fillStyle = '#fff'; c.fillRect(0, 0, 1200, 400); c.fillStyle = '#06c';
        c.fillRect(x, 100, 120, 120); requestAnimationFrame(tick); })();</script></body>`,
  // Throws text of its own from inside the renderer's page calls.
  '/throws': `<!doctype html><body><p>page</p><script>
      document.getAnimations = () => { throw new Error('PAGE-SECRET-MARKER-5521'); };</script></body>`,
  // Hangs its renderer when its button is pressed.
  '/hang': `<!doctype html><body><button onclick="for(;;){}" style="font-size:30px">Start</button></body>`,
  // The whole frame turns from white to black: the loop's end must be all white again.
  '/flip': `<!doctype html><body style="margin:0;background:#fff;height:630px;transition:background 1s linear">
    <button onclick="document.body.style.background='#000'" style="position:absolute;left:5px;top:5px">Start</button></body>`,
  // Moves from the moment it loads, driven by requestAnimationFrame and Date.
  '/auto': `<!doctype html><body style="margin:0"><canvas id="c" width="1200" height="630"></canvas><script>
      const c = document.getElementById('c').getContext('2d'); const t0 = performance.now();
      function tick(t) { c.fillStyle = '#fff'; c.fillRect(0, 0, 1200, 630); c.fillStyle = '#093';
        c.fillRect(((t - t0) / 3) % 1080, 250, 120, 120); requestAnimationFrame(tick); }
      requestAnimationFrame(tick);</script></body>`,
  // Draws slowly, as a WebGL scene drawn in software does: each animation frame holds the page for ?draw= ms of
  // real time (a synchronous request the server answers that late; the page's own clocks are the fake ones). The
  // square moves by page time (the frame's timestamp), as three.js pages do. It counts its draws in the title.
  '/slow-draw': `<!doctype html><body style="margin:0;background:#fff"><canvas id="c" width="1200" height="630"></canvas><script>
      const draw = new URLSearchParams(location.search).get('draw') || '100';
      const c = document.getElementById('c').getContext('2d'); let draws = 0;
      function tick(t) { const x = new XMLHttpRequest(); x.open('GET', '/delay?ms=' + draw, false); x.send();
        draws += 1; document.title = String(draws);
        c.fillStyle = '#fff'; c.fillRect(0, 0, 1200, 630); c.fillStyle = '#c40'; c.fillRect((t / 3) % 1080, 250, 120, 120);
        requestAnimationFrame(tick); }
      requestAnimationFrame(tick);</script></body>`,
  // Every frame new noise: the worst case for the clip's size.
  '/noise': `<!doctype html><body style="margin:0"><canvas id="c" width="1200" height="630"></canvas><script>
      const c = document.getElementById('c').getContext('2d'); const img = c.createImageData(1200, 630);
      function tick() { for (let i = 0; i < img.data.length; i += 4) { const v = Math.random() * 255;
        img.data[i] = v; img.data[i + 1] = Math.random() * 255; img.data[i + 2] = v; img.data[i + 3] = 255; }
        c.putImageData(img, 0, 0); requestAnimationFrame(tick); }
      requestAnimationFrame(tick);</script></body>`,
};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function probe(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries',
    'stream=codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,nb_read_frames:format=duration',
    '-of', 'json', file]).toString();
  return JSON.parse(out);
}

function jpegSize(buffer) {
  let i = 2;
  while (i < buffer.length) {
    const marker = buffer[i + 1];
    const length = buffer.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
    i += 2 + length;
  }
  return null;
}

describe('video renderer', { timeout: 300_000 }, () => {
  let originPort;
  let origin;
  let secret;
  let secretPort;
  const secretHits = [];
  let browser;
  let tmpDir;
  const servers = [];

  const lookup = async (host) => (host === 'public.test'
    ? [{ address: FAKE_PUBLIC, family: 4 }]
    : dns.lookup(host, { all: true, verbatim: true }));
  const connect = (options) => {
    if (options.host !== 'public.test') return net.connect(options);
    const socket = net.connect(originPort, '127.0.0.1');
    Object.defineProperty(socket, 'remoteAddress', { get: () => FAKE_PUBLIC });
    return socket;
  };
  const silent = { info() {}, warn() {}, error() {}, log() {} };
  const url = (p) => `http://public.test:${originPort}${p}`;

  before(async () => {
    secret = http.createServer((req, res) => { secretHits.push(req.url); res.end('SECRET'); });
    secretPort = await listen(secret);
    PAGES['/private-subresource'] = `<!doctype html><body><img src="http://127.0.0.1:${secretPort}/img">
      <script>fetch('http://169.254.169.254/computeMetadata/v1/').catch(() => {}); fetch('http://127.0.0.1:${secretPort}/f').catch(() => {});</script>
      <button onclick="document.body.style.background='#f00'">Start</button></body>`;
    origin = http.createServer((req, res) => {
      if (req.url.startsWith('/stall')) return; // never answers: the navigation times out
      if (req.url.startsWith('/delay')) {
        const ms = Number(new URL(req.url, 'http://x').searchParams.get('ms'));
        return setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'), ms);
      }
      const page = PAGES[req.url.split('?')[0]];
      if (!page) return res.writeHead(404).end();
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    });
    originPort = await listen(origin);
    browser = new GuardedBrowser({ guard: { lookup, connect }, log: silent, killable: true });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-test-'));
  });

  after(async () => {
    await browser.close();
    for (const s of servers) s.close();
    origin.close();
    secret.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const renderer = (options = {}) => createVideoRenderer(browser, { checkOptions: { lookup }, options, log: silent });

  test('a page that moves after a click gives a 4 s H.264 loop that iMessage can play', async () => {
    const result = await renderer()({ url: url('/moving') });
    assert.ok(result.video, `no video: ${JSON.stringify(result.meta)}`);
    assert.equal(result.meta.actionKind, 'button');
    const file = path.join(tmpDir, 'moving.mp4');
    fs.writeFileSync(file, result.video);
    const info = probe(file);
    assert.deepEqual(info.streams.map((s) => s.codec_type), ['video'], 'one video stream, no audio');
    const [v] = info.streams;
    assert.equal(v.codec_name, 'h264');
    assert.equal(v.profile, 'High');
    assert.equal(v.pix_fmt, 'yuv420p');
    assert.equal(`${v.width}x${v.height}`, '1200x630');
    assert.equal(v.r_frame_rate, '30/1');
    assert.equal(Number(v.nb_read_frames), 120);
    assert.ok(Math.abs(Number(info.format.duration) - 4) < 0.05, info.format.duration);
    // faststart: the index comes before the media data.
    assert.ok(result.video.indexOf('moov') < result.video.indexOf('mdat'), 'moov after mdat');
    assert.deepEqual(jpegSize(result.frame), { width: 1200, height: 630 });
    assert.ok(result.video.length < 2_000_000, `${result.video.length} bytes`);
  });

  test('the clip ends on its first frame, so the loop has no jump', async () => {
    const file = path.join(tmpDir, 'moving.mp4');
    const frame = (n, out) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-vf', `select=eq(n\\,${n})`, '-fps_mode', 'passthrough', '-frames:v', '1', out]);
    frame(0, path.join(tmpDir, 'first.png'));
    frame(119, path.join(tmpDir, 'last.png'));
    frame(60, path.join(tmpDir, 'middle.png'));
    // ffmpeg prints SSIM on stderr.
    const score = (a, b) => {
      const result = spawnSync('ffmpeg', ['-hide_banner', '-i', path.join(tmpDir, a), '-i', path.join(tmpDir, b), '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' });
      return Number(/All:([0-9.]+)/.exec(result.stderr)[1]);
    };
    assert.ok(score('first.png', 'last.png') > 0.99, `last vs first ${score('first.png', 'last.png')}`);
    assert.ok(score('first.png', 'middle.png') < 0.99, 'the middle should differ from the first frame');
  });

  test('the loop ends on frame 0 exactly, even when the whole frame changed', async () => {
    const result = await renderer()({ url: url('/flip') });
    assert.ok(result.video, JSON.stringify(result.meta));
    const file = path.join(tmpDir, 'flip.mp4');
    fs.writeFileSync(file, result.video);
    const luma = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-vf', 'signalstats,metadata=mode=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
    const yavg = [...luma.stdout.matchAll(/YAVG=([0-9.]+)/g)].map((m) => Number(m[1]));
    assert.equal(yavg.length, 120);
    assert.ok(yavg[90] < 30, `the end of the transition is black: ${yavg[90]}`);
    assert.ok(Math.abs(yavg[119] - yavg[0]) < 1, `first ${yavg[0]} last ${yavg[119]}`);
  });

  test('a page that animates from load starts at the same page time every render', async () => {
    const a = await renderer()({ url: url('/auto') });
    const b = await renderer()({ url: url('/auto') });
    assert.ok(a.video && b.video);
    // The same page time to within a millisecond (the clock's own start): the square is at the same place,
    // give or take a fraction of a pixel. Without the clock paused before load it moved on while the page
    // loaded, a different distance every time.
    fs.writeFileSync(path.join(tmpDir, 'auto-a.jpg'), a.frame);
    fs.writeFileSync(path.join(tmpDir, 'auto-b.jpg'), b.frame);
    const psnr = spawnSync('ffmpeg', ['-hide_banner', '-i', path.join(tmpDir, 'auto-a.jpg'), '-i', path.join(tmpDir, 'auto-b.jpg'),
      '-lavfi', 'psnr', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const db = /average:(inf|[0-9.]+)/.exec(psnr)[1];
    assert.ok(db === 'inf' || Number(db) > 40, `frame 0 PSNR ${db} dB`);
  });

  test('a clip of pure noise stays far under iMessage\'s 10 MB', async () => {
    const result = await renderer()({ url: url('/noise') });
    assert.ok(result.video, JSON.stringify(result.meta));
    assert.ok(result.video.length < 3_000_000, `${result.video.length} bytes`);
  });

  test('a clip over the size limit is dropped', async () => {
    const result = await renderer({ maxBytes: 1000 })({ url: url('/moving') });
    assert.equal(result.video, null);
    assert.equal(result.reason, 'too_large');
  });

  test('the deadline covers a lookup that never answers', async () => {
    const stuck = createVideoRenderer(browser, {
      checkOptions: { lookup: (host) => (host === 'stuck.test' ? new Promise(() => {}) : lookup(host)) },
      options: { deadlineMs: 2000, teardownMs: 1000 },
      log: silent,
    });
    const t0 = Date.now();
    await assert.rejects(stuck({ url: 'http://stuck.test/' }), RenderTimeout);
    assert.ok(Date.now() - t0 < 6000, `took ${Date.now() - t0} ms`);
    // Not RenderBusy: the slot was released.
    await assert.rejects(stuck({ url: 'http://stuck.test/' }), RenderTimeout);
  });

  test('a page where nothing moves gives no video, only the frame', async () => {
    const result = await renderer()({ url: url('/static') });
    assert.equal(result.video, null);
    assert.equal(result.reason, 'no_motion');
    assert.deepEqual(jpegSize(result.frame), { width: 1200, height: 630 });
  });

  test('a CSS animation is filmed at page time: two renders give the same clip', async () => {
    const a = await renderer()({ url: url('/css') });
    const b = await renderer()({ url: url('/css') });
    assert.ok(a.video && b.video, 'the CSS animation counts as motion');
    assert.deepEqual(a.meta.motion, b.meta.motion);
    assert.ok(a.video.equals(b.video), 'the same frames encode to the same bytes');
  });

  test('a slider is stepped when there is no preferred button', async () => {
    const result = await renderer()({ url: url('/slider') });
    assert.equal(result.meta.actionKind, 'range');
    assert.ok(result.video, JSON.stringify(result.meta));
  });

  test('a page that hangs is ended at the deadline and the renderer recovers', async () => {
    // A short deadline, with the budget's reserve cut to match, so the filming reaches the click that hangs.
    const render = renderer({ deadlineMs: 8000, reserveMs: 1000 });
    await assert.rejects(render({ url: url('/hang') }), RenderTimeout);
    const next = await render({ url: url('/moving') });
    assert.ok(next.video);
  });

  test('a page that draws slowly is filmed at a lower frame rate by the deadline, and still loops to frame 0', async () => {
    // Each frame costs a draw of 120 ms and its screenshot: the 120 frames at 30 fps would need about 20 s, and
    // the budget gives about 12 s. The settle is one draw, not the 94 of every 16 ms frame.
    const t0 = Date.now();
    const result = await renderer({ deadlineMs: 16_000, reserveMs: 3000 })({ url: url('/slow-draw?draw=120') });
    const took = Date.now() - t0;
    assert.ok(result.video, JSON.stringify(result.meta));
    assert.ok([15, 10].includes(result.meta.fps), `fps ${result.meta.fps}`);
    assert.ok(took < 16_000, `took ${took} ms`);
    const file = path.join(tmpDir, 'slow.mp4');
    fs.writeFileSync(file, result.video);
    const [v] = probe(file).streams;
    assert.equal(v.r_frame_rate, `${result.meta.fps}/1`);
    assert.equal(Number(v.nb_read_frames), result.meta.frames);
    assert.ok(result.meta.seconds >= 2, `${result.meta.seconds} s`);
    const frame = (n, out) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', file,
      '-vf', `select=eq(n\\,${n})`, '-fps_mode', 'passthrough', '-frames:v', '1', out]);
    frame(0, path.join(tmpDir, 'slow-first.png'));
    frame(result.meta.frames - 1, path.join(tmpDir, 'slow-last.png'));
    const ssim = spawnSync('ffmpeg', ['-hide_banner', '-i', path.join(tmpDir, 'slow-first.png'), '-i', path.join(tmpDir, 'slow-last.png'),
      '-lavfi', 'ssim', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    assert.ok(Number(/All:([0-9.]+)/.exec(ssim)[1]) > 0.99, ssim);
  });

  test('a page too slow for even a 2 s clip at 10 fps answers "too_slow" with its first frame, before the deadline', async () => {
    const t0 = Date.now();
    const result = await renderer({ deadlineMs: 12_000, reserveMs: 3000 })({ url: url('/slow-draw?draw=700') });
    assert.equal(result.reason, 'too_slow', JSON.stringify(result.meta));
    assert.equal(result.video, null);
    assert.deepEqual(jpegSize(result.frame), { width: 1200, height: 630 });
    assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
  });

  test('one render at a time', async () => {
    const render = renderer();
    const first = render({ url: url('/moving') });
    await assert.rejects(render({ url: url('/moving') }), RenderBusy);
    assert.ok((await first).video);
  });

  test('a private page URL is refused before a browser opens', async () => {
    for (const target of ['http://169.254.169.254/computeMetadata/v1/', `http://127.0.0.1:${secretPort}/`, 'http://10.0.0.1/', 'file:///etc/passwd']) {
      await assert.rejects(renderer()({ url: target }), UrlRefused, target);
    }
    assert.equal(secretHits.length, 0);
  });

  test('a public page cannot reach private addresses while it is filmed', async () => {
    const before = secretHits.length;
    await renderer()({ url: url('/private-subresource') });
    assert.equal(secretHits.length, before, `secret reached: ${secretHits.slice(before)}`);
  });

  describe('HTTP', () => {
    async function start(key = KEY) {
      const app = createVideoApp({ renderVideo: renderer(), key, log: silent });
      const server = http.createServer(app);
      servers.push(server);
      return `http://127.0.0.1:${await listen(server)}`;
    }
    const post = async (base, body, headers = {}) => {
      const r = await fetch(`${base}/render-video`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      return { status: r.status, json: await r.json() };
    };

    // Everything the process writes (stdout, stderr, the console) and everything the app logs, while fn runs.
    async function captured(fn) {
      const out = [];
      const writes = [process.stdout.write, process.stderr.write];
      process.stdout.write = (chunk, ...rest) => { out.push(String(chunk)); return writes[0].call(process.stdout, chunk, ...rest); };
      process.stderr.write = (chunk, ...rest) => { out.push(String(chunk)); return writes[1].call(process.stderr, chunk, ...rest); };
      try {
        await fn(out);
      } finally {
        [process.stdout.write, process.stderr.write] = writes;
      }
      return out.join('');
    }
    const loudLog = (out) => ({
      info: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')),
      error: (...a) => out.push(a.join(' ')), log: (...a) => out.push(a.join(' ')),
    });

    test('a successful render answers and logs no page text, not even the clicked control\'s label', async () => {
      let answer;
      const logged = await captured(async (out) => {
        const log = loudLog(out);
        const app = createVideoApp({ renderVideo: createVideoRenderer(browser, { checkOptions: { lookup }, log }), key: KEY, log });
        const server = http.createServer(app);
        servers.push(server);
        const base = `http://127.0.0.1:${await listen(server)}`;
        answer = await post(base, { url: url('/labelled') }, { 'x-api-key': KEY });
      });
      assert.equal(answer.status, 200);
      assert.ok(answer.json.video, 'the page moves after its button');
      assert.equal(answer.json.meta.actionKind, 'button');
      assert.ok(!JSON.stringify(answer.json).includes('LABEL-SECRET-4410'), 'the label is in the answer');
      assert.ok(!logged.includes('LABEL-SECRET-4410'), 'the label reached a log');
    });

    test('a page that tampers with the renderer\'s answers gets no text of its own out', async () => {
      let answer;
      const logged = await captured(async (out) => {
        const log = loudLog(out);
        const app = createVideoApp({ renderVideo: createVideoRenderer(browser, { checkOptions: { lookup }, log }), key: KEY, log });
        const server = http.createServer(app);
        servers.push(server);
        const base = `http://127.0.0.1:${await listen(server)}`;
        answer = await post(base, { url: url('/hostile') }, { 'x-api-key': KEY });
      });
      assert.equal(answer.status, 200);
      assert.ok(['none', 'button', 'range', 'canvas/svg'].includes(answer.json.meta.actionKind), answer.json.meta.actionKind);
      assert.ok(!JSON.stringify(answer.json).includes('HOSTILE-SECRET-9032'), 'page text is in the answer');
      assert.ok(!logged.includes('HOSTILE-SECRET-9032'), 'page text reached a log');
    });

    test('a failed navigation logs its stage and code, never the URL or its token', async () => {
      const TOKEN = 'URL-TOKEN-SECRET-8841';
      let answer;
      const logged = await captured(async (out) => {
        const app = createVideoApp({ renderVideo: renderer({ gotoTimeoutMs: 1500 }), key: KEY, log: loudLog(out) });
        const server = http.createServer(app);
        servers.push(server);
        const base = `http://127.0.0.1:${await listen(server)}`;
        answer = await post(base, { url: url(`/stall?token=${TOKEN}`) }, { 'x-api-key': KEY });
      });
      assert.equal(answer.status, 500);
      assert.deepEqual(answer.json, { success: false, error: 'Video rendering failed', stage: 'navigate', code: 'timeout' });
      assert.match(logged, /\[RENDER_VIDEO\] failed stage=navigate code=timeout/);
      assert.ok(!logged.includes(TOKEN), 'the token reached a log');
    });

    test('text the page throws never reaches a log or the answer', async () => {
      let answer;
      const logged = await captured(async (out) => {
        const app = createVideoApp({ renderVideo: renderer(), key: KEY, log: loudLog(out) });
        const server = http.createServer(app);
        servers.push(server);
        const base = `http://127.0.0.1:${await listen(server)}`;
        answer = await post(base, { url: url('/throws') }, { 'x-api-key': KEY });
      });
      assert.equal(answer.status, 500);
      assert.equal(answer.json.code, 'error');
      assert.ok(!JSON.stringify(answer.json).includes('PAGE-SECRET-MARKER-5521'));
      assert.match(logged, /\[RENDER_VIDEO\] failed stage=\w+ code=error/);
      assert.ok(!logged.includes('PAGE-SECRET-MARKER-5521'), 'page text reached a log');
    });

    test('a body that does not parse, or is too large, gets a fixed answer and no echo in the logs', async () => {
      const MARK = 'BODY-SECRET-MARKER-3307';
      const answers = [];
      const logged = await captured(async (out) => {
        const app = createVideoApp({ renderVideo: renderer(), key: KEY, log: loudLog(out) });
        const server = http.createServer(app);
        servers.push(server);
        const base = `http://127.0.0.1:${await listen(server)}`;
        for (const body of [`{"url": "${MARK}`, JSON.stringify({ url: MARK, pad: 'x'.repeat(20_000) })]) {
          const r = await fetch(`${base}/render-video`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body });
          answers.push({ status: r.status, json: await r.json() });
        }
      });
      assert.deepEqual(answers, [
        { status: 400, json: { success: false, error: 'Request body is not valid JSON', code: 'malformed_json' } },
        { status: 413, json: { success: false, error: 'Request body is too large', code: 'body_too_large' } },
      ]);
      assert.match(logged, /\[RENDER_VIDEO\] request failed: malformed_json/);
      assert.ok(!logged.includes(MARK), 'the body reached a log');
    });

    test('the key is always required', async () => {
      const base = await start();
      assert.equal((await post(base, { url: url('/moving') })).status, 401);
      assert.equal((await post(base, { url: url('/moving') }, { 'x-api-key': 'wrong' })).status, 401);
      const unconfigured = await start('');
      assert.equal((await post(unconfigured, { url: url('/moving') }, { 'x-api-key': KEY })).status, 503);
    });

    test('a render answers the clip and the frame as base64; refusals are 400', async () => {
      const base = await start();
      const ok = await post(base, { url: url('/moving') }, { 'x-api-key': KEY });
      assert.equal(ok.status, 200);
      assert.equal(Buffer.from(ok.json.video, 'base64').subarray(4, 8).toString(), 'ftyp');
      assert.deepEqual(jpegSize(Buffer.from(ok.json.frame, 'base64')), { width: 1200, height: 630 });
      const still = await post(base, { url: url('/static') }, { 'x-api-key': KEY });
      assert.equal(still.status, 200);
      assert.equal(still.json.video, null);
      assert.equal(still.json.reason, 'no_motion');
      assert.equal((await post(base, { url: 'http://169.254.169.254/' }, { 'x-api-key': KEY })).status, 400);
      assert.equal((await post(base, {}, { 'x-api-key': KEY })).status, 400);
    });
  });
});

// --- teardown with a browser that misbehaves (fakes, no Chromium) -----------------------------------------

describe('video renderer teardown', { timeout: 120_000 }, () => {
  const publicLookup = async () => [{ address: FAKE_PUBLIC, family: 4 }];
  const silent = { info() {}, warn() {}, error() {}, log() {} };

  // Two small real JPEGs, a red and a blue frame, made once.
  let images;
  async function frameImages() {
    if (images) return images;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-fake-'));
    try {
      images = ['red', 'blue'].map((color) => {
        const file = path.join(dir, `${color}.jpg`);
        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180`, '-frames:v', '1', file]);
        return fs.readFileSync(file);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return images;
  }

  // images: what the screenshots return in turn (real JPEGs, for a render that reaches ffmpeg).
  function fakeBrowser({ closeHangs = false, screenshotDelayMs = 0, gotoHangs = false, stepDelayMs = 0, images = null } = {}) {
    const state = { resets: 0, shots: 0, forwards: [] };
    const page = {
      clock: {
        install: async () => {},
        pauseAt: async () => {},
        async fastForward(ms) {
          state.forwards.push(ms);
          await new Promise((r) => setTimeout(r, stepDelayMs));
        },
      },
      goto: () => (gotoHangs ? new Promise(() => {}) : Promise.resolve()),
      evaluate: async () => null,
      mouse: { click: async () => {} },
      keyboard: { press: async () => {} },
      async screenshot({ path: file } = {}) {
        state.shots += 1;
        await new Promise((r) => setTimeout(r, screenshotDelayMs));
        if (file) {
          // As Playwright's client does with a path: make the directory, then write.
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'png');
        }
        return images ? images[state.shots % images.length] : Buffer.from('img');
      },
    };
    const context = {
      newPage: async () => page,
      newCDPSession: async () => ({ send: async () => {} }),
      close: () => (closeHangs ? new Promise(() => {}) : Promise.resolve()),
    };
    return {
      state,
      newContext: async () => context,
      reset: async () => { state.resets += 1; },
    };
  }

  test('a context that never closes is given up within the teardown budget, and the browser is killed', async () => {
    const browser = fakeBrowser({ closeHangs: true, gotoHangs: true });
    const render = createVideoRenderer(browser, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 300, teardownMs: 1000 }, log: silent,
    });
    const t0 = Date.now();
    await assert.rejects(render({ url: 'http://public.test/' }), RenderTimeout);
    const took = Date.now() - t0;
    assert.ok(took < 300 + 1000 + 1200, `held ${took} ms`);
    assert.equal(browser.state.resets, 1);
    await assert.rejects(render({ url: 'http://public.test/' }), RenderTimeout); // not RenderBusy
  });

  test('a timeout logs the stage and frame it stopped at, and nothing from the page', async () => {
    const lines = [];
    const log = { ...silent, warn: (line) => lines.push(line) };
    const hung = createVideoRenderer(fakeBrowser({ gotoHangs: true }), {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 300, teardownMs: 1000 }, log,
    });
    await assert.rejects(hung({ url: 'http://public.test/?token=secret' }), RenderTimeout);
    assert.ok(lines.includes('[RENDER_VIDEO] timeout stage=navigate frame=- ms=300'), lines.join('\n'));

    lines.length = 0;
    // The deadline falls on the second frame, before the budget has timed enough frames to decide.
    const slow = createVideoRenderer(fakeBrowser({ screenshotDelayMs: 200 }), {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 450, teardownMs: 1000 }, log,
    });
    await assert.rejects(slow({ url: 'http://public.test/?token=secret' }), RenderTimeout);
    const line = lines.find((l) => l.includes('timeout'));
    assert.match(line, /^\[RENDER_VIDEO\] timeout stage=capture frame=\d+ ms=450$/);
    assert.ok(!lines.join('\n').includes('secret'));
  });

  test('a screenshot that arrives after the whole teardown budget cannot bring the directory back', async () => {
    const browser = fakeBrowser({ screenshotDelayMs: 2500 });
    const render = createVideoRenderer(browser, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 200, teardownMs: 500 }, log: silent,
    });
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('i609-')));
    await assert.rejects(render({ url: 'http://public.test/' }), RenderTimeout);
    await new Promise((r) => setTimeout(r, 3500));
    const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('i609-') && !before.has(n));
    assert.deepEqual(left, [], `left behind: ${left}`);
  });

  test('the frames directory is removed after the last screenshot write, not before', async () => {
    const browser = fakeBrowser({ screenshotDelayMs: 400 });
    const render = createVideoRenderer(browser, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 200, teardownMs: 3000 }, log: silent,
    });
    const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('i609-')));
    await assert.rejects(render({ url: 'http://public.test/' }), RenderTimeout);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(browser.state.shots > 0, 'a screenshot was in flight at the deadline');
    const left = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('i609-') && !before.has(n));
    assert.deepEqual(left, [], `left behind: ${left}`);
  });

  test('a page too slow for 30 fps is filmed at 15: the whole 4 s clip, one clock step per frame, in whole ms', async () => {
    const browser = fakeBrowser({ screenshotDelayMs: 25, stepDelayMs: 25, images: await frameImages() });
    const render = createVideoRenderer(browser, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 6000, reserveMs: 1500 }, log: silent,
    });
    // ~50 ms a frame: 117 frames left at 30 fps need ~6 s, the 58 left at 15 fps ~3 s; the budget is ~4.5 s.
    const result = await render({ url: 'http://public.test/' });
    assert.ok(result.video, JSON.stringify(result.meta));
    assert.equal(result.meta.fps, 15);
    assert.equal(result.meta.frames, 60);
    assert.equal(result.meta.seconds, 4);
    assert.equal(browser.state.forwards[0], 1500, 'the settle is one step');
    assert.ok(browser.state.forwards.every((ms) => Number.isInteger(ms) && ms > 0), browser.state.forwards.join(','));
    // Frame 59 (tick 118) is 3933 ms after frame 0, to the millisecond.
    assert.equal(browser.state.forwards.reduce((a, b) => a + b, 0), 1500 + 3933);
    // The settle, two steps of 1/30 s while the first frames were timed, then one step per frame to tick 118.
    assert.equal(browser.state.forwards.length, 1 + 2 + 1 + 57);
  });

  test('a page too slow even for 2 s at 10 fps answers 200 "too_slow" with its first frame, well before the deadline', async () => {
    const images = await frameImages();
    const browser = fakeBrowser({ screenshotDelayMs: 150, stepDelayMs: 150, images });
    const app = createVideoApp({
      renderVideo: createVideoRenderer(browser, {
        checkOptions: { lookup: publicLookup }, options: { deadlineMs: 4000, reserveMs: 1000 }, log: silent,
      }),
      key: KEY,
      log: silent,
    });
    const server = http.createServer(app);
    try {
      const base = `http://127.0.0.1:${await listen(server)}`;
      const t0 = Date.now();
      const r = await fetch(`${base}/render-video`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({ url: 'http://public.test/' }),
      });
      const took = Date.now() - t0;
      const json = await r.json();
      assert.equal(r.status, 200);
      assert.equal(json.success, true);
      assert.equal(json.video, null);
      assert.equal(json.reason, 'too_slow');
      assert.ok(Buffer.from(json.frame, 'base64').equals(images[0]), 'the first frame is the answer');
      assert.ok(took < 2500, `answered after ${took} ms`);
    } finally {
      server.close();
    }
  });

  describe('the time budget (fitCapture)', () => {
    const limits = { strides: [1, 2, 3], minTicks: 60 };
    const fit = (now) => fitCapture({ stride: 1, end: 120, ...now }, limits);

    test('the plan stays while what is left fits, or before a frame is timed', () => {
      assert.deepEqual(fit({ next: 3, frameMs: 100, msLeft: 20_000 }), { stride: 1, end: 120 });
      assert.deepEqual(fit({ next: 3, frameMs: null, msLeft: 1 }), { stride: 1, end: 120 });
    });

    test('a slow page drops to 15, then to 10 frames a second, keeping the whole clip', () => {
      // From tick 3: 117 frames left at 30 fps, 58 at 15 (ticks 4-118), 39 at 10 (ticks 3-117).
      assert.deepEqual(fit({ next: 3, frameMs: 500, msLeft: 29_000 }), { stride: 2, end: 120 });
      assert.deepEqual(fit({ next: 3, frameMs: 500, msLeft: 28_000 }), { stride: 3, end: 120 });
      assert.deepEqual(fit({ next: 3, frameMs: 500, msLeft: 19_500 }), { stride: 3, end: 120 });
    });

    test('when no frame rate films the whole clip, it is cut, at the fastest rate that still gives 2 s', () => {
      assert.deepEqual(fit({ next: 3, frameMs: 500, msLeft: 15_000 }), { stride: 2, end: 64 });
      assert.deepEqual(fit({ next: 3, frameMs: 1000, msLeft: 19_000 }), { stride: 3, end: 60 });
      // Late in the clip, the frames filmed at 30 fps are kept rather than dropped for 10.
      assert.deepEqual(fit({ next: 101, frameMs: 1000, msLeft: 5500 }), { stride: 1, end: 106 });
      assert.deepEqual(fit({ next: 70, frameMs: 500, msLeft: -100 }), { stride: 1, end: 70 });
    });

    test('too slow for 2 s even at 10 fps: no clip', () => {
      assert.equal(fit({ next: 3, frameMs: 1000, msLeft: 18_999 }), null);
      assert.equal(fit({ next: 30, frameMs: 1000, msLeft: -1 }), null);
    });

    test('a clip at 15 fps never drops to 10 (its frames miss that grid): it is cut at 15', () => {
      assert.deepEqual(fitCapture({ next: 20, stride: 2, end: 120, frameMs: 1000, msLeft: 30_000 }, limits), { stride: 2, end: 80 });
      assert.equal(fitCapture({ next: 20, stride: 2, end: 120, frameMs: 1000, msLeft: 10_000 }, limits), null);
    });
  });

  test('only a known control kind and a point inside the viewport leave the page', () => {
    assert.deepEqual(sanitizeTarget({ kind: 'button', x: 10, y: 20 }, 1200, 630), { kind: 'button', x: 10, y: 20 });
    assert.deepEqual(sanitizeTarget({ kind: 'range', x: -5, y: 9999 }, 1200, 630), { kind: 'range', x: 0, y: 629 });
    for (const raw of [null, 'button', { kind: 'PAGE TEXT', x: 1, y: 1 }, { kind: 'button', x: 'a', y: 1 },
      { kind: 'button', x: Infinity, y: 1 }, { kind: ['button'], x: 1, y: 1 }, { kind: { toString: () => 'button' }, x: 1, y: 1 }]) {
      assert.equal(sanitizeTarget(raw, 1200, 630), null, JSON.stringify(raw));
    }
  });

  test('a launch still under way at the deadline is gone before the render slot is free', async () => {
    const servers = [];
    const guarded = new GuardedBrowser({
      log: silent,
      killable: true,
      launchServer: async (options) => {
        await new Promise((r) => setTimeout(r, 1500)); // a slow start, past the deadline
        const server = await chromium.launchServer(options);
        servers.push(server);
        return server;
      },
    });
    const render = createVideoRenderer(guarded, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 300, teardownMs: 500 }, log: silent,
    });
    try {
      await assert.rejects(render({ url: 'http://public.test/' }), RenderTimeout);
      assert.equal(servers.length, 1, 'the launch finished during the teardown');
      const proc = servers[0].process();
      assert.notEqual(proc.exitCode ?? proc.signalCode, null, 'Chromium outlived the render slot');
    } finally {
      await guarded.close();
    }
  });

  test('a launch that never gets ready can\'t hold the render slot, and is killed if it ever does', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const servers = [];
    const guarded = new GuardedBrowser({
      log: silent,
      killable: true,
      launchTimeoutMs: 800,
      launchServer: async (options) => {
        if (servers.length === 0) {
          servers.push(null);
          await gate; // Chromium "never" gets ready (until the test lets it)
          const late = await chromium.launchServer(options);
          servers[0] = late;
          return late;
        }
        const server = await chromium.launchServer(options);
        servers.push(server);
        return server;
      },
    });
    const render = createVideoRenderer(guarded, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 300, teardownMs: 500 }, log: silent,
    });
    try {
      const t0 = Date.now();
      await assert.rejects(render({ url: 'http://public.test/' }));
      assert.ok(Date.now() - t0 < 300 + 500 + 800 + 1500, `slot held ${Date.now() - t0} ms`);
      // The slot is free: the next render gets its own browser.
      const browser2 = await guarded.browser();
      assert.ok(browser2.isConnected());
      release();
      while (!servers[0]) await new Promise((r) => setTimeout(r, 50));
      const late = servers[0].process();
      for (let i = 0; i < 100 && (late.exitCode ?? late.signalCode) === null; i += 1) await new Promise((r) => setTimeout(r, 50));
      assert.notEqual(late.exitCode ?? late.signalCode, null, 'the late Chromium was not killed');
    } finally {
      release();
      await guarded.close();
    }
  });

  test('a Chromium that starts but never gets ready is killed: the service exits and Playwright reaps it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-launch-'));
    const pidFile = path.join(dir, 'pid');
    const fake = path.join(dir, 'fake-chrome.sh');
    // Started like Chromium, never prints its DevTools endpoint.
    fs.writeFileSync(fake, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 600\n`, { mode: 0o755 });
    try {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'stuck-launch.mjs'), fake], { stdio: 'ignore' });
      const code = await new Promise((resolve) => child.on('exit', (c) => resolve(c)));
      assert.equal(code, 3, 'the watchdog fired and the process exited');
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      let alive = true;
      for (let i = 0; i < 40 && alive; i += 1) {
        try { process.kill(pid, 0); await new Promise((r) => setTimeout(r, 50)); } catch { alive = false; }
      }
      assert.equal(alive, false, `the stuck browser process ${pid} outlived the service`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the public validator keeps Playwright\'s own launch, as on main (no browser server, no exit)', async () => {
    const calls = [];
    // As screenshot-renderer.mjs builds it: not killable, no onStuckLaunch.
    const guarded = new GuardedBrowser({
      log: silent,
      launchBrowser: (options) => { calls.push('launch'); return chromium.launch(options); },
      launchServer: (options) => { calls.push('launchServer'); return chromium.launchServer(options); },
    });
    try {
      const browser = await guarded.browser();
      assert.ok(browser.isConnected());
      await guarded.reset();
      assert.equal(browser.isConnected(), false, 'reset closes it');
      assert.deepEqual(calls, ['launch']);
    } finally {
      await guarded.close();
    }
  });

  test('a reset during a launch discards that launch; the next render launches its own', async () => {
    const servers = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const guarded = new GuardedBrowser({
      log: silent,
      killable: true,
      launchServer: async (options) => {
        const server = await chromium.launchServer(options);
        servers.push(server);
        if (servers.length === 1) await gate; // the first launch finishes only after the reset
        return server;
      },
    });
    try {
      const first = guarded.browser();
      first.catch(() => {});
      while (servers.length === 0) await new Promise((r) => setTimeout(r, 20));
      const resetting = guarded.reset(); // waits for the launch under way, which finishes only once released
      const second = await guarded.browser();
      assert.ok(second.isConnected());
      release();
      await resetting;
      await assert.rejects(first, /outlived a reset/);
      assert.equal(servers.length, 2);
      assert.notEqual(servers[0].process().exitCode ?? servers[0].process().signalCode, null, 'the obsolete Chromium was killed');
      assert.equal(await guarded.browser(), second, 'the running browser stays the current one');
    } finally {
      await guarded.close();
    }
  });
});
