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

export function sandboxEnabled(env = process.env) {
  return env.CHROMIUM_SANDBOX !== 'off';
}

export class GuardedBrowser {
  /**
   * @param {{ guard?: object, sandbox?: boolean, log?: Console, launch?: Function }} [options]
   *   guard: options for startEgressProxy (tests only: a fake lookup or connect).
   */
  constructor({ guard = {}, sandbox = sandboxEnabled(), log = console, launch = (o) => chromium.launch(o) } = {}) {
    this.guardOptions = { log, ...guard };
    this.sandbox = sandbox;
    this.log = log;
    this.launch = launch;
    this.proxy = null;
    this.browserInstance = null;
    this.launching = null;
  }

  async egressProxy() {
    if (!this.proxy) {
      this.proxy = startEgressProxy(this.guardOptions);
      this.proxy.catch(() => { this.proxy = null; });
    }
    return this.proxy;
  }

  async browser() {
    if (this.browserInstance && this.browserInstance.isConnected()) return this.browserInstance;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      const proxy = await this.egressProxy();
      if (!this.sandbox) this.log.warn('[RENDER_SANDBOX] off: CHROMIUM_SANDBOX=off, Chromium runs without its sandbox');
      const browser = await this.launch({
        headless: true,
        chromiumSandbox: this.sandbox,
        args: CHROMIUM_ARGS,
        proxy: { server: proxy.url },
      });
      this.browserInstance = browser;
      return browser;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
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

  async close() {
    if (this.browserInstance && this.browserInstance.isConnected()) await this.browserInstance.close();
    this.browserInstance = null;
    if (this.proxy) {
      const proxy = await this.proxy;
      this.proxy = null;
      await proxy.close();
    }
  }
}
