// Entry point of the interactive layout checker service (ops I-610, plan 012). It runs from the interactive
// renderer's image (Dockerfile.video) with its own entry point: Cloud Run `--command node --args check-server.mjs`.
import { GuardedBrowser } from './guarded-browser.mjs';
import { createCheckApp, listenWhenReady } from './check-app.mjs';
import { createLayoutChecker } from './layout-check.mjs';

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

// Chromium starts while the instance starts, before the port opens (listenWhenReady says why), so the first
// request finds it running: the backend sends GET /health when the model starts writing.
let closing = false;
const listening = listenWhenReady(app, browser, { port: process.env.PORT || 3002, closing: () => closing });

const shutdown = async () => {
  closing = true;
  await browser.close();
  const server = await listening.catch(() => null);
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
