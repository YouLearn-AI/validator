// The interactive layout checker's HTTP app (ops I-610, plan 012): its own private Cloud Run service from the
// interactive renderer's image (check-server.mjs), never the public validator. Two routes: GET /health and
// POST /check-layout. The key is always required (render-auth.mjs with required: true); with none configured,
// every check is refused.

import express from 'express';
import { CheckBusy, CheckFailed, parseWidths } from './layout-check.mjs';
import { renderAuth } from './render-auth.mjs';
import { errorCode, jsonErrorHandler } from './request-errors.mjs';

// A generated page is tens of KB; the largest is far under this.
export const CHECK_BODY_LIMIT = '1mb';

/**
 * @param {{ checkLayout: Function, key?: string, log?: Console }} options
 */
export function createCheckApp({ checkLayout, key = process.env.RENDER_API_KEY || '', log = console }) {
  const app = express();
  const auth = renderAuth({ key, required: true, log });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // The key is checked before the body is read.
  app.post('/check-layout', auth, express.json({ limit: CHECK_BODY_LIMIT, inflate: false }), async (req, res) => {
    const html = req.body?.html;
    if (typeof html !== 'string' || html.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Body must include a non-empty "html" string' });
    }
    const widths = parseWidths(req.body?.widths);
    if (!widths) {
      return res.status(400).json({ success: false, error: '"widths" must be 1 or 2 distinct integers from 320 to 1920' });
    }
    try {
      const answer = await checkLayout({ html, widths });
      return res.json({ success: true, ...answer });
    } catch (error) {
      if (error instanceof CheckBusy) {
        res.set('Retry-After', '5');
        return res.status(503).json({ success: false, error: error.message });
      }
      // The stage and an allowlisted code only, never the error's message: it can quote the page.
      const stage = error instanceof CheckFailed ? error.stage : 'unknown';
      const code = error instanceof CheckFailed ? error.code : errorCode(error);
      if (!(error instanceof CheckFailed)) log.error(`[CHECK_LAYOUT] failed stage=${stage} code=${code}`);
      return res.status(500).json({ success: false, error: 'Layout check failed', stage, code });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // A body that doesn't parse, is too large or is compressed, and anything a route throws: a fixed answer and a
  // code, never Express's default handler (it logs the error's stack, which can quote the body).
  app.use(jsonErrorHandler({ log, tag: 'CHECK_LAYOUT' }));

  return app;
}

/**
 * Starts Chromium, then opens the port. Cloud Run counts an instance as started once its startup probe (TCP on
 * this port) passes, and with request-based billing an instance has CPU only while it starts or serves a request
 * (docs.cloud.google.com/run/docs/container-contract, "Instance lifecycle"). A launch begun after the port opened
 * ran with no CPU once the backend's GET /health pre-warm was answered, and never got ready (I-610, 22:19Z and
 * 23:09Z on 2026-10-24). Launched first, Chromium is up before the first request, the pre-warm included.
 * A launch that fails still opens the port (the first check launches again); one that never gets ready does not,
 * since the GuardedBrowser's onStuckLaunch ends the process.
 * @param {import('express').Express} app
 * @param {import('./guarded-browser.mjs').GuardedBrowser} browser
 * @param {{ port?: number|string, host?: string, log?: Console, closing?: () => boolean }} [options]
 * @returns {Promise<import('node:http').Server|null>} the listening server, or null when the launch got stuck or
 *   the process is shutting down
 */
export async function listenWhenReady(app, browser, { port, host, log = console, closing = () => false } = {}) {
  const t0 = Date.now();
  try {
    await browser.browser();
    log.log(`[CHECK_LAYOUT] browser ready ms=${Date.now() - t0}`);
  } catch (error) {
    log.error(`[CHECK_LAYOUT] browser start failed code=${errorCode(error)}`);
    if (browser.stuck) return null;
  }
  // Shutting down while Chromium started (SIGTERM): the port never opens.
  if (closing()) return null;
  return new Promise((resolve, reject) => {
    const where = host === undefined ? [port] : [port, host];
    // Express 5 passes a listen error (a port in use) to this callback.
    const server = app.listen(...where, (error) => {
      if (error) {
        reject(error);
        return;
      }
      log.log(`Layout checker listening on port ${server.address().port}`);
      resolve(server);
    });
  });
}
