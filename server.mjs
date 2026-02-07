import express from 'express';
import { validateDiagramSyntax } from './validator.mjs';
import { validateLatex } from './latex-validator.mjs';
import { renderScreenshot, closeBrowser } from './screenshot-renderer.mjs';

const app = express();
const port = process.env.PORT || 3002;

// Default limit for most endpoints
app.use(express.json({ limit: '256kb' }));

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
app.post('/render-screenshot', express.json({ limit: '2mb' }), async (req, res) => {
  const { html, url, width, height } = req.body;

  const hasHtml = typeof html === 'string' && html.trim().length > 0;
  const hasUrl = typeof url === 'string' && url.trim().length > 0;

  if (!hasHtml && !hasUrl) {
    return res.status(400).json({
      success: false,
      error: 'Body must include a non-empty "html" or "url" string'
    });
  }

  // Validate dimensions if provided
  const viewportWidth = typeof width === 'number' && width > 0 && width <= 3840 ? width : 1280;
  const viewportHeight = typeof height === 'number' && height > 0 && height <= 2160 ? height : 720;

  try {
    const screenshot = await renderScreenshot({
      url: hasUrl ? url : undefined,
      html: hasHtml ? html : undefined,
      width: viewportWidth,
      height: viewportHeight
    });
    return res.json({
      success: true,
      screenshot
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Screenshot rendering failed:', error);
    return res.status(500).json({
      success: false,
      error: `Screenshot rendering failed: ${error.message}`
    });
  }
});

// 404 for other routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Validator service listening on http://localhost:${port}`);
});

// Graceful shutdown
const shutdown = async () => {
  // eslint-disable-next-line no-console
  console.log('Shutting down gracefully...');
  await closeBrowser();
  server.close(() => {
    // eslint-disable-next-line no-console
    console.log('Server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
