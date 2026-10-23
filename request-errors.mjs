// Errors that reach a response or a log line in these services carry fixed text and allowlisted codes only
// (ops I-609 review). A request body, a URL (its query can hold a token) and page text (an interactive is a
// user's material) never reach a log: Playwright's errors quote the URL and page-thrown text, and body-parser's
// errors quote the body.

// body-parser error types -> [status, code, answer].
const BODY_ERRORS = {
  'entity.parse.failed': [400, 'malformed_json', 'Request body is not valid JSON'],
  'entity.too.large': [413, 'body_too_large', 'Request body is too large'],
  'encoding.unsupported': [415, 'encoding_unsupported', 'Content encoding is not supported'],
  'charset.unsupported': [415, 'charset_unsupported', 'Charset is not supported'],
  'request.aborted': [400, 'request_aborted', 'Request was aborted'],
  'request.size.invalid': [400, 'request_size_invalid', 'Request size did not match its content length'],
  'parameters.too.many': [413, 'too_many_parameters', 'Too many parameters'],
};

// Error names that may appear in a log, mapped to codes.
const NAME_CODES = {
  TimeoutError: 'timeout',
  AbortError: 'aborted',
  DnsUnavailable: 'dns',
  RenderTimeout: 'deadline',
  RenderBusy: 'busy',
  UrlRefused: 'url_refused',
  FfmpegFailed: 'ffmpeg',
};

/** An allowlisted code for an error, from its name only (never its message). */
export function errorCode(error) {
  return NAME_CODES[error?.name] || 'error';
}

/**
 * Express error middleware (four arguments): a fixed JSON answer and one log line with a code, for errors
 * raised before or by a route (a body that doesn't parse, is too large or is compressed; an unexpected throw).
 * @param {{ log?: Console, tag: string }} options
 */
export function jsonErrorHandler({ log = console, tag }) {
  // eslint-disable-next-line no-unused-vars
  return (error, _req, res, _next) => {
    const known = BODY_ERRORS[error?.type];
    const [status, code, message] = known || [500, errorCode(error), 'Internal error'];
    log.warn(`[${tag}] request failed: ${code}`);
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.status(status).json({ success: false, error: message, code });
  };
}
