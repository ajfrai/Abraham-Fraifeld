'use strict';

/**
 * The request handler for the MCP app host — any server, either widget standard.
 *
 * This is deliberately separate from `index.js`, which only adds a local dev
 * listener. `handle()` here has no opinion about how it's invoked: it works
 * identically behind `http.createServer` (local dev, `npm start`) and behind a
 * Vercel serverless function (`api/[...path].js`), since both hand it the same
 * Node-shaped `(req, res)` pair.
 *
 *   - resolves each tool's UI resource from whichever `_meta` key it uses
 *   - detects the standard from the resource's mime type
 *   - injects the window.openai shim only for skybridge widgets
 *   - derives a CSP from the resource's own metadata, or the registry entry
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { Registry, resolveDefaults } = require('./registry');
const {
  STANDARDS, standardForMimeType, isUiResource, templateForTool, buildCsp, isSafeWidgetUri,
} = require('./detect');
const oauth = require('./oauth');
const session = require('./session');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// `require.resolve` is a literal, statically-analyzable reference, which is
// what lets Vercel's file tracer find this file and bundle it with the
// serverless function. A path built at runtime from PUBLIC_DIR would not be
// traceable, and the deployed function would 404 reading its own shim.
const SHIM_PATH = require.resolve('../public/hosts/skybridge-shim.js');

const registry = new Registry();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/* ------------------------------------------------------------------ *
 * Widget cache
 * ------------------------------------------------------------------ */

// In a serverless deployment this cache lives only as long as the function
// instance is warm — a correctness no-op, since a cold miss just re-fetches.
const widgetCache = new Map(); // `${serverId} ${uri}` -> record
const WIDGET_TTL_MS = 10 * 60 * 1000;

async function loadWidget(serverId, uri) {
  const key = `${serverId} ${uri}`;
  const hit = widgetCache.get(key);
  if (hit && Date.now() - hit.fetchedAt < WIDGET_TTL_MS) return hit;

  const client = registry.clientFor(serverId);
  const result = await client.readResource(uri);
  const entry = (result?.contents || []).find((c) => typeof c.text === 'string');
  if (!entry) throw new Error(`Resource ${uri} returned no HTML content`);

  // resources/read may omit _meta that resources/list carries, so merge both.
  const listed = await client.listResources().catch(() => ({ resources: [] }));
  const fromList = (listed.resources || []).find((r) => r.uri === uri);

  const record = {
    html: entry.text,
    mimeType: entry.mimeType || fromList?.mimeType || null,
    meta: entry._meta || fromList?._meta || {},
    fetchedAt: Date.now(),
  };
  widgetCache.set(key, record);
  return record;
}

/* ------------------------------------------------------------------ *
 * Document assembly
 * ------------------------------------------------------------------ */

/**
 * Wraps a widget fragment in a document.
 *
 * Skybridge widgets additionally get the `window.openai` shim and a seed of
 * boot-time globals, because their bootstrap reads `openai.theme`
 * synchronously — before any message from the host could arrive. MCP Apps
 * negotiate all of that over postMessage and need neither.
 */
function wrapWidget({ fragment, standard, shim, globals }) {
  const head = standard === STANDARDS.SKYBRIDGE
    ? `<script>window.__HOST_GLOBALS__=${JSON.stringify(globals)};</script>\n<script>${shim}</script>`
    : '';

  const body = fragment.trim().startsWith('<body') ? fragment : `<body>${fragment}</body>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP app</title>
<style>html,body{margin:0;padding:0;background:transparent}</style>
${head}
</head>
${body}
</html>`;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limit = 1024 * 512) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Serves `public/` for local dev. On Vercel this is dead code: everything
 * outside `/api/*` is served straight from the CDN's static output and this
 * function is never invoked, since the serverless function is only wired up
 * under `/api`.
 */
async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== path.join(PUBLIC_DIR, 'index.html')) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const data = await fs.readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: 'Not found' });
  }
}

/**
 * Describes a server: what it is, what it can do, and how to render it.
 *
 * This is the endpoint that makes the host generic — the browser gets tool
 * schemas, resolved widget URIs and the detected standard, and needs no
 * per-server knowledge of its own.
 */
async function describeServer(entry, accessToken = null) {
  const client = registry.clientFor(entry.id, accessToken);
  const info = await client.ready();
  const [toolsResult, resourcesResult] = await Promise.all([
    client.listTools(),
    client.listResources(),
  ]);

  const resources = resourcesResult.resources || [];
  const uiResources = resources.filter(isUiResource);

  const allTools = toolsResult.tools || [];

  const tools = allTools.map((tool) => {
    // The sibling list matters: a tool that names no widget while its peers do
    // has opted out, and must not inherit one by fallback.
    const { uri, source } = templateForTool(tool, resources, allTools);
    const resource = resources.find((r) => r.uri === uri);
    return {
      name: tool.name,
      title: tool.title || null,
      description: tool.description || null,
      inputSchema: tool.inputSchema || { type: 'object', properties: {} },
      template: uri,
      templateSource: source,
      standard: standardForMimeType(resource?.mimeType) || null,
      // "app" without "model" means the tool exists for an already-rendered
      // app to call, not for a caller to invoke directly.
      visibility: tool._meta?.ui?.visibility || null,
      securitySchemes: tool._meta?.securitySchemes || null,
      defaults: resolveDefaults(entry.defaults?.[tool.name] || {}),
    };
  });

  // A server's standard is whatever its UI resources say; mixed is possible
  // in principle, so report the set rather than a single value.
  const standards = [...new Set(uiResources.map((r) => standardForMimeType(r.mimeType)))];

  return {
    id: entry.id,
    label: entry.label || entry.id,
    endpoint: entry.endpoint,
    notes: entry.notes || null,
    protocolVersion: info.protocolVersion,
    serverInfo: info.serverInfo,
    capabilities: info.capabilities,
    standards,
    tools,
    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name || null,
      mimeType: r.mimeType || null,
      standard: standardForMimeType(r.mimeType),
    })),
  };
}

/* ------------------------------------------------------------------ *
 * OAuth
 * ------------------------------------------------------------------ */

const redirectUriFor = (req, id) => `${session.originFor(req)}/api/servers/${id}/auth/callback`;

/** Discovery is per-endpoint and stable; cache it so login is one hop faster. */
const discoveryCache = new Map();
async function discoverCached(endpoint) {
  if (!discoveryCache.has(endpoint)) {
    discoveryCache.set(endpoint, await oauth.discover(endpoint));
  }
  return discoveryCache.get(endpoint);
}

/**
 * Returns a usable access token for this viewer, refreshing it if it has aged
 * out. Returns null when the viewer has not authorized — callers then proceed
 * anonymously, which is correct for the many tools marked `noauth`.
 */
async function tokenFor(req, res, entry) {
  const stored = session.readToken(req, entry.id);
  if (!stored?.accessToken) return null;
  if (!oauth.isExpired(stored)) return stored.accessToken;

  if (!stored.refreshToken) {
    session.clearToken(req, res, entry.id);
    return null;
  }
  try {
    const meta = await discoverCached(entry.endpoint);
    const next = await oauth.refreshToken(meta, {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      refresh: stored.refreshToken,
    });
    session.writeToken(req, res, entry.id, { ...stored, ...next });
    return next.accessToken;
  } catch (err) {
    console.warn(`[oauth] refresh failed for ${entry.id}: ${err.message}`);
    session.clearToken(req, res, entry.id);
    return null;
  }
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

async function handleAuth(req, res, entry, action, url) {
  /* --- status ---------------------------------------------------------- */
  if (action === 'status' && req.method === 'GET') {
    const stored = session.readToken(req, entry.id);
    const meta = await discoverCached(entry.endpoint).catch(() => ({ supported: false }));
    return sendJson(res, 200, {
      id: entry.id,
      oauthSupported: Boolean(meta.supported),
      scopesSupported: meta.scopesSupported || [],
      authenticated: Boolean(stored?.accessToken) && !oauth.isExpired(stored, 0),
      expiresAt: stored?.expiresAt || null,
      scope: stored?.scope || null,
      // A bearer from the environment is a deployment-wide credential, not a
      // per-viewer one; say which is in play so the UI does not imply a login.
      staticToken: Boolean(entry.authEnv && process.env[entry.authEnv]),
      stableSecret: session.hasStableSecret,
    });
  }

  /* --- login ----------------------------------------------------------- */
  if (action === 'login' && req.method === 'GET') {
    const meta = await discoverCached(entry.endpoint);
    if (!meta.supported) {
      return sendJson(res, 400, { error: `${entry.id} does not publish OAuth metadata: ${meta.reason}` });
    }

    const redirectUri = redirectUriFor(req, entry.id);
    const configured = entry.oauth || {};
    const client = configured.clientId
      ? { clientId: configured.clientId, clientSecret: configured.clientSecret || null }
      : await oauth.registerClient(meta, redirectUri);

    const { verifier, challenge } = oauth.createPkce();
    const state = crypto.randomBytes(16).toString('base64url');

    // Scope choice: whatever the server advertises, minus openid (we are not
    // doing identity) — or an explicit list from the registry entry.
    const scopes = configured.scopes
      || (meta.scopesSupported || []).filter((s) => s !== 'openid');

    session.writeLoginState(req, res, {
      serverId: entry.id, state, verifier, redirectUri, ...client,
    });

    return redirect(res, oauth.buildAuthorizeUrl(meta, {
      clientId: client.clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge: challenge,
    }));
  }

  /* --- callback -------------------------------------------------------- */
  if (action === 'callback' && req.method === 'GET') {
    const pending = session.readLoginState(req);
    session.clearLoginState(req, res);

    const error = url.searchParams.get('error');
    if (error) {
      return redirect(res, `/?auth=denied&server=${entry.id}&reason=${encodeURIComponent(error)}`);
    }

    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !pending || pending.serverId !== entry.id) {
      return redirect(res, `/?auth=failed&server=${entry.id}&reason=missing-state`);
    }
    // Constant-time compare: `state` is the CSRF defence for this callback.
    const ok = state && pending.state
      && state.length === pending.state.length
      && crypto.timingSafeEqual(Buffer.from(state), Buffer.from(pending.state));
    if (!ok) {
      return redirect(res, `/?auth=failed&server=${entry.id}&reason=state-mismatch`);
    }

    try {
      const meta = await discoverCached(entry.endpoint);
      const token = await oauth.exchangeCode(meta, {
        clientId: pending.clientId,
        clientSecret: pending.clientSecret,
        code,
        codeVerifier: pending.verifier,
        redirectUri: pending.redirectUri,
      });
      // The client credentials are kept alongside the token so a refresh can
      // reuse the same registration rather than registering again.
      session.writeToken(req, res, entry.id, {
        ...token, clientId: pending.clientId, clientSecret: pending.clientSecret,
      });
      return redirect(res, `/?auth=ok&server=${entry.id}`);
    } catch (err) {
      return redirect(res, `/?auth=failed&server=${entry.id}&reason=${encodeURIComponent(err.message.slice(0, 120))}`);
    }
  }

  /* --- logout ---------------------------------------------------------- */
  if (action === 'logout' && (req.method === 'POST' || req.method === 'GET')) {
    session.clearToken(req, res, entry.id);
    if (req.method === 'GET') return redirect(res, `/?auth=out&server=${entry.id}`);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: `No auth route ${req.method} ${action}` });
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/servers' && req.method === 'GET') {
    return sendJson(res, 200, { servers: registry.list() });
  }

  const auth = pathname.match(/^\/api\/servers\/([a-z0-9-]+)\/auth\/([a-z]+)$/);
  if (auth) {
    const entry = registry.get(auth[1]);
    if (!entry) return sendJson(res, 404, { error: `No server "${auth[1]}"` });
    return handleAuth(req, res, entry, auth[2], url);
  }

  const described = pathname.match(/^\/api\/servers\/([a-z0-9-]+)\/info$/);
  if (described && req.method === 'GET') {
    const entry = registry.get(described[1]);
    if (!entry) return sendJson(res, 404, { error: `No server "${described[1]}"` });
    // Authorized viewers may see more tools than anonymous ones.
    const token = await tokenFor(req, res, entry);
    return sendJson(res, 200, await describeServer(entry, token));
  }

  const widget = pathname.match(/^\/api\/servers\/([a-z0-9-]+)\/widget$/);
  if (widget && req.method === 'GET') {
    const entry = registry.get(widget[1]);
    if (!entry) return sendJson(res, 404, { error: `No server "${widget[1]}"` });

    const uri = url.searchParams.get('uri');
    if (!isSafeWidgetUri(uri)) return sendJson(res, 400, { error: `Not a ui:// resource: ${uri}` });

    const record = await loadWidget(entry.id, uri);
    const standard = standardForMimeType(record.mimeType);
    if (!standard) {
      return sendJson(res, 415, {
        error: `Unsupported widget type "${record.mimeType}". Known: text/html;profile=mcp-app, text/html+skybridge`,
      });
    }

    const shim = standard === STANDARDS.SKYBRIDGE ? await fs.readFile(SHIM_PATH, 'utf8') : null;

    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const locale = /^[a-zA-Z-]{2,10}$/.test(url.searchParams.get('locale') || '')
      ? url.searchParams.get('locale')
      : 'en-US';

    const doc = wrapWidget({
      fragment: record.html,
      standard,
      shim,
      globals: { theme, locale },
    });

    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(doc),
      'Content-Security-Policy': buildCsp({ resourceMeta: record.meta, extra: entry.csp || {} }),
      'X-MCP-Standard': standard,
      'Cache-Control': 'no-cache',
    });
    return res.end(doc);
  }

  const call = pathname.match(/^\/api\/servers\/([a-z0-9-]+)\/tools\/call$/);
  if (call && req.method === 'POST') {
    const entry = registry.get(call[1]);
    if (!entry) return sendJson(res, 404, { error: `No server "${call[1]}"` });

    const body = await readBody(req);
    const token = await tokenFor(req, res, entry);
    const client = registry.clientFor(entry.id, token);

    // The allowlist is the server's own tool list — nothing else is callable.
    const { tools } = await client.listTools();
    if (!(tools || []).some((t) => t.name === body?.name)) {
      return sendJson(res, 400, {
        error: `"${body?.name}" is not a tool on ${entry.id}. Available: ${(tools || []).map((t) => t.name).join(', ')}`,
      });
    }

    const started = Date.now();
    try {
      const result = await client.callTool(body.name, body.arguments || {});
      return sendJson(res, 200, { result, elapsedMs: Date.now() - started });
    } catch (err) {
      if (err.status === 401) {
        registry.reset(entry.id);
        const meta = await discoverCached(entry.endpoint).catch(() => ({ supported: false }));
        // Tell the browser where to send the user, rather than just failing.
        return sendJson(res, 401, {
          error: token
            ? 'Your session was rejected. Sign in again.'
            : 'This tool needs authorization.',
          code: err.code,
          authUrl: meta.supported ? `/api/servers/${entry.id}/auth/login` : null,
        });
      }
      return sendJson(res, 502, { error: err.message, code: err.code });
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  }

  return serveStatic(req, res, pathname);
}

/** Shared by both entry points so a crashed handler always answers something. */
function handleWithFallback(req, res) {
  return handle(req, res).catch((err) => {
    console.error(`[error] ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) sendJson(res, 502, { error: err.message, code: err.code });
    else res.end();
  });
}

module.exports = {
  handle, handleWithFallback, registry, wrapWidget, describeServer, PUBLIC_DIR,
};
