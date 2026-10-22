// Entry point of the interactive video renderer service (ops I-609). Dockerfile.video runs it.
import { GuardedBrowser } from './guarded-browser.mjs';
import { createVideoApp } from './video-app.mjs';
import { createVideoRenderer } from './video-renderer.mjs';

const browser = new GuardedBrowser();
const app = createVideoApp({ renderVideo: createVideoRenderer(browser) });
const port = process.env.PORT || 3002;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Video renderer listening on http://localhost:${port}`);
});

const shutdown = async () => {
  await browser.close();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
