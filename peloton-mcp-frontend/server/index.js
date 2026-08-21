'use strict';

/**
 * Serves the front end and proxies it to the Peloton MCP server.
 *
 * As with the Viator project, the proxy exists because the MCP endpoint is a
 * server-to-server JSON-RPC service with no CORS headers. The extra job here is
 * injecting the `window.openai` shim into each widget document before serving
 * it, since skybridge widgets expect that object to already exist.
 */

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PelotonMcpClient, DEFAULT_ENDPOINT } = require('./mcp-client');

const PORT = process.env.PORT === undefined || process.env.PORT === ''
  ? 3100
  : Number(process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const ENDPOINT = process.env.PELOTON_MCP_URL || DEFAULT_ENDPOINT;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const client = new PelotonMcpClient({ endpoint: ENDPOINT });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

/** Tools the proxy will invoke, whoever asks. */
const ALLOWED_TOOLS = new Set(['search', 'fetch', 'create-training-plan', 'schedule']);

/* ------------------------------------------------------------------ *
 * Widgets
 * ------------------------------------------------------------------ */

// Widgets are 80KB-290KB each; cache them so a search does not refetch.
const widgetCache = new Map();
const WIDGET_TTL_MS = 10 * 60 * 1000;

function isWidgetUri(uri) {
  return typeof uri === 'string' && /^ui:\/\/widget\/[\w.-]+\.html$/.test(uri);
}

async function loadWidget(uri) {
  const hit = widgetCache.get(uri);
  if (hit && Date.now() - hit.fetchedAt < WIDGET_TTL_MS) return hit;

  const result = await client.readResource(uri);
  const entry = (result?.contents || []).find((c) => typeof c.text === 'string');
  if (!entry) throw new Error(`Resource ${uri} returned no HTML content`);

  const record = { html: entry.text, mimeType: entry.mimeType, fetchedAt: Date.now() };
  widgetCache.set(uri, record);
  return record;
}

/**
 * Peloton's widgets carry no CSP metadata, so this is derived from what they
 * actually load: their own CDN plus the S3 bucket every class image lives in.
 * `'self'` is omitted deliberately — the frame is sandboxed onto an opaque
 * origin, where it would match nothing.
 */
function widgetCsp() {
  const images = [
    // Results carry raw s3.amazonaws.com URLs, but the widget rewrites every
    // one through Cloudinary's fetch proxy before rendering. Omitting
    // res.cloudinary.com blocks every image while the raw host looks correct.
    'https://res.cloudinary.com',
    'https://s3.amazonaws.com',
    'https://*.amazonaws.com',
    'https://*.onepeloton.com',
    'https://*.pelocdn.com',
  ];
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval'",
    "style-src 'unsafe-inline' https://fonts.googleapis.com",
    `img-src data: blob: ${images.join(' ')}`,
    `font-src data: https://fonts.gstatic.com ${images.join(' ')}`,
    "connect-src data: https://*.onepeloton.com",
    "media-src https://*.onepeloton.com https://*.pelocdn.com https://*.amazonaws.com",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/**
 * Wraps a widget fragment in a document and injects the bridge shim.
 *
 * The shim must precede the widget's own bootstrap, which captures whatever
 * `window.openai` already holds — hence the script in <head>, before <body>.
 */
function wrapWidget(fragment, shim, initialGlobals = {}) {
  // The widget's bootstrap reads `openai.theme` synchronously to set its dark
  // class, long before the host could push anything over postMessage. So the
  // theme (and other boot-time globals) are baked into the document instead.
  const seed = `window.__HOST_GLOBALS__=${JSON.stringify(initialGlobals)};`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Peloton widget</title>
<style>html,body{margin:0;padding:0;background:transparent}</style>
<script>${seed}</script>
<script>${shim}</script>
</head>
${fragment.trim().startsWith('<body') ? fragment : `<body>${fragment}</body>`}
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

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname === '/api/info' && req.method === 'GET') {
    const info = await client.ready();
    const [tools, resources] = await Promise.all([client.listTools(), client.listResources()]);
    return sendJson(res, 200, {
      endpoint: ENDPOINT,
      protocolVersion: info.protocolVersion,
      serverInfo: info.serverInfo,
      capabilities: info.capabilities,
      // Each tool names the widget that renders it, via openai/outputTemplate.
      tools: (tools.tools || []).map((t) => ({
        name: t.name,
        title: t.title || null,
        required: t.inputSchema?.required || [],
        properties: Object.keys(t.inputSchema?.properties || {}),
        outputTemplate: t._meta?.['openai/outputTemplate'] || null,
        securitySchemes: t._meta?.securitySchemes || null,
      })),
      resources: resources.resources || [],
    });
  }

  // The widget, wrapped and shimmed. `uri` selects which one.
  if (pathname === '/api/widget' && req.method === 'GET') {
    const uri = url.searchParams.get('uri');
    if (!isWidgetUri(uri)) {
      return sendJson(res, 400, { error: `Not a widget URI: ${uri}` });
    }
    const [{ html }, shim] = await Promise.all([
      loadWidget(uri),
      fs.readFile(path.join(PUBLIC_DIR, 'skybridge-shim.js'), 'utf8'),
    ]);
    const theme = url.searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    const locale = /^[a-zA-Z-]{2,10}$/.test(url.searchParams.get('locale') || '')
      ? url.searchParams.get('locale')
      : 'en-US';
    const doc = wrapWidget(html, shim, { theme, locale });
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(doc),
      'Content-Security-Policy': widgetCsp(),
      'Cache-Control': 'no-cache',
    });
    return res.end(doc);
  }

  if (pathname === '/api/tools/call' && req.method === 'POST') {
    const body = await readBody(req);
    const name = body?.name;
    if (!ALLOWED_TOOLS.has(name)) {
      return sendJson(res, 400, {
        error: `Unknown tool "${name}". Allowed: ${[...ALLOWED_TOOLS].join(', ')}`,
      });
    }
    const started = Date.now();
    try {
      const result = await client.callTool(name, body.arguments || {});
      return sendJson(res, 200, { result, elapsedMs: Date.now() - started });
    } catch (err) {
      // Surface auth failures as 401 so the page can explain them properly.
      const status = err.code === 401 ? 401 : 502;
      return sendJson(res, status, { error: err.message, code: err.code });
    }
  }

  if (pathname.startsWith('/api/')) {
    return sendJson(res, 404, { error: `No route for ${req.method} ${pathname}` });
  }

  return serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`[error] ${req.method} ${req.url}:`, err.message);
    if (!res.headersSent) sendJson(res, 502, { error: err.message, code: err.code });
    else res.end();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} on ${HOST} is already in use.\n`);
    console.error('  PORT=8080 npm start        run somewhere else');
    console.error('  PORT=0 npm start           pick any free port\n');
  } else if (err.code === 'EACCES') {
    console.error(`\nNot allowed to bind ${HOST}:${PORT}. Ports below 1024 need privileges.\n`);
  } else if (err.code === 'EADDRNOTAVAIL') {
    console.error(`\n${HOST} is not an address on this machine. Try HOST=0.0.0.0.\n`);
  } else {
    console.error('\nCould not start the server:', err.message, '\n');
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`Peloton MCP front end →  http://${shown}:${port}`);
  console.log(`Upstream MCP server   →  ${ENDPOINT}`);
});

module.exports = { server, widgetCsp, wrapWidget, isWidgetUri };
