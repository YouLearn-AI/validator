// The interactive video renderer's HTTP app (ops I-609): a separate, private service built from this repo's
// code, never the public validator. Two routes: GET /health and POST /render-video. The shared key is always
// required here (render-auth.mjs with required: true; no key configured refuses everything).

import express from 'express';
import { UrlRefused } from './egress-guard.mjs';
import { renderAuth } from './render-auth.mjs';
import { errorCode, jsonErrorHandler } from './request-errors.mjs';
import { RenderBusy, RenderFailed, RenderTimeout } from './video-renderer.mjs';

/**
 * @param {{ renderVideo: Function, key?: string, log?: Console }} options
 */
export function createVideoApp({ renderVideo, key = process.env.RENDER_API_KEY || '', log = console }) {
  const app = express();
  const auth = renderAuth({ key, required: true, log });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // The key is checked before the body is read; the body is a URL, so it is small.
  app.post('/render-video', auth, express.json({ limit: '16kb', inflate: false }), async (req, res) => {
    const url = req.body?.url;
    if (typeof url !== 'string' || url.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Body must include a non-empty "url" string' });
    }
    try {
      const result = await renderVideo({ url });
      return res.json({
        success: true,
        video: result.video ? result.video.toString('base64') : null,
        frame: result.frame ? result.frame.toString('base64') : null,
        reason: result.reason,
        meta: result.meta,
      });
    } catch (error) {
      if (error instanceof UrlRefused) return res.status(400).json({ success: false, error: error.message });
      if (error instanceof RenderBusy) {
        res.set('Retry-After', '10');
        return res.status(503).json({ success: false, error: error.message });
      }
      if (error instanceof RenderTimeout) return res.status(504).json({ success: false, error: error.message });
      // The stage and an allowlisted code only, never the error's message, stack or cause: those quote the
      // URL (its query can hold a token) and text the page threw.
      const stage = error instanceof RenderFailed ? error.stage : 'unknown';
      const code = error instanceof RenderFailed ? error.code : errorCode(error);
      log.error(`[RENDER_VIDEO] failed stage=${stage} code=${code}`);
      return res.status(500).json({ success: false, error: 'Video rendering failed', stage, code });
    }
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // A body that doesn't parse, is too large or is compressed, and anything a route throws: a fixed answer
  // and a code, never Express's default handler (it logs the error's stack, which can quote the body).
  app.use(jsonErrorHandler({ log, tag: 'RENDER_VIDEO' }));

  return app;
}
