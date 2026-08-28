'use strict';

/**
 * OAuth 2.1 for MCP servers — discovery, dynamic client registration, PKCE.
 *
 * MCP's auth story is deliberately "no pre-arranged credentials": a server
 * publishes where its authorization server lives, the client registers itself
 * on the spot (RFC 7591), and the user approves in a browser. That means this
 * host can authenticate against a server it has never seen, which is the whole
 * point of a generic host.
 *
 *   /.well-known/oauth-protected-resource   which AS guards this resource
 *   /.well-known/oauth-authorization-server  its endpoints and capabilities
 *   POST {registration_endpoint}            get a client_id for our redirect URI
 *   {authorization_endpoint}                user approves, we get a code
 *   POST {token_endpoint}                   code + verifier -> access token
 *
 * Tokens are never stored server-side; see session.js for why that matters.
 */

const crypto = require('node:crypto');

const FETCH_TIMEOUT_MS = 20000;

async function getJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* keep raw */ }
    return { ok: res.ok, status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Finds the authorization server guarding an MCP endpoint.
 *
 * Both well-known documents are tried at the endpoint's origin. A server that
 * publishes neither simply does not support OAuth, which is reported rather
 * than guessed at.
 */
async function discover(endpoint) {
  const origin = new URL(endpoint).origin;

  const resource = await getJson(`${origin}/.well-known/oauth-protected-resource`);
  const issuer = resource.ok && resource.body?.authorization_servers?.[0]
    ? resource.body.authorization_servers[0]
    : origin;

  // The AS metadata may live at the issuer's root or, per RFC 8414, with the
  // well-known segment inserted before the issuer's path.
  const candidates = [
    `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`,
  ];

  for (const url of candidates) {
    const meta = await getJson(url);
    if (meta.ok && meta.body?.authorization_endpoint && meta.body?.token_endpoint) {
      return {
        supported: true,
        issuer,
        resource: resource.body?.resource || origin,
        scopesSupported: meta.body.scopes_supported || resource.body?.scopes_supported || [],
        authorizationEndpoint: meta.body.authorization_endpoint,
        tokenEndpoint: meta.body.token_endpoint,
        registrationEndpoint: meta.body.registration_endpoint || null,
        codeChallengeMethods: meta.body.code_challenge_methods_supported || [],
        grantTypes: meta.body.grant_types_supported || ['authorization_code'],
      };
    }
  }

  return { supported: false, issuer, reason: 'no OAuth metadata published at this origin' };
}

/**
 * Registers this host as a client, so no pre-shared client_id is needed.
 *
 * The registration is per-login and short-lived: the resulting credentials
 * ride along in the user's own sealed cookie rather than a server-side store,
 * which keeps the whole flow stateless.
 */
async function registerClient(meta, redirectUri) {
  if (!meta.registrationEndpoint) {
    throw new Error(
      'This server has no dynamic client registration endpoint, so a client_id must be pre-arranged. '
      + 'Set one in servers.json as "oauth": { "clientId": "…" }.',
    );
  }

  const res = await getJson(meta.registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP App Host',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none', // public client; PKCE is the protection
      application_type: 'web',
    }),
  });

  if (!res.ok || !res.body?.client_id) {
    throw new Error(`Client registration failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  return { clientId: res.body.client_id, clientSecret: res.body.client_secret || null };
}

/** RFC 7636 S256. The verifier never leaves this host until the token call. */
function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function buildAuthorizeUrl(meta, {
  clientId, redirectUri, scopes, state, codeChallenge,
}) {
  const url = new URL(meta.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (scopes?.length) url.searchParams.set('scope', scopes.join(' '));
  // RFC 8707: bind the token to this resource so it cannot be replayed
  // against a different MCP server that shares an authorization server.
  if (meta.resource) url.searchParams.set('resource', meta.resource);
  return url.toString();
}

async function exchangeCode(meta, {
  clientId, clientSecret, code, codeVerifier, redirectUri,
}) {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  if (meta.resource) form.set('resource', meta.resource);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  const res = await getJson(meta.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  if (!res.ok || !res.body?.access_token) {
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${res.text.slice(0, 200)}`);
  }
  return normaliseToken(res.body);
}

async function refreshToken(meta, { clientId, clientSecret, refresh }) {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refresh,
    client_id: clientId,
  });
  if (meta.resource) form.set('resource', meta.resource);

  const headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
  }

  const res = await getJson(meta.tokenEndpoint, { method: 'POST', headers, body: form.toString() });
  if (!res.ok || !res.body?.access_token) {
    throw new Error(`Token refresh failed (HTTP ${res.status})`);
  }
  // A refresh response may omit the refresh token, meaning "keep the old one".
  const next = normaliseToken(res.body);
  if (!next.refreshToken) next.refreshToken = refresh;
  return next;
}

function normaliseToken(body) {
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token || null,
    tokenType: body.token_type || 'Bearer',
    scope: body.scope || null,
    // Absolute, so it survives being stored and read back later.
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : null,
  };
}

/** True when a token is absent, or close enough to expiry to be worth renewing. */
function isExpired(token, skewMs = 60000) {
  if (!token?.accessToken) return true;
  if (!token.expiresAt) return false;
  return Date.now() + skewMs >= token.expiresAt;
}

module.exports = {
  discover,
  registerClient,
  createPkce,
  buildAuthorizeUrl,
  exchangeCode,
  refreshToken,
  isExpired,
};
