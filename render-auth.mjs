// The shared key for render endpoints (ops I-602) and the validate routes (ops I-743), like
// pdf-extract's X-API-KEY.
//
// RENDER_API_KEY is the key. RENDER_API_KEY_REQUIRED=true makes it required.
// The rollout keeps thumbnails working at every step:
//   1. The validator ships with the key set and not required: a request with
//      no key still renders, a request with the right key renders, a request
//      whose key does not match the configured one is refused (so a
//      misconfigured caller shows up before the key is required).
//   2. The backend sends the key.
//   3. Once the logs show only key=valid, RENDER_API_KEY_REQUIRED=true.
// With no key configured and the key not required, the header is ignored and
// every request logs key=unconfigured: a validator whose secret did not mount
// keeps rendering thumbnails instead of refusing the backend's key, and the log
// shows why it can't be required yet. Required with no key configured refuses
// every request (fail closed).
//
// /validate/latex and /validate/mermaid (ops I-743) take the same key and follow
// RENDER_API_KEY_REQUIRED. VALIDATE_API_KEY_REQUIRED=true|false overrides that for them
// alone. With it false while RENDER_API_KEY_REQUIRED=true, the validate routes log each
// caller's key state but still serve a call with no key (step 1 above for them); a wrong
// key is refused, as in step 1. Any other value, or none, follows RENDER_API_KEY_REQUIRED.
//
// Each request logs one line:
//   [RENDER_AUTH] key=<valid|missing|invalid|unconfigured> required=<bool> route=<route path>
// route is the path the middleware is registered on (/render-screenshot, /validate/latex, ...),
// never the caller's spelling of it. The key itself is never logged.

import { createHash, timingSafeEqual } from 'node:crypto';

export const RENDER_KEY_HEADER = 'x-api-key';

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest();
}

/** Constant-time comparison of two strings of any length. */
export function keysMatch(given, expected) {
  return timingSafeEqual(digest(given), digest(expected));
}

function flag(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['true', '1'].includes(text)) return true;
  if (['false', '0'].includes(text)) return false;
  return undefined;
}

export function renderAuthSettings(env = process.env) {
  return {
    key: env.RENDER_API_KEY || '',
    required: flag(env.RENDER_API_KEY_REQUIRED) === true,
  };
}

/** The same key for /validate/*; VALIDATE_API_KEY_REQUIRED, when true or false, decides for them. */
export function validateAuthSettings(env = process.env) {
  const render = renderAuthSettings(env);
  return { ...render, required: flag(env.VALIDATE_API_KEY_REQUIRED) ?? render.required };
}

/**
 * Express middleware for keyed endpoints (renders, validations).
 * @param {{ key?: string, required?: boolean, log?: Console }} [options]
 */
export function renderAuth({ key, required, log = console } = renderAuthSettings()) {
  if (required && !key) log.error('[RENDER_AUTH] the key is required but RENDER_API_KEY is empty: every keyed request is refused');
  return (req, res, next) => {
    const given = req.get(RENDER_KEY_HEADER);
    let state;
    if (!key) state = 'unconfigured';
    else if (given === undefined || given === '') state = 'missing';
    else state = keysMatch(given, key) ? 'valid' : 'invalid';
    log.info(`[RENDER_AUTH] key=${state} required=${Boolean(required)} route=${req.route?.path ?? 'none'}`);

    if (state === 'valid') return next();
    if (state === 'invalid') return res.status(401).json({ success: false, error: 'Invalid API key' });
    if (!required) return next();
    if (state === 'unconfigured') return res.status(503).json({ success: false, error: 'Render key not configured' });
    return res.status(401).json({ success: false, error: 'Missing API key' });
  };
}
