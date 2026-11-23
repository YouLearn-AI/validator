// Entry point of the PDF renderer service (ops I-1177): the summary PDF export. It runs from the interactive
// renderer's image (Dockerfile.video) with its own entry point, as the layout checker does: Cloud Run
// `--command node --args pdf-server.mjs`.
//
// Settings: PDF_API_KEY, its own key (required: with none, every render is refused); PDF_PAGE_ORIGINS, the
// comma-separated print page origins it may open (none: every render is refused); PORT.
import { GuardedBrowser } from './guarded-browser.mjs';
import { listenWhenReady } from './check-app.mjs';
import { createPdfApp } from './pdf-app.mjs';
import { createPdfRenderer, parseOrigins, PDF_GUARD } from './pdf-renderer.mjs';

// As in video-server.mjs: a Chromium that never gets ready is ended by exiting the process (Playwright's exit
// handler kills it), and Cloud Run starts a fresh instance.
const browser = new GuardedBrowser({
  killable: true,
  guard: { ...PDF_GUARD },
  onStuckLaunch: () => {
    // eslint-disable-next-line no-console
    console.error('[RENDER_PDF] restarting the instance: Chromium did not start');
    setTimeout(() => process.exit(1), 2000);
  },
});
const origins = parseOrigins(process.env.PDF_PAGE_ORIGINS);
// eslint-disable-next-line no-console
if (origins.size === 0) console.error('[RENDER_PDF] PDF_PAGE_ORIGINS lists no origin: every render is refused');
const app = createPdfApp({ renderPdf: createPdfRenderer(browser, { origins, checkOptions: PDF_GUARD }) });

// Chromium starts before the port opens (check-app.mjs listenWhenReady says why).
let closing = false;
const listening = listenWhenReady(app, browser, {
  port: process.env.PORT || 3002, closing: () => closing, tag: 'RENDER_PDF', name: 'PDF renderer',
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
