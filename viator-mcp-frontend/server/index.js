'use strict';

/**
 * Serves the front end and proxies it to the Viator Experiences MCP server.
 *
 * The proxy exists because the browser cannot talk to the MCP endpoint
 * directly: it is a server-to-server JSON-RPC endpoint with no CORS headers.
 * Everything the page needs goes through the four /api routes below.
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { ViatorMcpClient, DEFAULT_ENDPOINT } = require('./mcp-client');

// `PORT=0` means "any free port" and must survive the default, so check for
// an unset variable rather than falling back on falsiness.
const PORT = process.env.PORT === undefined || process.env.PORT === ''
  ? 3000
  : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const ENDPOINT = process.env.VIATOR_MCP_URL || DEFAULT_ENDPOINT;
const APP_RESOURCE_URI = process.env.VIATOR_APP_URI || 'ui://mcp/experiences';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const client = new ViatorMcpClient({ endpoint: ENDPOINT });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

/* ------------------------------------------------------------------ *
 * MCP App resource
 * ------------------------------------------------------------------ */

// The resource is a ~900KB inline bundle. Cache it so a search does not refetch
// it on every iframe reload.
const appCache = { html: null, meta: null, fetchedAt: 0 };
const APP_TTL_MS = 10 * 60 * 1000;

/**
 * Turns the resource's CSP metadata into a real Content-Security-Policy.
 *
 * `'self'` is deliberately never used: the iframe is sandboxed without
 * `allow-same-origin`, so its origin is opaque and `'self'` would match nothing.
 */
function buildCsp(meta) {
  const csp = (meta && meta.ui && meta.ui.csp) || {};
  const connect = csp.connectDomains || [];
  const resource = csp.resourceDomains || [];
  const frame = csp.frameDomains || [];

  const directives = [
    "default-src 'none'",
    // The bundle is a single inline <script>, and it evaluates inline styles.
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${resource.join(' ')}`.trim(),
    `font-src data: ${resource.join(' ')}`.trim(),
    `connect-src ${['data:', ...connect].join(' ')}`.trim(),
    "base-uri 'none'",
    "form-action 'none'",
  ];
  if (frame.length) directives.push(`frame-src ${frame.join(' ')}`);
  return directives.join('; ');
}

async function loadApp() {
  const fresh = appCache.html && Date.now() - appCache.fetchedAt < APP_TTL_MS;
  if (fresh) return appCache;

  const result = await client.readResource(APP_RESOURCE_URI);
  const contents = (result && result.contents) || [];
  const entry = contents.find((c) => typeof c.text === 'string');
  if (!entry) throw new Error(`Resource ${APP_RESOURCE_URI} returned no HTML content`);

  const listed = await client.listResources().catch(() => null);
  const listing = listed && (listed.resources || []).find((r) => r.uri === APP_RESOURCE_URI);

  appCache.html = entry.text;
  appCache.meta = entry._meta || (listing && listing._meta) || {};
  appCache.fetchedAt = Date.now();
  return appCache;
}

/**
 * The resource is a document *fragment* (`<style>`, `<div id="root">`,
 * `<script>`), so the host is responsible for wrapping it in a real document.
 */
function wrapApp(fragment) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Viator Experiences</title>
<style>html,body{margin:0;padding:0;background:transparent}</style>
</head>
<body>
${fragment}
</body>
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

function readBody(req, limit = 1024 * 256) {
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

/** Only these may be invoked through the proxy, whoever asks. */
const ALLOWED_TOOLS = new Set(['search_experiences', 'get_experience_details']);

async function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  // Guard against `..` escaping the public directory.
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

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  // --- Server + tool metadata, for the "Connection" panel -----------------
  if (pathname === '/api/info' && req.method === 'GET') {
    const info = await client.ready();
    const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
    return sendJson(res, 200, {
      endpoint: ENDPOINT,
      protocolVersion: info.protocolVersion,
      serverInfo: info.serverInfo,
      instructions: info.instructions,
      capabilities: info.capabilities,
      tools: tools.tools || [],
      resources: resources.resources || [],
    });
  }

  // --- The MCP App itself, wrapped and served under its own CSP ----------
  if (pathname === '/api/app.html' && req.method === 'GET') {
    const { html, meta } = await loadApp();
    const doc = wrapApp(html);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(doc),
      'Content-Security-Policy': buildCsp(meta),
      'Cache-Control': 'no-cache',
    });
    return res.end(doc);
  }

  // --- The resource's _meta, so the host can mirror the declared CSP ------
  if (pathname === '/api/app-meta' && req.method === 'GET') {
    const { meta, html } = await loadApp();
    return sendJson(res, 200, {
      uri: APP_RESOURCE_URI,
      meta,
      csp: buildCsp(meta),
      bytes: Buffer.byteLength(html),
    });
  }

  // --- tools/call proxy ---------------------------------------------------
  if (pathname === '/api/tools/call' && req.method === 'POST') {
    const body = await readBody(req);
    const name = body && body.name;
    if (!ALLOWED_TOOLS.has(name)) {
      return sendJson(res, 400, {
        error: `Unknown tool "${name}". Allowed: ${[...ALLOWED_TOOLS].join(', ')}`,
      });
    }
    const started = Date.now();
    const result = await client.callTool(name, body.arguments || {});
    return sendJson(res, 200, { result, elapsedMs: Date.now() - started });
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[error] ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) {
      sendJson(res, 502, { error: err.message, code: err.code });
    } else {
      res.end();
    }
  });
});

// A busy port is an ordinary thing to hit, so explain it rather than letting
// the unhandled 'error' event dump a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} on ${HOST} is already in use.\n`);
    console.error('  PORT=8080 npm start        run somewhere else');
    console.error('  PORT=0 npm start           pick any free port\n');
  } else if (err.code === 'EACCES') {
    console.error(`\nNot allowed to bind ${HOST}:${PORT}.`);
    console.error('Ports below 1024 need elevated privileges — try PORT=8080.\n');
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`\n${HOST} is not an address on this machine.`);
    console.error('Use HOST=127.0.0.1 (default) or HOST=0.0.0.0 for every interface.\n');
  } else {
    console.error('\nCould not start the server:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // PORT=0 means the real port is only known once listening has begun.
  const { port } = server.address();
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Viator MCP front end  →  http://${shown}:${port}`);
  if (shown === 'localhost') {
    console.log(`                         (also on this machine's LAN address at :${port})`);
  }
  console.log(`Upstream MCP server   →  ${ENDPOINT}`);
  console.log(`MCP App resource      →  ${APP_RESOURCE_URI}`);
});

module.exports = { server, buildCsp, wrapApp };
