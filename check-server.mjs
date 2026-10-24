// Entry point of the interactive layout checker service (ops I-610, plan 012). It runs from the interactive
// renderer's image (Dockerfile.video) with its own entry point: Cloud Run `--command node --args check-server.mjs`.
import { GuardedBrowser } from './guarded-browser.mjs';
import { createCheckApp } from './check-app.mjs';
import { createLayoutChecker } from './layout-check.mjs';
import { errorCode } from './request-errors.mjs';

// As in video-server.mjs: a Chromium that never gets ready is ended by exiting the process (Playwright's exit
// handler kills it), and Cloud Run starts a fresh instance. The pages are model-written HTML, which can put its
// text in a hostname: the egress guard's refusals name no host here.
const browser = new GuardedBrowser({
  killable: true,
  guard: { logHosts: false },
  onStuckLaunch: () => {
    // eslint-disable-next-line no-console
    console.error('[CHECK_LAYOUT] restarting the instance: Chromium did not start');
    setTimeout(() => process.exit(1), 2000);
  },
});
const app = createCheckApp({ checkLayout: createLayoutChecker(browser) });
const port = process.env.PORT || 3002;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Layout checker listening on http://localhost:${port}`);
  // Chromium starts with the instance, so the first check (the backend sends GET /health when the model starts
  // writing) finds it running. A failed start is retried by the first check.
  const t0 = Date.now();
  browser.browser().then(
    // eslint-disable-next-line no-console
    () => console.log(`[CHECK_LAYOUT] browser ready ms=${Date.now() - t0}`),
    // eslint-disable-next-line no-console
    (error) => console.error(`[CHECK_LAYOUT] browser start failed code=${errorCode(error)}`),
  );
});

const shutdown = async () => {
  await browser.close();
  server.close(() => process.exit(0));
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
