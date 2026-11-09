// A PDF of saved outputs (a chat answer, a summary), drawn by the web app's own print page (ops I-1313).
//
// The caller (the backend) sends the outputs as data, never a URL: the page this renderer opens is its own
// configuration (EXPORT_PRINT_URL, export-server.mjs), the web app's print route. The handshake with that page:
//   1. The page mounts, defines window.__youlearnExportRender and sets <html data-export-state="waiting">.
//   2. The renderer calls window.__youlearnExportRender(document) with the outputs.
//   3. The page draws them with the same components the chat and the summary view use (Markdown, math,
//      diagrams, images, right-to-left text), waits for its fonts, images and diagrams, and sets
//      data-export-state="ready" (or "failed"), with counts in data-export-diagrams and data-export-images-failed.
//   4. The renderer prints the page to an A4 PDF.
// The viewport is the A4 page's printable width, so what the page lays out on screen is what prints.
//
// The page runs in the GuardedBrowser (guarded-browser.mjs): the sandbox on and every request through the egress
// guard, so an image or a link in a student's output reaches public addresses only. The context has no cookies:
// the page is signed in as nobody. One render at a time per instance; a hard deadline ends a render that runs too
// long. Logs hold codes, counts and times only, never the outputs' text, titles or the URL.

import { errorCode } from './request-errors.mjs';

export const EXPORT_DEFAULTS = Object.freeze({
  // A4 less the margins below, in CSS pixels (96 per inch): 182 mm wide.
  viewport: Object.freeze({ width: 688, height: 1000 }),
  format: 'A4',
  margin: Object.freeze({ top: '16mm', bottom: '18mm', left: '14mm', right: '14mm' }),
  gotoTimeoutMs: 30_000,
  // A 600k-character summary with 50 diagrams drew and printed in about 2 s on a Mac (I-1177); Cloud Run's CPUs
  // are slower, and diagrams wait on their own renderers.
  deadlineMs: 90_000,
  // The whole teardown after a render or its deadline: close the context, else reset the browser. deadlineMs +
  // teardownMs + a reset (at most 15 s, guarded-browser.mjs) stays under the service's 120 s request timeout.
  teardownMs: 15_000,
  // A PDF larger than this is refused: the backend holds it in memory to send it on.
  maxBytes: 60_000_000,
});

// Page number and count, centred in the footer: no text from the outputs, so nothing needs a direction.
const FOOTER = '<div style="width:100%;font-size:8px;color:#666;text-align:center;font-family:sans-serif">'
  + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

// A language tag as the web app names its locales (en, pt-BR, zh-CN): the only caller text in the page's URL.
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The print page's host and port, and whether it is on this machine; null when `url` is not http(s). */
export function printOrigin(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return { host: parsed.hostname, port, loopback: LOOPBACK_HOSTS.has(parsed.hostname) };
}

/** The print page for one language: EXPORT_PRINT_URL/<language>, English for anything that is not a tag. */
export function printPageUrl(printUrl, language) {
  const tag = typeof language === 'string' && LANGUAGE_TAG.test(language) ? language : 'en';
  const url = new URL(String(printUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${tag}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export class ExportBusy extends Error {
  constructor() {
    super('An export is already running on this instance');
    this.name = 'ExportBusy';
  }
}

/** A render that failed. Its message names only the stage and an allowlisted code. */
export class ExportFailed extends Error {
  constructor(stage, code) {
    super(`Export failed at ${stage} (${code})`);
    this.name = 'ExportFailed';
    this.stage = stage;
    this.code = code;
  }
}

export class ExportTimeout extends Error {
  constructor(ms) {
    super(`Export exceeded ${ms} ms`);
    this.name = 'ExportTimeout';
  }
}

function within(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('teardown')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A renderPdf bound to one GuardedBrowser and one print page.
 * @param {import('./guarded-browser.mjs').GuardedBrowser} guardedBrowser
 * @param {{ printUrl: string, options?: object, log?: Console }} config
 */
export function createExportRenderer(guardedBrowser, { printUrl, options = {}, log = console }) {
  const o = { ...EXPORT_DEFAULTS, ...options };
  let busy = false;

  /**
   * Print `document` ({ title, language, direction, outputs: [{ kind, title, chunks }] }) to a PDF.
   * @returns {Promise<{ pdf: Buffer, diagrams: number, imagesFailed: number, ms: number, warm: boolean }>}
   * @throws {ExportBusy} another export is running here
   * @throws {ExportTimeout} the deadline passed
   * @throws {ExportFailed} anything else, by stage and code only
   */
  return async function renderPdf(document) {
    if (busy) throw new ExportBusy();
    busy = true;
    const t0 = Date.now();
    const warm = guardedBrowser.running();
    let stage = 'launch';
    let context = null;
    // Set when the render ends (the deadline included): a context that opens after that is closed at once.
    let ended = false;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ExportTimeout(o.deadlineMs)), o.deadlineMs);
    });
    expired.catch(() => {});
    try {
      const work = (async () => {
        const opened = await guardedBrowser.newContext({
          viewport: { ...o.viewport },
          // Print colours and backgrounds as the page sets them, light: the PDF is paper.
          colorScheme: 'light',
          locale: typeof document.language === 'string' && document.language ? document.language : undefined,
        });
        if (ended) {
          await within(opened.close(), o.teardownMs).catch(() => {});
          throw new ExportTimeout(o.deadlineMs);
        }
        context = opened;
        const page = await context.newPage();
        stage = 'load';
        await page.goto(printPageUrl(printUrl, document.language), {
          waitUntil: 'domcontentloaded', timeout: o.gotoTimeoutMs,
        });
        await page.waitForFunction(
          () => document.documentElement.dataset.exportState === 'waiting',
          undefined,
          { timeout: o.gotoTimeoutMs },
        );
        stage = 'draw';
        await page.evaluate((doc) => window.__youlearnExportRender(doc), document);
        await page.waitForFunction(
          () => ['ready', 'failed'].includes(document.documentElement.dataset.exportState),
          undefined,
          { timeout: 0, polling: 100 },
        );
        const drawn = await page.evaluate(() => ({
          state: document.documentElement.dataset.exportState,
          diagrams: Number(document.documentElement.dataset.exportDiagrams) || 0,
          imagesFailed: Number(document.documentElement.dataset.exportImagesFailed) || 0,
        }));
        if (drawn.state !== 'ready') throw new ExportFailed('draw', 'page_failed');
        stage = 'print';
        const pdf = await page.pdf({
          format: o.format,
          printBackground: true,
          margin: { ...o.margin },
          displayHeaderFooter: true,
          headerTemplate: '<div></div>',
          footerTemplate: FOOTER,
        });
        if (pdf.length > o.maxBytes) throw new ExportFailed('print', 'too_large');
        return { pdf, diagrams: drawn.diagrams, imagesFailed: drawn.imagesFailed };
      })();
      work.catch(() => {});
      const result = await Promise.race([work, expired]);
      const ms = Date.now() - t0;
      log.info(`[EXPORT_PDF] ok outputs=${document.outputs.length} diagrams=${result.diagrams} `
        + `images_failed=${result.imagesFailed} bytes=${result.pdf.length} warm=${warm} ms=${ms}`);
      return { ...result, ms, warm };
    } catch (error) {
      if (error instanceof ExportTimeout) {
        log.warn(`[EXPORT_PDF] timed_out stage=${stage} warm=${warm} ms=${Date.now() - t0}`);
        throw error;
      }
      // The stage and a code only: a Playwright error quotes the URL and text the page threw.
      const code = error instanceof ExportFailed ? error.code : errorCode(error);
      log.error(`[EXPORT_PDF] failed stage=${stage} code=${code} warm=${warm} ms=${Date.now() - t0}`);
      throw error instanceof ExportFailed ? error : new ExportFailed(stage, code);
    } finally {
      ended = true;
      clearTimeout(timer);
      // A context that won't close (a page stuck in a loop holds its renderer) ends with Chromium: the next
      // export launches a new one.
      const closed = context
        ? await within(context.close(), o.teardownMs).then(() => true, () => false)
        : true;
      if (!closed) {
        log.warn('[EXPORT_PDF] teardown stalled; resetting the browser');
        await guardedBrowser.reset().catch(() => {});
      }
      busy = false;
    }
  };
}
