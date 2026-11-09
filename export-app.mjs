// The export renderer's HTTP app (ops I-1313): its own private service from this repo's code (export-server.mjs),
// never the public validator. Routes: GET /health, POST /render-pdf and POST /render-docx. The shared key is always
// required (render-auth.mjs with required: true; no key configured refuses everything).
//
// POST /render-pdf and /render-docx take saved outputs as data, never a URL (the page that draws them is the
// service's own configuration), and answer the file's bytes (a PDF, or a Word file of the same parts) or JSON with
// a code.

import express from 'express';
import { renderAuth } from './render-auth.mjs';
import { errorCode, jsonErrorHandler } from './request-errors.mjs';
import {
  EXPORT_FORMATS, ExportBusy, ExportFailed, ExportTimeout,
} from './export-renderer.mjs';

// A 600k-character summary's chunks are about 1.5 MB of JSON (I-1177's longest test document).
export const EXPORT_BODY_LIMIT = '8mb';
export const OUTPUT_KINDS = Object.freeze(['answer', 'summary']);
export const MAX_OUTPUTS = 20;
export const MAX_CHUNKS = 10_000;
const MAX_TITLE = 300;
const MAX_LANGUAGE = 35;
const DIRECTIONS = new Set(['ltr', 'rtl']);

const isText = (value, max) => typeof value === 'string' && value.length <= max;

/** Why `body` is not a document to print, or null. Checks the shape only: the page draws the chunks. */
export function documentProblem(body) {
  const doc = body?.document;
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'Body must include a "document" object';
  if (!isText(doc.title, MAX_TITLE)) return '"document.title" must be a string of at most 300 characters';
  if (doc.language !== undefined && !isText(doc.language, MAX_LANGUAGE)) return '"document.language" must be a short string';
  if (doc.direction !== undefined && !DIRECTIONS.has(doc.direction)) return '"document.direction" must be "ltr" or "rtl"';
  if (!Array.isArray(doc.outputs) || doc.outputs.length === 0 || doc.outputs.length > MAX_OUTPUTS) {
    return `"document.outputs" must hold 1 to ${MAX_OUTPUTS} outputs`;
  }
  for (const output of doc.outputs) {
    if (!output || typeof output !== 'object' || !OUTPUT_KINDS.includes(output.kind)) {
      return `Each output's "kind" must be one of ${OUTPUT_KINDS.join(', ')}`;
    }
    if (output.title !== undefined && output.title !== null && !isText(output.title, MAX_TITLE)) {
      return 'An output\'s "title" must be a string of at most 300 characters';
    }
    if (!Array.isArray(output.chunks) || output.chunks.length > MAX_CHUNKS) {
      return `Each output's "chunks" must be an array of at most ${MAX_CHUNKS}`;
    }
    if (!output.chunks.every((chunk) => chunk && typeof chunk === 'object' && typeof chunk.type === 'string')) {
      return 'Each chunk must be an object with a string "type"';
    }
  }
  return null;
}

/**
 * @param {{ render: (doc: object, format: keyof typeof EXPORT_FORMATS) => Promise<object>, key?: string,
 *   log?: Console }} options render: export-renderer.mjs createExportRenderer's
 */
export function createExportApp({ render, key = process.env.RENDER_API_KEY || '', log = console }) {
  const app = express();
  const auth = renderAuth({ key, required: true, log });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // The key is checked before the body is read.
  const renderRoute = (format) => async (req, res) => {
    const problem = documentProblem(req.body);
    if (problem) return res.status(400).json({ success: false, error: problem });
    try {
      const { file, diagrams, imagesFailed, blocked, ms } = await render(req.body.document, format);
      res.set({
        'Content-Type': EXPORT_FORMATS[format].type,
        'Content-Length': String(file.length),
        // Counts and times for the caller's logs; no text from the outputs.
        'X-Export-Diagrams': String(diagrams),
        'X-Export-Images-Failed': String(imagesFailed),
        'X-Export-Blocked': String(blocked),
        // The bytes are the student's output: no cache on the way keeps a copy.
        'Cache-Control': 'no-store',
        'X-Export-Ms': String(ms),
      });
      return res.status(200).end(file);
    } catch (error) {
      if (error instanceof ExportBusy) {
        res.set('Retry-After', '5');
        return res.status(503).json({ success: false, error: error.message, code: 'busy' });
      }
      if (error instanceof ExportTimeout) {
        return res.status(504).json({ success: false, error: 'Export timed out', code: 'deadline' });
      }
      // The stage and an allowlisted code only, never the error's message: it can quote the page.
      const stage = error instanceof ExportFailed ? error.stage : 'unknown';
      const code = error instanceof ExportFailed ? error.code : errorCode(error);
      return res.status(500).json({ success: false, error: 'Export failed', stage, code });
    }
  };
  for (const format of Object.keys(EXPORT_FORMATS)) {
    app.post(`/render-${format}`, auth, express.json({ limit: EXPORT_BODY_LIMIT, inflate: false }), renderRoute(format));
  }

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // A body that doesn't parse, is too large or is compressed, and anything a route throws: a fixed answer and a
  // code, never Express's default handler (it logs the error's stack, which can quote the body).
  app.use(jsonErrorHandler({ log, tag: 'EXPORT' }));

  return app;
}
