// One headless Chromium for renders of untrusted pages (ops I-602).
//
// - The Chromium sandbox is on (Playwright passes --no-sandbox unless
//   chromiumSandbox is true). On Linux it needs a non-root user and user
//   namespaces: the Dockerfile runs as `node`, and Cloud Run's second-generation
//   environment supports namespaces. CHROMIUM_SANDBOX=off turns it off; every
//   launch then logs a warning, so the setting can't go unnoticed.
// - Every request the browser makes goes through the egress proxy
//   (egress-guard.mjs). Playwright adds <-loopback> to the bypass list, so
//   localhost goes through it too.
// - QUIC is off (it would not use the HTTP proxy), WebRTC may not send UDP
//   that bypasses the proxy, and Chromium's own resolver answers nothing but
//   127.0.0.1 (the proxy), so no name is resolved outside the guard.
// - Each render gets its own context with service workers blocked and
//   downloads refused.

import { chromium } from 'playwright';
import { startEgressProxy } from './egress-guard.mjs';

export const CHROMIUM_ARGS = [
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-quic',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
];

// Our own watchdogs on starting Chromium and connecting to it: launchServer ignores its timeout option
// (Playwright 1.64.1 runs it with no deadline), so a launch that never gets ready is given up here, and the
// browser it brings up later is killed the moment it appears. reset() therefore waits at most
// LAUNCH_TIMEOUT_MS + CONNECT_TIMEOUT_MS for a launch under way.
export const LAUNCH_TIMEOUT_MS = 10_000;
export const CONNECT_TIMEOUT_MS = 5_000;

// `promise`, or an error after `ms`; a result that arrives after that is disposed of.
function watched(promise, ms, what, disposeLate, onExpire = () => {}) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      promise.then((value) => disposeLate(value), () => {}).catch(() => {});
      onExpire();
      reject(new Error(`Browser ${what} timed out`));
    }, ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export function sandboxEnabled(env = process.env) {
  return env.CHROMIUM_SANDBOX !== 'off';
}

export class GuardedBrowser {
  /**
   * @param {object} [options]
   * @param {object} [options.guard] options for startEgressProxy (tests only: a fake lookup or connect)
   * @param {boolean} [options.killable] false (the public validator, as on main): Playwright's own timed
   *   chromium.launch, closed with browser.close(). true (the video renderer): Chromium as a browser server,
   *   killed at once on reset (BrowserServer.kill), its start and connect under our watchdogs, and
   *   onStuckLaunch called once when it started but never got ready. Nothing outside Playwright holds such a
   *   process, so the video service exits then: Playwright's exit handler kills the stuck Chromium's process
   *   group and removes its profile, and browser() refuses from then on.
   */
  constructor({
    guard = {}, sandbox = sandboxEnabled(), log = console, killable = false,
    launchBrowser = (o) => chromium.launch(o), launchServer = (o) => chromium.launchServer(o),
    launchTimeoutMs = LAUNCH_TIMEOUT_MS, onStuckLaunch = null,
  } = {}) {
    this.killable = killable;
    this.launchBrowser = launchBrowser;
    this.launchServer = launchServer;
    this.launchTimeoutMs = launchTimeoutMs;
    this.onStuckLaunch = onStuckLaunch;
    this.stuck = false;
    this.guardOptions = { log, ...guard };
    this.sandbox = sandbox;
    this.log = log;
    this.proxy = null;
    this.current = null; // { browser, kill } of the running Chromium
    this.launching = null; // { generation, promise }
    this.generation = 0; // bumped by reset(): a launch from an older generation is discarded
  }

  async egressProxy() {
    if (!this.proxy) {
      this.proxy = startEgressProxy(this.guardOptions);
      this.proxy.catch(() => { this.proxy = null; });
    }
    return this.proxy;
  }

  async launch(generation) {
    const proxy = await this.egressProxy();
    if (!this.sandbox) this.log.warn('[RENDER_SANDBOX] off: CHROMIUM_SANDBOX=off, Chromium runs without its sandbox');
    const options = {
      headless: true,
      chromiumSandbox: this.sandbox,
      args: CHROMIUM_ARGS,
      proxy: { server: proxy.url },
    };
    if (!this.killable) {
      // Playwright's own launch: it times out and kills a Chromium that doesn't get ready.
      const browser = await this.launchBrowser(options);
      if (generation !== this.generation) {
        await browser.close().catch(() => {});
        throw new Error('Browser launch outlived a reset');
      }
      this.current = { browser, kill: () => browser.close() };
      return browser;
    }
    // Chromium as a browser server, so reset() can kill its process at once (BrowserServer.kill) instead of
    // waiting on a graceful close that Playwright gives up to 30 s.
    const server = await watched(this.launchServer({
      ...options,
      // Its control socket listens on loopback only (the page can't reach loopback through the guard).
      host: '127.0.0.1',
    }), this.launchTimeoutMs, 'launch', (late) => late.kill(), () => {
      if (this.stuck) return;
      this.stuck = true;
      this.log.error('[RENDER_BROWSER] Chromium did not get ready in time');
      this.onStuckLaunch?.();
    });
    if (generation !== this.generation) {
      await server.kill().catch(() => {});
      throw new Error('Browser launch outlived a reset');
    }
    let browser;
    try {
      browser = await watched(
        chromium.connect(server.wsEndpoint(), { timeout: CONNECT_TIMEOUT_MS }),
        CONNECT_TIMEOUT_MS,
        'connect',
        (late) => late.close(),
      );
    } catch (error) {
      await server.kill().catch(() => {});
      throw error;
    }
    if (generation !== this.generation) {
      await server.kill().catch(() => {});
      throw new Error('Browser launch outlived a reset');
    }
    this.current = { browser, kill: () => server.kill() };
    return browser;
  }

  async browser() {
    if (this.stuck && this.onStuckLaunch) throw new Error('Browser restarting');
    if (this.current && this.current.browser.isConnected()) return this.current.browser;
    if (!this.launching || this.launching.generation !== this.generation) {
      const generation = this.generation;
      const promise = this.launch(generation);
      this.launching = { generation, promise };
      promise.then(
        () => { if (this.launching?.promise === promise) this.launching = null; },
        () => { if (this.launching?.promise === promise) this.launching = null; },
      );
    }
    return this.launching.promise;
  }

  /** A fresh context for one render; the caller closes it. */
  async newContext(options = {}) {
    const browser = await this.browser();
    return browser.newContext({
      ...options,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
  }

  /**
   * Ends Chromium (killable: kills its process at once; otherwise browser.close()); the next render launches a
   * new one. A launch still under way is waited for (killable: at most LAUNCH_TIMEOUT_MS + CONNECT_TIMEOUT_MS,
   * the watchdogs) and ended when it returns. The proxy stays.
   */
  async reset() {
    this.generation += 1;
    const pending = this.launching?.promise;
    this.launching = null;
    const current = this.current;
    this.current = null;
    if (current) await current.kill().catch(() => {});
    // launch() kills the server of an older generation itself, after its launch or its connect returns.
    if (pending) await pending.then(() => {}, () => {});
  }

  async close() {
    await this.reset();
    if (this.proxy) {
      const proxy = await this.proxy;
      this.proxy = null;
      await proxy.close();
    }
  }
}
