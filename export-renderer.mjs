// A PDF or a Word file of saved outputs (a chat answer first), drawn by the web app's own print page (ops I-1313).
//
// The caller (the backend) sends the outputs as data, never a URL: the page this renderer opens is its own
// configuration (EXPORT_PRINT_URL, export-server.mjs), the web app's print route. The handshake with that page:
//   1. The page loads and defines window.__youlearnExportRender(document).
//   2. The renderer calls it with the outputs. It draws them with the same components the chat uses (Markdown,
//      math, diagrams, images, right-to-left text), waits for its fonts, images and diagrams, and resolves with
//      { diagrams, imagesFailed } (counts), or rejects.
//   3. The renderer prints the page to an A4 PDF, or reads the drawn page into a Word file (export-docx.mjs).
// The viewport is the A4 page's printable width, so what the page lays out on screen is what prints.
//
// What the page may reach is only what a print needs. In the browser (exportRequestAllowed): any request to the
// print page's own origin (its scripts, styles, fonts), and images over HTTPS on port 443; every other request is
// aborted and WebSockets are closed. Playwright sends a redirect's next hop on without asking the route again, so
// every request but an image is fetched by the renderer through the same guard and a redirect is refused: a
// request to the print page's origin is never sent on to another origin. Under that, the GuardedBrowser (guarded-browser.mjs) keeps the sandbox on
// and sends every request through the egress guard, which the export service runs HTTPS-only: public addresses on
// port 443, never an internal one. The context has no cookies: the page is signed in as nobody. One render at a
// time per instance; a hard deadline ends a render that runs too long. Logs hold codes, counts and times only,
// never the outputs' text, titles or a URL.

import { errorCode } from './request-errors.mjs';
import {
  DOCX_TYPE, WORD_LIMITS, WordFailed, wordPictures, wordSource,
} from './export-docx.mjs';

// The files a render makes, by format: what it answers and its type.
export const EXPORT_FORMATS = Object.freeze({
  pdf: Object.freeze({ type: 'application/pdf' }),
  docx: Object.freeze({ type: DOCX_TYPE }),
});

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
  // A file larger than this is refused: the backend holds it in memory to send it on.
  maxBytes: 60_000_000,
});

// Page number and count, centred in the footer: no text from the outputs, so nothing needs a direction.
const FOOTER = '<div style="width:100%;font-size:8px;color:#666;text-align:center;font-family:sans-serif">'
  + '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

// A language tag as the web app names its locales (en, pt-BR, zh-CN): the only caller text in the page's URL.
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
// The statuses a browser follows to a Location: refused for anything but an image (createExportRenderer).
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The language tag to print in: `language` when it is a tag, else English. */
export function languageTag(language) {
  return typeof language === 'string' && LANGUAGE_TAG.test(language) ? language : 'en';
}

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
  return { origin: parsed.origin, host: parsed.hostname, port, loopback: LOOPBACK_HOSTS.has(parsed.hostname) };
}

/** The print page for one language: EXPORT_PRINT_URL/<language>, English for anything that is not a tag. */
export function printPageUrl(printUrl, language) {
  const url = new URL(String(printUrl));
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${languageTag(language)}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

/**
 * Whether the print page may make this request: anything from the print page's own origin, and images over
 * HTTPS on the default port. Everything else (a fetch, a script, a frame or a font from anywhere else, plain
 * http, another port) is aborted before it leaves the browser.
 * @param {{ url: string, resourceType: string }} request
 * @param {string} allowedOrigin the print page's origin (new URL(printUrl).origin)
 */
export function exportRequestAllowed({ url, resourceType }, allowedOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin === allowedOrigin) return true;
  return resourceType === 'image' && parsed.protocol === 'https:' && parsed.port === '';
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

const isCount = (value) => Number.isInteger(value) && value >= 0;

/**
 * A render bound to one GuardedBrowser and one print page.
 * @param {import('./guarded-browser.mjs').GuardedBrowser} guardedBrowser
 * @param {{ printUrl: string, word?: import('./export-docx.mjs').WordConverter,
 *   options?: Partial<typeof EXPORT_DEFAULTS>, log?: Console }} config
 *   word: the converter a Word file needs; without it every Word render fails (code word_unavailable).
 */
export function createExportRenderer(guardedBrowser, { printUrl, word = null, options = {}, log = console }) {
  const o = { ...EXPORT_DEFAULTS, ...options };
  const allowedOrigin = new URL(printUrl).origin;
  let busy = false;

  /**
   * Draw `doc` ({ title, language, direction, outputs: [{ kind, title, chunks }] }) and make it a file: an A4
   * PDF, or a Word file (`format` "docx") of the same parts.
   * @param {object} doc
   * @param {keyof typeof EXPORT_FORMATS} [format]
   * @returns {Promise<{ file: Buffer, diagrams: number, imagesFailed: number, blocked: number, ms: number, warm: boolean }>}
   *   imagesFailed: images the page could not load, plus, in a Word file, pictures left out of it
   * @throws {ExportBusy} another export is running here
   * @throws {ExportTimeout} the deadline passed
   * @throws {ExportFailed} anything else, by stage and code only
   */
  return async function render(doc, format = 'pdf') {
    if (!Object.hasOwn(EXPORT_FORMATS, format)) throw new ExportFailed('config', 'bad_format');
    if (busy) throw new ExportBusy();
    busy = true;
    const t0 = Date.now();
    const deadlineAt = t0 + o.deadlineMs;
    const warm = guardedBrowser.running();
    const language = languageTag(doc.language);
    let stage = 'launch';
    let context = null;
    // Requests the page made that a print does not need (exportRequestAllowed), aborted in the browser.
    let blocked = 0;
    // Set when the render ends (the deadline included): a context that opens after that is closed at once, and a
    // Word conversion that has not started never starts.
    let ended = false;
    let succeeded = false;
    let timer;
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ExportTimeout(o.deadlineMs)), o.deadlineMs);
    });
    expired.catch(() => {});
    try {
      const work = (async () => {
        const opened = await guardedBrowser.newContext({
          viewport: { ...o.viewport },
          // Print colours and backgrounds as the page sets them, light: the file is paper.
          colorScheme: 'light',
          locale: language,
          // A Word file's pictures are captured from the page: at twice the size, they stay sharp in print.
          deviceScaleFactor: format === 'docx' ? WORD_LIMITS.deviceScaleFactor : 1,
        });
        if (ended) {
          await within(opened.close(), o.teardownMs).catch(() => {});
          throw new ExportTimeout(o.deadlineMs);
        }
        context = opened;
        await context.routeWebSocket(/.*/, (ws) => ws.close());
        await context.route('**/*', async (route) => {
          const request = route.request();
          const resourceType = request.resourceType();
          if (!exportRequestAllowed({ url: request.url(), resourceType }, allowedOrigin)) {
            blocked += 1;
            return route.abort('blockedbyclient').catch(() => {});
          }
          // An image follows its redirects in the browser: each hop is still an image, and the egress guard checks
          // each hop's address. Playwright sends a redirect's next hop on without calling this handler, so every
          // other request is fetched here (through the same egress guard) with no redirect followed: a request from
          // the print page's origin can never be sent on to another origin.
          if (resourceType === 'image') return route.continue().catch(() => {});
          let response;
          try {
            // maxRedirects 0: a redirect comes back as it is, never followed.
            response = await route.fetch({ maxRedirects: 0, timeout: o.gotoTimeoutMs });
          } catch {
            // The guard refused it, it timed out, or the render ended.
            return route.abort('failed').catch(() => {});
          }
          if (REDIRECT_STATUSES.has(response.status())) {
            blocked += 1;
            return route.abort('blockedbyclient').catch(() => {});
          }
          return route.fulfill({ response }).catch(() => {});
        });
        const page = await context.newPage();
        stage = 'load';
        await page.goto(printPageUrl(printUrl, language), { waitUntil: 'domcontentloaded', timeout: o.gotoTimeoutMs });
        await page.waitForFunction(
          () => typeof window.__youlearnExportRender === 'function',
          undefined,
          { timeout: o.gotoTimeoutMs },
        );
        stage = 'draw';
        let drawn;
        try {
          drawn = await page.evaluate(async (outputs) => {
            const counts = await window.__youlearnExportRender(outputs);
            await document.fonts.ready;
            return counts;
          }, doc);
        } catch {
          // Not the error itself: its message is the page's, which can quote the outputs.
          throw new ExportFailed('draw', 'page_failed');
        }
        if (!drawn || !isCount(drawn.diagrams) || !isCount(drawn.imagesFailed)) {
          throw new ExportFailed('draw', 'bad_answer');
        }
        stage = format === 'docx' ? 'word' : 'print';
        const made = format === 'docx'
          ? await wordFile(page, language, () => (ended ? 0 : deadlineAt - Date.now()))
          : { file: await printPdf(page), left: 0 };
        if (made.file.length > o.maxBytes) throw new ExportFailed(stage, 'too_large');
        return { file: made.file, diagrams: drawn.diagrams, imagesFailed: drawn.imagesFailed + made.left };
      })();
      work.catch(() => {});
      const result = await Promise.race([work, expired]);
      succeeded = true;
      const ms = Date.now() - t0;
      log.info(`[EXPORT] ok format=${format} outputs=${doc.outputs.length} diagrams=${result.diagrams} `
        + `images_failed=${result.imagesFailed} blocked=${blocked} bytes=${result.file.length} warm=${warm} ms=${ms}`);
      return { ...result, blocked, ms, warm };
    } catch (error) {
      if (error instanceof ExportTimeout) {
        log.warn(`[EXPORT] timed_out format=${format} stage=${stage} blocked=${blocked} warm=${warm} ms=${Date.now() - t0}`);
        throw error;
      }
      // The stage and a code only: a Playwright error quotes the URL and text the page threw.
      const code = error instanceof ExportFailed || error instanceof WordFailed ? error.code : errorCode(error);
      log.error(`[EXPORT] failed format=${format} stage=${stage} code=${code} blocked=${blocked} warm=${warm} `
        + `ms=${Date.now() - t0}`);
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
        log.warn('[EXPORT] teardown stalled; resetting the browser');
        await guardedBrowser.reset().catch(() => {});
      }
      // A Word render that failed or passed its deadline may have left its conversion running: it ends with the
      // worker before the next render can start, so it never runs into the next one's time.
      if (!succeeded && format === 'docx' && word) await word.close();
      busy = false;
    }
  };

  function printPdf(page) {
    return page.pdf({
      format: o.format,
      printBackground: true,
      margin: { ...o.margin },
      displayHeaderFooter: true,
      headerTemplate: '<div></div>',
      footerTemplate: FOOTER,
    });
  }

  /** The drawn page as a Word file in `language`, in the time `remaining()` gives (ms, read when the conversion
   * starts); `left`: pictures left out of it. */
  async function wordFile(page, language, remaining) {
    if (!word) throw new ExportFailed('word', 'word_unavailable');
    let source;
    try {
      source = await page.evaluate(wordSource, WORD_LIMITS);
    } catch {
      // Not the error itself: its message is the page's.
      throw new ExportFailed('word', 'page_failed');
    }
    const pictures = await wordPictures(page, source.pictures, o.gotoTimeoutMs);
    const timeoutMs = remaining();
    if (timeoutMs <= 0) throw new ExportTimeout(o.deadlineMs);
    // The conversion's time is what is left of the render's: running out of it is the render's deadline.
    const { docx, missing } = await word.convert({ html: source.html, pictures, language }, timeoutMs).catch((error) => {
      throw error instanceof WordFailed && error.code === 'timeout' ? new ExportTimeout(o.deadlineMs) : error;
    });
    return { file: docx, left: source.skipped + missing };
  }
}
