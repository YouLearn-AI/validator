// Egress guard: the one check for every address a render may reach (ops I-602).
//
// The renderer runs untrusted HTML and JavaScript (interactives are written by a
// model or a user) in Chromium. Without a guard, a page, one of its subresources,
// a redirect or a WebSocket can reach the Cloud metadata server
// (169.254.169.254, metadata.google.internal), the container's own ports
// (127.0.0.1) or a private network, and the screenshot carries the answer back.
//
// A destination may be reached only when its scheme is http(s) (ws(s) for
// WebSockets) and every address its host resolves to (all A and AAAA records) is
// a public internet address. The host is resolved, never pattern-matched, so
// 2130706433, 127.1 and 0x7f.1 are judged by the address they reach. The address
// policy is the same as pdf-extract's url_guard.py (ops I-325).
//
// Enforcement is an egress proxy in this process that Chromium must use for all
// of its traffic (guarded-browser.mjs launches it with --proxy-server and
// <-loopback>, so even 127.0.0.1 goes through it). Each connection is checked
// when it is made, and the proxy connects to the address it checked, so a DNS
// answer that changes after the check (DNS rebinding) reaches nothing. Chromium
// follows a redirect with a new request through the proxy, so every hop is
// checked. HTTPS and WebSockets arrive as CONNECT tunnels and are checked the
// same way. A Playwright route alone would not cover this: it does not see
// WebSocket or service-worker traffic, and Chromium resolves the name again
// after the route's check.
//
// A refusal is logged once as [EGRESS_REFUSED] reason=<reason> host=<host>; the
// line names the host only, never the URL, whose query can carry tokens.

import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

const METADATA_HOSTS = new Set(['metadata', 'metadata.google.internal']);
const METADATA_ADDRESSES = new Set(['169.254.169.254', 'fd00:ec2::254']);

// ipaddr.js range names -> refusal reasons. Only 'unicast' (a public address)
// passes; a range not listed here is refused as not_global.
const RANGE_REASONS = {
  unspecified: 'unspecified',
  broadcast: 'broadcast',
  multicast: 'multicast',
  linkLocal: 'link_local',
  loopback: 'loopback',
  carrierGradeNat: 'cgnat',
  private: 'private',
  uniqueLocal: 'private',
  reserved: 'reserved',
  rfc6052: 'nat64',
  rfc6145: 'nat64',
  '6to4': 'embedded_ipv4',
  teredo: 'embedded_ipv4',
};

const PROXY_SOCKET_IDLE_MS = 60_000;
const PROXY_CONNECT_TIMEOUT_MS = 15_000;
const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];

export class UrlRefused extends Error {
  constructor(reason, host) {
    super(`URL refused: only public http(s) addresses are rendered (${reason})`);
    this.name = 'UrlRefused';
    this.reason = reason;
    this.host = host;
  }
}

export class DnsUnavailable extends Error {
  constructor(host, cause) {
    super(`Lookup of ${host} failed for now`);
    this.name = 'DnsUnavailable';
    this.cause = cause;
  }
}

function refuse(reason, host, log) {
  log.warn(`[EGRESS_REFUSED] reason=${reason} host=${host || '-'}`);
  return new UrlRefused(reason, host);
}

/** Why `address` may not be reached, or null for a public address. */
export function addressRefusal(address) {
  let ip;
  try {
    ip = ipaddr.parse(String(address).replace(/^\[|\]$/g, ''));
  } catch {
    return 'malformed';
  }
  if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
  if (METADATA_ADDRESSES.has(ip.toNormalizedString()) || METADATA_ADDRESSES.has(ip.toString())) return 'metadata';
  const range = ip.range();
  if (range === 'unicast') return null;
  return RANGE_REASONS[range] || 'not_global';
}

function nameRefusal(host) {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (METADATA_HOSTS.has(name) || name.endsWith('.internal')) return 'metadata';
  if (name === 'localhost' || name.endsWith('.localhost')) return 'loopback';
  return null;
}

const NO_ADDRESS_CODES = new Set(['ENOTFOUND', 'ENODATA', 'EAI_NONAME', 'EAI_NODATA', 'EAI_ADDRFAMILY', 'EINVAL', 'ERR_INVALID_ARG_VALUE']);

async function defaultLookup(host) {
  return dns.lookup(host, { all: true, verbatim: true });
}

/**
 * `host`'s addresses when every one of them is public; otherwise throws
 * UrlRefused (or DnsUnavailable when the resolver did not answer).
 * @param {string} host
 * @param {{ lookup?: (host: string) => Promise<{address: string, family: number}[]>, log?: Console }} [options]
 * @returns {Promise<string[]>}
 */
export async function publicAddresses(host, { lookup = defaultLookup, log = console } = {}) {
  const bare = String(host || '').replace(/^\[|\]$/g, '');
  if (!bare) throw refuse('malformed', host, log);
  const nameReason = nameRefusal(bare);
  if (nameReason) throw refuse(nameReason, bare, log);
  let records;
  try {
    records = await lookup(bare);
  } catch (error) {
    if (NO_ADDRESS_CODES.has(error?.code)) throw refuse('unresolvable', bare, log);
    throw new DnsUnavailable(bare, error);
  }
  const addresses = [...new Set((records || []).map((r) => r.address))];
  if (addresses.length === 0) throw refuse('unresolvable', bare, log);
  for (const address of addresses) {
    const reason = addressRefusal(address);
    if (reason) throw refuse(reason, bare, log);
  }
  return addresses;
}

/**
 * The scheme check, with no lookup: throws UrlRefused unless `url` is an
 * absolute http(s) URL with a host. file:, data:, chrome: and the rest are
 * refused before anything opens them.
 * @returns {URL}
 */
export function checkRequestUrl(url, { log = console } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url).trim());
  } catch {
    throw refuse('malformed', '', log);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw refuse('scheme', parsed.hostname, log);
  if (!parsed.hostname) throw refuse('malformed', '', log);
  if (parsed.username || parsed.password) throw refuse('credentials', parsed.hostname, log);
  return parsed;
}

/** The whole check for a URL: scheme, name, and every address it resolves to. */
export async function checkUrl(url, options = {}) {
  const parsed = checkRequestUrl(url, options);
  await publicAddresses(parsed.hostname, options);
  return parsed;
}

function defaultConnect(options) {
  return net.connect(options);
}

// A lookup that answers only the addresses already checked, so the socket can
// reach nothing else, whatever DNS says by the time it connects.
function pinnedLookup(addresses) {
  const records = addresses.map((address) => ({ address, family: net.isIPv6(address) ? 6 : 4 }));
  return (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    if (options && options.all) cb(null, records);
    else cb(null, records[0].address, records[0].family);
  };
}

// Connect to one of the checked addresses (Node tries each in turn, both
// families, as Chromium would), then check the address the socket reached
// before any byte is sent.
async function connectChecked(host, port, { lookup, connect, log }) {
  const addresses = await publicAddresses(host, { lookup, log });
  const socket = connect({
    host: net.isIP(host) ? host : host.replace(/^\[|\]$/g, ''),
    port,
    lookup: pinnedLookup(addresses),
    autoSelectFamily: true,
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Connect to ${host} timed out`));
    }, PROXY_CONNECT_TIMEOUT_MS);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const peer = socket.remoteAddress;
  const reason = peer === undefined ? 'no_peer' : addressRefusal(peer);
  if (reason) {
    socket.destroy();
    throw refuse(reason, host, log);
  }
  socket.setTimeout(PROXY_SOCKET_IDLE_MS, () => socket.destroy());
  return socket;
}

function parseConnectTarget(target) {
  const value = String(target || '');
  const colon = value.lastIndexOf(':');
  if (colon <= 0) return null;
  const host = value.slice(0, colon).replace(/^\[|\]$/g, '');
  const portText = value.slice(colon + 1);
  if (!/^\d{1,5}$/.test(portText)) return null;
  const port = Number(portText);
  if (!host || port < 1 || port > 65535) return null;
  return { host, port };
}

function statusFor(error) {
  return error instanceof UrlRefused ? 403 : 502;
}

/**
 * Start the egress proxy on 127.0.0.1 (a free port). Chromium sends it
 * absolute-form requests for http:// and CONNECT for https:// and WebSockets.
 * `lookup` and `connect` exist for tests (a fake public name, a local server);
 * production uses the system resolver and net.connect.
 * @returns {Promise<{ server: http.Server, url: string, port: number, refusals: () => number, close: () => Promise<void> }>}
 */
export async function startEgressProxy({ lookup = defaultLookup, connect = defaultConnect, log = console } = {}) {
  const deps = { lookup, connect, log };
  let refusals = 0;
  const counted = (error) => {
    if (error instanceof UrlRefused) refusals += 1;
    return error;
  };

  const server = http.createServer((req, res) => {
    forwardHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  async function forwardHttp(req, res) {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (target.protocol !== 'http:') {
      counted(refuse('scheme', target.hostname, log));
      res.writeHead(403).end();
      return;
    }
    let upstreamSocket;
    try {
      upstreamSocket = await connectChecked(target.hostname, Number(target.port || 80), deps);
    } catch (error) {
      counted(error);
      if (!res.headersSent) res.writeHead(statusFor(error)).end();
      return;
    }
    const headers = { ...req.headers };
    for (const name of HOP_BY_HOP) delete headers[name];
    headers.host = target.host;
    // One connection per request: the socket was made for this checked host.
    headers.connection = 'close';
    const upstream = http.request({
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      setHost: false,
      createConnection: () => upstreamSocket,
    });
    res.on('close', () => upstream.destroy());
    upstream.on('response', (upRes) => {
      const out = { ...upRes.headers };
      for (const name of HOP_BY_HOP) delete out[name];
      const status = upRes.statusCode;
      try {
        // writeHead throws on a status outside 100-999 or a header it won't
        // write; an upstream server picks both, so neither may reach it unchecked.
        if (!Number.isInteger(status) || status < 200 || status > 599) throw new Error(`bad upstream status ${status}`);
        res.writeHead(status, out);
      } catch {
        upRes.destroy();
        upstreamSocket.destroy();
        if (!res.headersSent) res.writeHead(502);
        res.end();
        return;
      }
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    });
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
      upstreamSocket.destroy();
    });
    req.pipe(upstream);
  }

  server.on('connect', (req, clientSocket, head) => {
    tunnel(req, clientSocket, head).catch(() => clientSocket.destroy());
  });

  async function tunnel(req, clientSocket, head) {
    clientSocket.on('error', () => {});
    const target = parseConnectTarget(req.url);
    if (!target) {
      counted(refuse('malformed', '', log));
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    let upstream;
    try {
      upstream = await connectChecked(target.host, target.port, deps);
    } catch (error) {
      counted(error);
      const status = statusFor(error);
      clientSocket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Gateway'}\r\n\r\n`);
      return;
    }
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('close', () => clientSocket.destroy());
    clientSocket.setTimeout(PROXY_SOCKET_IDLE_MS, () => clientSocket.destroy());
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  }

  // A plain ws:// upgrade sent to the proxy is never forwarded (Chromium uses
  // CONNECT for WebSockets through a proxy); Node closes an upgrade nobody handles.
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('clientError', (_error, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    refusals: () => refusals,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
