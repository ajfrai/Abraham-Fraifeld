'use strict';

/**
 * Sealed cookies — where OAuth tokens live.
 *
 * Tokens are deliberately *not* kept server-side. Two reasons, and both are
 * load-bearing:
 *
 *   1. This host runs on serverless, where there is no durable filesystem and
 *      no guarantee the next request hits the same instance. A file or an
 *      in-memory map would silently lose tokens on every cold start.
 *   2. The deployment is public. A server-side token store would be a shared
 *      credential — whoever authorized last would be lending their Peloton
 *      account to every other visitor. A cookie is per-browser by
 *      construction, so each viewer uses their own account and nobody can
 *      reach anyone else's.
 *
 * The cookie is AES-256-GCM sealed, so its contents are opaque and tamper-
 * evident to the browser that holds it.
 */

const crypto = require('node:crypto');

const COOKIE_PREFIX = 'mcpauth_';
const STATE_COOKIE = 'mcpauth_state';

/**
 * The sealing key. A stable `MCP_HOST_SECRET` keeps sessions alive across
 * restarts and across serverless instances; without one a random key is
 * generated, which is fine for local use but means every cold start
 * invalidates existing cookies (they fail to open and are treated as absent).
 */
const SECRET = process.env.MCP_HOST_SECRET || null;
const KEY = crypto.createHash('sha256')
  .update(SECRET || crypto.randomBytes(32))
  .digest();

if (!SECRET) {
  console.warn('[session] MCP_HOST_SECRET is not set — sessions will not survive a restart.');
}

function seal(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, body]).toString('base64url');
}

function unseal(sealed) {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const body = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    const out = Buffer.concat([decipher.update(body), decipher.final()]);
    return JSON.parse(out.toString('utf8'));
  } catch {
    // Tampered, truncated, or sealed with a key we no longer have.
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  const list = Array.isArray(existing) ? existing : (existing ? [existing] : []);
  res.setHeader('Set-Cookie', [...list, cookie]);
}

function isSecureRequest(req) {
  // Behind Vercel's proxy the socket is plain HTTP; the forwarded proto is
  // what reflects how the browser actually connected.
  const proto = req.headers['x-forwarded-proto'];
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  return Boolean(req.socket?.encrypted);
}

function setCookie(req, res, name, value, { maxAge = 60 * 60 * 24 * 30 } = {}) {
  const attrs = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax', // must survive the cross-site redirect back from the AS
    `Max-Age=${maxAge}`,
  ];
  if (isSecureRequest(req)) attrs.push('Secure');
  appendCookie(res, attrs.join('; '));
}

function clearCookie(req, res, name) {
  const attrs = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecureRequest(req)) attrs.push('Secure');
  appendCookie(res, attrs.join('; '));
}

/* ------------------------------------------------------------------ *
 * Per-server token storage
 * ------------------------------------------------------------------ */

const tokenCookieName = (serverId) => `${COOKIE_PREFIX}${serverId}`;

/** One cookie per server, so no single cookie grows past the 4KB limit. */
function readToken(req, serverId) {
  const raw = parseCookies(req)[tokenCookieName(serverId)];
  return raw ? unseal(raw) : null;
}

function writeToken(req, res, serverId, token) {
  setCookie(req, res, tokenCookieName(serverId), seal(token));
}

function clearToken(req, res, serverId) {
  clearCookie(req, res, tokenCookieName(serverId));
}

/* ------------------------------------------------------------------ *
 * In-flight login state
 * ------------------------------------------------------------------ */

/**
 * Holds the PKCE verifier and freshly registered client between the redirect
 * out to the authorization server and the callback. Short-lived by design.
 */
function writeLoginState(req, res, value) {
  setCookie(req, res, STATE_COOKIE, seal(value), { maxAge: 600 });
}

function readLoginState(req) {
  const raw = parseCookies(req)[STATE_COOKIE];
  return raw ? unseal(raw) : null;
}

function clearLoginState(req, res) {
  clearCookie(req, res, STATE_COOKIE);
}

/** The externally visible origin, which the redirect URI must match exactly. */
function originFor(req) {
  const proto = String(req.headers['x-forwarded-proto'] || (isSecureRequest(req) ? 'https' : 'http'))
    .split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

module.exports = {
  seal,
  unseal,
  parseCookies,
  readToken,
  writeToken,
  clearToken,
  writeLoginState,
  readLoginState,
  clearLoginState,
  originFor,
  hasStableSecret: Boolean(SECRET),
};
