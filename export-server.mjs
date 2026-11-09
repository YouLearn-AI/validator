// Entry point of the export renderer service (ops I-1313). It runs from the interactive renderer's image
// (Dockerfile.video) with its own entry point, as the layout checker does: Cloud Run
// `--command node --args export-server.mjs`.
//
// EXPORT_PRINT_URL: the web app's print page (for example https://app.youlearn.ai/export-print). The renderer
// opens it with the output's language appended (/en, /ar), never a URL from a request. A print page on this
// machine (http://localhost:3000/export-print, local development) is the one origin the egress guard lets
// through without its address check, by its exact host and port; every other loopback or private address stays
// refused. RENDER_API_KEY: the key the backend sends, always required.
import { GuardedBrowser } from './guarded-browser.mjs';
import { listenWhenReady } from './check-app.mjs';
import { createExportApp } from './export-app.mjs';
import { createExportRenderer, printOrigin } from './export-renderer.mjs';

const printUrl = process.env.EXPORT_PRINT_URL || '';
const origin = printOrigin(printUrl);
if (!origin) {
  // eslint-disable-next-line no-console
  console.error('[EXPORT_PDF] EXPORT_PRINT_URL is not an http(s) URL: every export is refused');
}
const trusted = origin?.loopback ? [{ host: origin.host, port: origin.port }] : [];
if (trusted.length) {
  // eslint-disable-next-line no-console
  console.warn('[EXPORT_PDF] the print page is on this machine: its origin alone skips the egress address check');
}

// As in check-server.mjs: a Chromium that never gets ready is ended by exiting the process (Playwright's exit
// handler kills it), and Cloud Run starts a fresh instance. The outputs are students' text: the egress guard's
// refusals name no host.
const browser = new GuardedBrowser({
  killable: true,
  guard: { logHosts: false, trusted },
  onStuckLaunch: () => {
    // eslint-disable-next-line no-console
    console.error('[EXPORT_PDF] restarting the instance: Chromium did not start');
    setTimeout(() => process.exit(1), 2000);
  },
});
const app = createExportApp({
  renderPdf: origin ? createExportRenderer(browser, { printUrl }) : async () => {
    throw new Error('unconfigured');
  },
});

let closing = false;
const listening = listenWhenReady(app, browser, {
  port: process.env.PORT || 3002, closing: () => closing, tag: 'EXPORT_PDF', name: 'Export renderer',
});

const shutdown = async () => {
  closing = true;
  await browser.close();
  const server = await listening.catch(() => null);
  if (server) server.close(() => process.exit(0));
  else process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
