import { createApp } from './app.mjs';
import { closeBrowser } from './screenshot-renderer.mjs';

const app = createApp();
const port = process.env.PORT || 3002;

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
