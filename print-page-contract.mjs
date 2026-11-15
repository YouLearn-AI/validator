// The print page contract (ops I-1177): what a web-app print page does so that pdf-renderer.mjs can print it.
// The web app's summary print page implements it (phase 2); test/fixtures/print-page/ is a fixture that does.
//
// 1. The page is a static page at an origin PDF_PAGE_ORIGINS lists. It needs no sign-in: Chrome opens it with no
//    cookies, and the document arrives only through the global below.
// 2. Once its script has loaded, the page defines window[PRINT_GLOBAL] = { version: CONTRACT_VERSION, render(input) }.
//    render(input) starts drawing and returns; a Promise it returns is not awaited. input is
//    { version, title: string|null, language: string|null, chunks: object[] }: the summary's chunks as the backend
//    stores them, in order. The page decides which chunks print and how, with the web export's own preparation
//    (every chunk that shows as Markdown, source and space_source included: ops I-1175).
// 3. Ready: once every chunk is drawn, fonts are loaded (document.fonts.ready), images have loaded or failed, and
//    each diagram is drawn or has fallen back, the page sets <html data-print-state="ready">.
// 4. Error: when it cannot draw the document, the page sets <html data-print-state="error" data-print-error="code">,
//    the code matching PAGE_ERROR_CODE (such as "bad_input" or "render_failed"). One failed diagram is not an
//    error: it prints as drawn (ops I-1175).
// 5. Print: the page lays itself out for print with CSS (@media print, and @page for the paper size and margins,
//    Letter with 0.75in margins as the web export has). The renderer prints with the page's @page size, print
//    backgrounds on, and Letter when the page sets no size.
// 6. The page never navigates away, opens a window or a dialog, or asks for anything. Page text, console output
//    and errors never reach the renderer's logs, only counts.

export const CONTRACT_VERSION = 1;
export const PRINT_GLOBAL = '__youlearnPrint';
// The <html> attributes (element.dataset names) the page sets.
export const STATE_ATTRIBUTE = 'printState';
export const ERROR_ATTRIBUTE = 'printError';
export const READY = 'ready';
export const ERROR = 'error';
export const PAGE_ERROR_CODE = /^[a-z][a-z0-9_]{0,31}$/;
