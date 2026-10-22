// The interactive video renderer (ops I-609), with a real headless Chromium and ffmpeg.
// "public.test" stands for a public site, as in render-guard.test.mjs: its lookup answers a public address and
// its connections go to a local server; every other name and address is resolved and connected for real.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
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
import { createVideoRenderer, RenderBusy, RenderTimeout } from '../video-renderer.mjs';

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
      const page = PAGES[req.url];
      if (!page) return res.writeHead(404).end();
      return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page);
    });
    originPort = await listen(origin);
    browser = new GuardedBrowser({ guard: { lookup, connect }, log: silent });
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
    assert.match(result.meta.action, /Start/);
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
    assert.match(result.meta.action, /^slider/);
    assert.ok(result.video, JSON.stringify(result.meta));
  });

  test('a page that hangs is ended at the deadline and the renderer recovers', async () => {
    const render = renderer({ deadlineMs: 8000 });
    await assert.rejects(render({ url: url('/hang') }), RenderTimeout);
    const next = await render({ url: url('/moving') });
    assert.ok(next.video);
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

  function fakeBrowser({ closeHangs = false, screenshotDelayMs = 0, gotoHangs = false } = {}) {
    const state = { resets: 0, writes: [] };
    const page = {
      clock: { install: async () => {}, pauseAt: async () => {}, runFor: async () => {} },
      goto: () => (gotoHangs ? new Promise(() => {}) : Promise.resolve()),
      evaluate: async () => null,
      mouse: { click: async () => {} },
      keyboard: { press: async () => {} },
      async screenshot({ path: file } = {}) {
        await new Promise((r) => setTimeout(r, screenshotDelayMs));
        if (file) {
          // As Playwright's client does: make the parent directory, then write.
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, 'png');
          state.writes.push(file);
        }
        return Buffer.from('jpg');
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

  test('the frames directory is removed after the last screenshot write, not before', async () => {
    const browser = fakeBrowser({ screenshotDelayMs: 400 });
    const render = createVideoRenderer(browser, {
      checkOptions: { lookup: publicLookup }, options: { deadlineMs: 200, teardownMs: 3000 }, log: silent,
    });
    await assert.rejects(render({ url: 'http://public.test/' }), RenderTimeout);
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(browser.state.writes.length > 0, 'a screenshot was in flight at the deadline');
    for (const file of browser.state.writes) assert.ok(!fs.existsSync(path.dirname(file)), `left ${path.dirname(file)}`);
  });

  test('a reset during a launch discards that launch; the next render launches its own', async () => {
    const servers = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const guarded = new GuardedBrowser({
      log: silent,
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
      await guarded.reset();
      const second = await guarded.browser();
      assert.ok(second.isConnected());
      release();
      await assert.rejects(first, /outlived a reset/);
      assert.equal(servers.length, 2);
      assert.notEqual(servers[0].process().exitCode ?? servers[0].process().signalCode, null, 'the obsolete Chromium was killed');
      assert.equal(await guarded.browser(), second, 'the running browser stays the current one');
    } finally {
      await guarded.close();
    }
  });
});
