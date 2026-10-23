import express from 'express';
import { validateDiagramSyntax } from './validator.mjs';
import { validateLatex } from './latex-validator.mjs';
import { renderScreenshot as defaultRenderScreenshot } from './screenshot-renderer.mjs';
import { UrlRefused } from './egress-guard.mjs';
import { renderAuth } from './render-auth.mjs';
import { errorCode, jsonErrorHandler } from './request-errors.mjs';

/**
 * The validator's Express app. server.mjs listens with the defaults; tests pass
 * their own renderer and key settings.
 * @param {{ renderScreenshot?: Function, auth?: Function }} [options]
 */
export function createApp({ renderScreenshot = defaultRenderScreenshot, auth = renderAuth() } = {}) {
  const app = express();

  // The shared key for /render-screenshot is checked first, before any body is
  // read (render-auth.mjs, ops I-602).
  app.post('/render-screenshot', auth);

  // Default limit for most endpoints
  // inflate: false refuses compressed request bodies (415) instead of decompressing them:
  // Node's Brotli decoder has a remote-code-execution bug (CVE-2026-111497, fixed in
  // 24.22.1), and no client needs to send compressed JSON here (ops I-543).
  app.use(express.json({ limit: '256kb', inflate: false }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // Validate Mermaid diagram syntax
  app.post('/validate/mermaid', async (req, res) => {
    const diagram = typeof req.body === 'string' ? req.body : req.body?.diagram;

    if (typeof diagram !== 'string' || diagram.trim().length === 0) {
      return res.status(400).json({ valid: false, error: 'Body must include a non-empty "diagram" string' });
    }

    const result = await validateDiagramSyntax(diagram);
    if (result.valid) return res.json({ valid: true });
    return res.status(400).json(result);
  });

  // Validate LaTeX syntax
  app.post('/validate/latex', (req, res) => {
    const text = typeof req.body === 'string' ? req.body : req.body?.text;

    if (typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ valid: false, error: 'Body must include a non-empty "text" string' });
    }

    try {
      const result = validateLatex(text, req.body?.delimiters, req.body?.macros);
      if (result.isValid) {
        return res.json({ valid: true });
      } else {
        return res.status(400).json({
          valid: false,
          errors: result.errors,
          error: `Found ${result.errors.length} LaTeX error(s)`
        });
      }
    } catch (error) {
      return res.status(500).json({
        valid: false,
        error: `Validation failed: ${error.message}`
      });
    }
  });

  // Render URL/HTML and capture screenshot
  // Uses larger body limit since content can be substantial
  app.post('/render-screenshot', express.json({ limit: '2mb', inflate: false }), async (req, res) => {
    const { html, url, width, height, format, quality, scale } = req.body;

    const hasHtml = typeof html === 'string' && html.trim().length > 0;
    const hasUrl = typeof url === 'string' && url.trim().length > 0;

    if (!hasHtml && !hasUrl) {
      return res.status(400).json({
        success: false,
        error: 'Body must include a non-empty "html" or "url" string'
      });
    }

    // Validate dimensions
    const viewportWidth = typeof width === 'number' && width > 0 && width <= 3840 ? width : 1280;
    const viewportHeight = typeof height === 'number' && height > 0 && height <= 2160 ? height : 720;

    // Validate format & quality
    const imgFormat = format === 'png' ? 'png' : 'jpeg';
    const imgQuality = typeof quality === 'number' && quality >= 1 && quality <= 100 ? quality : 80;
    const deviceScale = typeof scale === 'number' && scale >= 1 && scale <= 3 ? scale : 1;

    try {
      const screenshot = await renderScreenshot({
        url: hasUrl ? url : undefined,
        html: hasHtml ? html : undefined,
        width: viewportWidth,
        height: viewportHeight,
        format: imgFormat,
        quality: imgQuality,
        scale: deviceScale,
      });
      return res.json({
        success: true,
        screenshot
      });
    } catch (error) {
      if (error instanceof UrlRefused) {
        return res.status(400).json({ success: false, error: error.message });
      }
      // A code only: the error's message can quote the URL or text the page threw (ops I-609 review).
      const code = errorCode(error);
      // eslint-disable-next-line no-console
      console.error(`[RENDER_SCREENSHOT] failed code=${code}`);
      return res.status(500).json({
        success: false,
        error: 'Screenshot rendering failed',
        code,
      });
    }
  });

  // 404 for other routes
  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  // A body that doesn't parse, is too large or is compressed (415, ops I-543), and anything a route throws:
  // the same status as before, a fixed answer and a code, instead of Express's default handler, which logs
  // the error's stack (it can quote the body).
  // eslint-disable-next-line no-console
  app.use(jsonErrorHandler({ log: { warn: (line) => console.warn(line) }, tag: 'VALIDATOR' }));

  return app;
}
