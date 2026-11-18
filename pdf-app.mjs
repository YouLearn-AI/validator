// The PDF renderer's HTTP app (ops I-1177): its own private Cloud Run service from the interactive renderer's
// image (pdf-server.mjs), never the public validator. Two routes: GET /health and POST /render-pdf. Its own key,
// always required (render-auth.mjs with required: true); with none configured, every render is refused.
//
// POST /render-pdf { url, document: { title, language, chunks } } answers 200 application/pdf, or JSON
// { success: false, error, code[, stage] }:
//   400 bad_request (the body), origin_refused (the URL's origin is not listed), url_refused (the egress guard)
//   401 the key; 502 page_error (the page's error signal, its code as page_code) or page_navigated (it left the
//   listed origins); 503 busy (Retry-After);
//   504 timeout (the deadline, with its stage); 500 failed (stage and code).

import express from 'express';
import { UrlRefused } from './egress-guard.mjs';
import { PageFailed, PageRefused, PdfBusy, PdfFailed, PdfTimeout, pageInput } from './pdf-renderer.mjs';
import { renderAuth } from './render-auth.mjs';
import { errorCode, jsonErrorHandler } from './request-errors.mjs';

// A 604k-character summary is a few MB of chunk JSON; Cloud Run takes requests up to 32 MiB.
export const PDF_BODY_LIMIT = '16mb';
// The PDF goes out in parts with no Content-Length (chunked), so Cloud Run's 32 MiB cap on a fixed-length HTTP/1
// response does not apply (docs.cloud.google.com/run/quotas).
const PART_BYTES = 1024 * 1024;

// Resolves when `res` can take more, or has closed.
function drained(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * @param {{ renderPdf: Function, key?: string, log?: Console }} options
 */
export function createPdfApp({ renderPdf, key = process.env.PDF_API_KEY || '', log = console }) {
  const app = express();
  const auth = renderAuth({ key, required: true, log });
  const refuse = (res, status, code, error, extra = {}) => res.status(status).json({ success: false, error, code, ...extra });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // The key is checked before the body is read.
  app.post('/render-pdf', auth, express.json({ limit: PDF_BODY_LIMIT, inflate: false }), async (req, res) => {
    const url = req.body?.url;
    const input = pageInput(req.body?.document);
    if (typeof url !== 'string' || url.trim().length === 0 || !input) {
      return refuse(res, 400, 'bad_request', 'Body must include a "url" string and a "document" with a non-empty "chunks" array');
    }
    let result;
    try {
      result = await renderPdf({ url, input });
    } catch (error) {
      if (error instanceof PageRefused) {
        if (error.reason === 'navigated') return refuse(res, 502, 'page_navigated', 'The print page navigated away');
        return refuse(res, 400, 'origin_refused', 'Print page URL refused');
      }
      if (error instanceof UrlRefused) return refuse(res, 400, 'url_refused', error.message);
      if (error instanceof PdfBusy) {
        res.set('Retry-After', '5');
        return refuse(res, 503, 'busy', error.message);
      }
      if (error instanceof PdfTimeout) return refuse(res, 504, 'timeout', 'Render passed its deadline', { stage: error.stage });
      if (error instanceof PageFailed) {
        return refuse(res, 502, 'page_error', 'The print page reported an error', { page_code: error.code });
      }
      // The stage and an allowlisted code only, never the error's message: it can quote the page.
      const stage = error instanceof PdfFailed ? error.stage : 'unknown';
      const code = error instanceof PdfFailed ? error.code : errorCode(error);
      if (!(error instanceof PdfFailed)) log.error(`[RENDER_PDF] failed stage=${stage} code=${code}`);
      return refuse(res, 500, 'failed', 'PDF rendering failed', { stage, failure: code });
    }
    const { pdf } = result;
    res.status(200);
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store' });
    // Each part waits for the last to drain; a caller that hangs up ends the answer.
    for (let at = 0; at < pdf.length && !res.destroyed; at += PART_BYTES) {
      if (!res.write(pdf.subarray(at, at + PART_BYTES))) await drained(res);
    }
    if (!res.destroyed) res.end();
    return undefined;
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // A body that doesn't parse, is too large or is compressed, and anything a route throws: a fixed answer and a
  // code, never Express's default handler (it logs the error's stack, which can quote the body).
  app.use(jsonErrorHandler({ log, tag: 'RENDER_PDF' }));

  return app;
}
