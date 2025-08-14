import express from 'express';
import { validateDiagramSyntax } from './validator.mjs';

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json({ limit: '256kb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Validate Mermaid diagram syntax
app.post('/validate', async (req, res) => {
  const diagram = typeof req.body === 'string' ? req.body : req.body?.diagram;

  if (typeof diagram !== 'string' || diagram.trim().length === 0) {
    return res.status(400).json({ valid: false, error: 'Body must include a non-empty "diagram" string' });
  }

  const result = await validateDiagramSyntax(diagram);
  if (result.valid) return res.json({ valid: true });
  return res.status(400).json(result);
});

// 404 for other routes
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Mermaid validator listening on http://localhost:${port}`);
});


