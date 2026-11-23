// Prints a web-app print page to PDF (ops I-1177): the summary PDF export.
//
// The backend sends the print page's URL and the document (a summary's chunks). The URL's origin must be one that
// PDF_PAGE_ORIGINS lists; the page then opens in the GuardedBrowser (sandbox on, every request through the egress
// guard), in a fresh context with no cookies, so nobody is signed in inside Chrome. The document goes in with
// page.evaluate, through the global the page defines (print-page-contract.mjs), never in the URL, and only after
// the page checks, in the same call, that it is still on a listed origin. The renderer waits for the page's ready or
// error signal, then returns page.pdf(). A navigation request (the page, a frame or a popup) to an origin off the
// list is aborted before it is sent, and one in the main frame ends the render. A server redirect's next hop is not
// routed (Playwright routes only a redirect's first request), so it is sent; it carries no document and no cookies,
// and the render ends as soon as the main frame asks for it.
//
// One render at a time per instance; a hard deadline ends a render that runs too long. Logs carry codes, counts
// and times only: the document is a student's summary, and page errors and console output are never logged.

import { checkUrl, UrlRefused } from './egress-guard.mjs';
import {
  CONTRACT_VERSION, ERROR, ERROR_ATTRIBUTE, PAGE_ERROR_CODES, PRINT_GLOBAL, READY, STATE_ATTRIBUTE,
  UNNAMED_PAGE_ERROR,
} from './print-page-contract.mjs';
import { errorCode } from './request-errors.mjs';

export const PDF_DEFAULTS = Object.freeze({
  // Opening the page, up to its load event.
  gotoTimeoutMs: 30_000,
  // From the load event until the page defines its global.
  contractTimeoutMs: 10_000,
  // The whole render, launch to PDF. The backend waits a little longer (providers/summary_pdf.py).
  deadlineMs: 90_000,
  // Closing the context after a render, before Chromium is reset when that stalls.
  teardownMs: 5000,
  // How often the ready signal is read.
  pollMs: 100,
  // The page's screen while it draws: Letter's width at 96 px per inch.
  viewport: Object.freeze({ width: 816, height: 1056 }),
  // What the document may hold. A 604k-character summary is a few MB of JSON (the plan's longest test); the body
  // limit (pdf-app.mjs) is the real cap. The backend cuts a title to this length (providers/pdf_renderer.py).
  maxChunks: 50_000,
  maxTitleLength: 500,
});

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

// The egress guard's settings for this service: a refused host is logged without its name, since a summary's
// image link can put its text in a hostname (egress-guard.mjs).
export const PDF_GUARD = Object.freeze({ logHosts: false });

export class PdfBusy extends Error {
  constructor() {
    super('A render is already running on this instance');
    this.name = 'PdfBusy';
  }
}

/** The page URL's origin is not one PDF_PAGE_ORIGINS lists, or a navigation left it. */
export class PageRefused extends Error {
  constructor(reason) {
    super(`Print page refused (${reason})`);
    this.name = 'PageRefused';
    this.reason = reason;
  }
}

/** The page set its error signal; `code` is one of PAGE_ERROR_CODES, or UNNAMED_PAGE_ERROR. */
export class PageFailed extends Error {
  constructor(code) {
    super(`The print page reported an error (${code})`);
    this.name = 'PageFailed';
    this.code = code;
  }
}

/** The render passed its deadline at `stage`. */
export class PdfTimeout extends Error {
  constructor(stage) {
    super(`Render passed its deadline at ${stage}`);
    this.name = 'PdfTimeout';
    this.stage = stage;
  }
}

/** Anything else, named by stage and an allowlisted code only (a Playwright error quotes page text and URLs). */
export class PdfFailed extends Error {
  constructor(stage, code) {
    super(`Render failed at ${stage} (${code})`);
    this.name = 'PdfFailed';
    this.stage = stage;
    this.code = code;
  }
}

/**
 * The allowed print page origins from a comma-separated list (PDF_PAGE_ORIGINS): each an http(s) origin with no
 * path, such as https://app.youlearn.ai. An entry that is not one is dropped and logged, never widened.
 * @returns {Set<string>}
 */
export function parseOrigins(text, log = console) {
  const origins = new Set();
  for (const raw of String(text || '').split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    let parsed;
    try {
      parsed = new URL(entry);
    } catch {
      parsed = null;
    }
    const plain = parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && !parsed.username && !parsed.password && parsed.origin === entry.replace(/\/$/, '');
    if (!plain) {
      log.error('[RENDER_PDF] a PDF_PAGE_ORIGINS entry is not an http(s) origin; it is ignored');
      continue;
    }
    origins.add(parsed.origin);
  }
  return origins;
}

function allowed(url, origins) {
  try {
    return origins.has(new URL(url).origin);
  } catch {
    return false;
  }
}

/** The print page URL, parsed, when its origin is listed; else PageRefused. */
export function checkPageUrl(url, origins) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw new PageRefused('malformed');
  }
  if (parsed.username || parsed.password) throw new PageRefused('credentials');
  if (!origins.has(parsed.origin)) throw new PageRefused('origin');
  return parsed;
}

/**
 * The document the page gets, checked: { title, language, chunks } with chunks a non-empty array of objects.
 * Returns the input for the page, or null when the document is not one.
 */
export function pageInput(document, o = PDF_DEFAULTS) {
  if (!document || typeof document !== 'object') return null;
  const { title = null, language = null, chunks } = document;
  if (!Array.isArray(chunks) || chunks.length === 0 || chunks.length > o.maxChunks) return null;
  if (!chunks.every((c) => c !== null && typeof c === 'object' && !Array.isArray(c))) return null;
  if (title !== null && (typeof title !== 'string' || title.length > o.maxTitleLength)) return null;
  if (language !== null && (typeof language !== 'string' || !LANGUAGE.test(language))) return null;
  return { version: CONTRACT_VERSION, title, language, chunks };
}

// `promise`, or null after `ms` (a timer that never keeps the process up).
function within(promise, ms) {
  let timer;
  return Promise.race([
    promise.then((value) => ({ value })),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * A renderPdf bound to one GuardedBrowser.
 * @param {import('./guarded-browser.mjs').GuardedBrowser} guardedBrowser
 * @param {{ origins: Set<string>, options?: object, log?: Console, checkOptions?: object }} config
 *   checkOptions: options for the egress pre-check (tests only: a fake lookup)
 */
export function createPdfRenderer(guardedBrowser, { origins, options = {}, log = console, checkOptions = {} }) {
  const o = { ...PDF_DEFAULTS, ...options };
  let busy = false;

  /**
   * @param {{ url: string, input: object }} request input from pageInput()
   * @returns {Promise<{ pdf: Buffer, timings: object }>}
   * @throws {PageRefused|UrlRefused|PdfBusy|PageFailed|PdfTimeout|PdfFailed}
   */
  return async function renderPdf({ url, input }) {
    const target = checkPageUrl(url, origins);
    if (busy) throw new PdfBusy();
    busy = true;
    const t0 = Date.now();
    const warm = guardedBrowser.running();
    let stage = 'check';
    let context = null;
    let opening = null;
    let pageErrors = 0;
    // A main-frame navigation off the listed origins (the page's own script, a redirect) ends the render at once.
    let strayed = false;
    let onStray;
    const leftOrigins = new Promise((_, reject) => { onStray = () => reject(new PageRefused('navigated')); });
    leftOrigins.catch(() => {});
    const times = {};
    const mark = (name) => { times[name] = Date.now() - t0; };
    let expired = false;
    let onExpire;
    const stopped = new Promise((_, reject) => { onExpire = () => reject(new PdfTimeout(stage)); });
    stopped.catch(() => {});
    const timer = setTimeout(() => {
      expired = true;
      onExpire();
    }, o.deadlineMs);
    // Each step races the deadline and a navigation away.
    const step = (promise) => Promise.race([promise, stopped, leftOrigins]);
    try {
      try {
        // Refused before a browser is touched; the egress proxy checks again, and checks every subresource and
        // redirect, when Chromium connects.
        await step(checkUrl(target.href, checkOptions));
        stage = 'launch';
        await step(guardedBrowser.browser());
        mark('launch_ms');
        stage = 'open';
        opening = guardedBrowser.newContext({ viewport: { ...o.viewport }, deviceScaleFactor: 1 });
        // A context that opens after the deadline is closed here: the teardown below has run already.
        opening.then((c) => { if (expired) c.close().catch(() => {}); }, () => {});
        context = await step(opening);
        const page = await step(context.newPage());
        // A navigation request off the listed origins; in the main frame it ends the render.
        const offList = (request) => {
          if (!request.isNavigationRequest() || allowed(request.url(), origins)) return false;
          let main = false;
          try {
            main = request.frame() === page.mainFrame();
          } catch {
            // A service worker's request has no frame (service workers are blocked).
          }
          if (main) {
            strayed = true;
            onStray();
          }
          return true;
        };
        // Aborted before it is sent: the page's, a frame's or a popup's. fallback(): any other handler still runs,
        // and with none the request goes on through the egress guard.
        await step(context.route('**/*', (route) => (
          offList(route.request()) ? route.abort('blockedbyclient') : route.fallback()
        ).catch(() => {})));
        // A redirect's next hop is never routed; its request event still names it.
        page.on('request', offList);
        // No second window: a popup is closed as it opens.
        context.on('page', (other) => { if (other !== page) other.close().catch(() => {}); });
        page.on('pageerror', () => { pageErrors += 1; });
        page.on('dialog', (dialog) => dialog.dismiss().catch(() => {}));
        page.on('framenavigated', (frame) => {
          if (frame !== page.mainFrame() || allowed(frame.url(), origins)) return;
          strayed = true;
          onStray();
        });
        const stayed = () => {
          if (strayed || !allowed(page.url(), origins)) throw new PageRefused('navigated');
        };

        stage = 'load';
        await step(page.goto(target.href, { waitUntil: 'load', timeout: o.gotoTimeoutMs }));
        stayed();
        mark('load_ms');

        stage = 'contract';
        await step(page.waitForFunction(
          ([name, version]) => {
            const api = window[name];
            return Boolean(api && typeof api.render === 'function' && api.version === version);
          },
          [PRINT_GLOBAL, CONTRACT_VERSION],
          { timeout: o.contractTimeoutMs, polling: o.pollMs },
        ));
        stayed();

        stage = 'render';
        // render() is called, not awaited: the page says it is done with its ready signal. The origin is checked in
        // the same call, so the document reaches only a page on a listed origin.
        const handed = await step(page.evaluate(([name, document, listed]) => {
          if (!listed.includes(window.location.origin)) return false;
          window[name].render(document);
          return true;
        }, [PRINT_GLOBAL, input, [...origins]]));
        if (!handed) {
          strayed = true;
          throw new PageRefused('navigated');
        }

        stage = 'ready';
        const signal = await step(page.waitForFunction(
          ([stateName, errorName, ready, error]) => {
            const data = document.documentElement.dataset;
            const state = data[stateName];
            if (state === ready) return { state };
            if (state === error) return { state, code: String(data[errorName] || '') };
            return false;
          },
          [STATE_ATTRIBUTE, ERROR_ATTRIBUTE, READY, ERROR],
          { timeout: 0, polling: o.pollMs },
        ));
        const { state, code } = await step(signal.jsonValue());
        stayed();
        mark('ready_ms');
        if (state === ERROR) throw new PageFailed(PAGE_ERROR_CODES.includes(code) ? code : UNNAMED_PAGE_ERROR);

        stage = 'pdf';
        const pdf = await step(page.pdf({ format: 'Letter', preferCSSPageSize: true, printBackground: true }));
        mark('pdf_ms');
        if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
          throw new PdfFailed('pdf', 'not_pdf');
        }
        const ms = Date.now() - t0;
        log.info(`[RENDER_PDF] status=ok chunks=${input.chunks.length} bytes=${pdf.length} warm=${warm} `
          + `page_errors=${pageErrors} launch_ms=${times.launch_ms} load_ms=${times.load_ms} `
          + `ready_ms=${times.ready_ms} pdf_ms=${times.pdf_ms} ms=${ms}`);
        return { pdf, timings: { total_ms: ms, ...times } };
      } catch (caught) {
        const ms = Date.now() - t0;
        // A step that failed because the page navigated away (its context was destroyed) is that navigation.
        const error = strayed && !expired ? new PageRefused('navigated') : caught;
        if (error instanceof PdfTimeout || expired) {
          log.warn(`[RENDER_PDF] status=timed_out stage=${stage} warm=${warm} page_errors=${pageErrors} ms=${ms}`);
          throw error instanceof PdfTimeout ? error : new PdfTimeout(stage);
        }
        if (error instanceof PageFailed) {
          log.warn(`[RENDER_PDF] status=page_error code=${error.code} page_errors=${pageErrors} ms=${ms}`);
          throw error;
        }
        if (error instanceof PageRefused) {
          log.warn(`[RENDER_PDF] status=refused reason=${error.reason} stage=${stage} ms=${ms}`);
          throw error;
        }
        if (error instanceof UrlRefused) throw error;
        if (error instanceof PdfFailed) {
          log.error(`[RENDER_PDF] failed stage=${error.stage} code=${error.code} ms=${ms}`);
          throw error;
        }
        // Its stage and code only: the error's message can quote the page or its URL.
        const failed = new PdfFailed(stage, errorCode(error));
        log.error(`[RENDER_PDF] failed stage=${failed.stage} code=${failed.code} warm=${warm} ms=${ms}`);
        throw failed;
      }
    } finally {
      clearTimeout(timer);
      // A context that won't close (a page stuck in a loop holds its renderer) ends with Chromium; the next render
      // launches a new one. So does a context still opening at the deadline: Chromium may be stuck.
      if (context) {
        const closed = await within(context.close().catch(() => {}), o.teardownMs);
        if (!closed) {
          log.warn('[RENDER_PDF] teardown stalled; resetting the browser');
          await guardedBrowser.reset().catch(() => {});
        }
      } else if (opening && expired) {
        log.warn('[RENDER_PDF] context open stalled; resetting the browser');
        await guardedBrowser.reset().catch(() => {});
      }
      busy = false;
    }
  };
}
