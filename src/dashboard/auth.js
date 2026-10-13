/**
 * src/dashboard/auth.js
 * ─────────────────────────────────────────────────────────────
 * Password protection for the dashboard.
 *
 * HTTP Basic auth over every route — including /media — plus the Socket.IO
 * handshake, which bypasses Express entirely when it upgrades to WebSocket.
 *
 * Why there is also a cookie
 * --------------------------
 * Basic auth alone is not enough for the socket. The polling transport is an
 * XHR, so the browser re-sends cached credentials automatically, but the
 * WebSocket upgrade is a separate handshake whose auth behaviour varies by
 * browser. So a successful HTTP login also sets a signed cookie, and the
 * handshake accepts either. A cookie is always sent with a same-origin
 * WebSocket upgrade, which removes the guesswork.
 *
 * The cookie is an HMAC over "{user}:{issued}", keyed by the credentials
 * themselves — so changing the password invalidates every existing session,
 * and no session store is needed.
 *
 * Set DASHBOARD_USER and DASHBOARD_PASSWORD in .env. Leave them unset and the
 * dashboard stays open (install.sh sets them for you).
 * ─────────────────────────────────────────────────────────────
 */

'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'vampire_auth';
const COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const REALM = 'Vampire Dashboard';

/** Constant-time string compare; hashing first gives both sides equal length. */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Minimal cookie header parser — avoids pulling in cookie-parser. */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch (_) { out[key] = part.slice(eq + 1).trim(); }
  }
  return out;
}

/** Pull credentials out of an `Authorization: Basic ...` header. */
function parseBasic(header) {
  if (typeof header !== 'string' || !/^Basic /i.test(header)) return null;
  let decoded;
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); }
  catch (_) { return null; }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return { user: decoded.slice(0, sep), pass: decoded.slice(sep + 1) };
}

/**
 * @param {{user?: string, pass?: string, now?: () => number}} options
 */
function createAuth({ user, pass, now = Date.now } = {}) {
  const enabled  = Boolean(user && pass);
  const secret   = `${user}:${pass}`;
  const mac      = payload => crypto.createHmac('sha256', secret).update(payload).digest('hex');

  /** @returns {string|null} a cookie value, or null when auth is disabled */
  function issueToken() {
    if (!enabled) return null;
    const issued = String(now());
    return `${issued}.${mac(`${user}:${issued}`)}`;
  }

  function tokenIsValid(token) {
    if (!enabled || typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot === -1) return false;
    const issued = token.slice(0, dot);
    const given  = token.slice(dot + 1);
    if (!/^\d+$/.test(issued)) return false;
    if (!safeEqual(given, mac(`${user}:${issued}`))) return false;
    if (now() - Number(issued) > COOKIE_TTL_MS) return false;
    return true;
  }

  /** True when the request carries valid Basic credentials or a valid cookie. */
  function checkRequest(headers = {}) {
    if (!enabled) return true;

    const creds = parseBasic(headers.authorization);
    if (creds && safeEqual(creds.user, user) && safeEqual(creds.pass, pass)) return true;

    return tokenIsValid(parseCookies(headers.cookie)[COOKIE_NAME]);
  }

  /** Same decision for a Socket.IO handshake (node-style headers object). */
  function checkHandshake(handshake = {}) {
    return checkRequest(handshake.headers || {});
  }

  /**
   * Express middleware. 401s anything unauthenticated before it can reach a
   * route or a static file.
   */
  function middleware(req, res, next) {
    if (!enabled) return next();

    const creds = parseBasic(req.headers.authorization);
    const hasValidBasic = creds && safeEqual(creds.user, user) && safeEqual(creds.pass, pass);

    if (hasValidBasic) {
      // Only mint a cookie the first time, or once the old one has expired.
      if (!tokenIsValid(parseCookies(req.headers.cookie)[COOKIE_NAME])) {
        res.cookie(COOKIE_NAME, issueToken(), {
          httpOnly: true,
          sameSite: 'lax',
          maxAge: COOKIE_TTL_MS,
          // No `secure` — the dashboard is normally served over plain HTTP on a
          // host where TLS would be terminated in front of it.
        });
      }
      return next();
    }

    if (tokenIsValid(parseCookies(req.headers.cookie)[COOKIE_NAME])) return next();

    res.set('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`);
    return res.status(401).type('text/plain').send('Authentication required.');
  }

  /** Socket.IO middleware factory. */
  function socketMiddleware(socket, next) {
    if (!enabled || checkHandshake(socket.handshake)) return next();
    return next(new Error('unauthorized'));
  }

  return {
    enabled, issueToken, tokenIsValid, checkRequest, checkHandshake,
    middleware, socketMiddleware,
    cookieName: COOKIE_NAME, ttlMs: COOKIE_TTL_MS,
  };
}

module.exports = { createAuth, parseBasic, parseCookies, safeEqual, COOKIE_NAME };
