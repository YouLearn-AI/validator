// Entry point of the interactive video renderer service (ops I-609). Dockerfile.video runs it.
import { GuardedBrowser } from './guarded-browser.mjs';
import { createVideoApp } from './video-app.mjs';
import { createVideoRenderer } from './video-renderer.mjs';

// A Chromium that never gets ready can't be killed from here (Playwright holds it); exiting the process runs
// Playwright's exit handler, which kills its process group and removes its profile, and Cloud Run starts a
// fresh instance. The render in flight is answered first.
const browser = new GuardedBrowser({
  onStuckLaunch: () => {
    // eslint-disable-next-line no-console
    console.error('[RENDER_VIDEO] restarting the instance: Chromium did not start');
    setTimeout(() => process.exit(1), 2000);
  },
});
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
