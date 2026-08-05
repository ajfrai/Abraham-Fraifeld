'use strict';

/**
 * Collects everything the Viator MCP server discloses about itself, and
 * fingerprints it so changes can be detected over time.
 *
 *   node scripts/metadata.js              human-readable report
 *   node scripts/metadata.js --json       the raw snapshot
 *   node scripts/metadata.js --save       write docs/mcp-snapshot.json
 *   node scripts/metadata.js --diff       compare to the saved snapshot, exit 1 on drift
 *
 * Why fingerprints: MCP has no "last updated" field, and this server exposes no
 * version endpoint, no ETag and no Last-Modified. `serverInfo.version` is
 * hardcoded to 1.0.0 and has not moved. So the only honest way to know the
 * server changed is to hash what it serves and compare against a stored
 * snapshot — `--diff` in CI, or on a schedule, turns that into a change feed.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ViatorMcpClient, DEFAULT_ENDPOINT } = require('../server/mcp-client');

const ENDPOINT = process.env.VIATOR_MCP_URL || DEFAULT_ENDPOINT;
const APP_URI = process.env.VIATOR_APP_URI || 'ui://mcp/experiences';
const SNAPSHOT = path.join(__dirname, '..', 'docs', 'mcp-snapshot.json');

/** Stable hash: object keys are sorted so formatting churn is not "a change". */
function digest(value) {
  const canonical = (v) => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
    }
    return v;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex').slice(0, 16);
}

async function rpc(method, params, { protocolVersion } = {}) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: method === 'initialize'
      ? { protocolVersion, capabilities: {}, clientInfo: { name: 'metadata-probe', version: '1.0.0' } }
      : params || {},
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { res, parsed, text };
}

async function collect() {
  const client = new ViatorMcpClient({ endpoint: ENDPOINT });
  const init = await client.ready();

  /* --- protocol negotiation ------------------------------------------- */
  // Asking for a range reveals both the server's ceiling and which older
  // versions it still honours, neither of which it advertises directly.
  const probes = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-21', '2099-01-01'];
  const negotiation = {};
  for (const requested of probes) {
    const { parsed } = await rpc('initialize', null, { protocolVersion: requested });
    negotiation[requested] = parsed?.result?.protocolVersion ?? null;
  }
  // Anything the server will not echo back is clamped to its ceiling.
  const granted = Object.values(negotiation).filter(Boolean);
  const ceiling = granted.find((v) => !probes.includes(v)) || init.protocolVersion;

  /* --- which methods exist -------------------------------------------- */
  const optional = [
    'ping', 'resources/templates/list', 'prompts/list',
    'completion/complete', 'logging/setLevel',
  ];
  const methods = { supported: [], unsupported: [] };
  for (const method of optional) {
    const { parsed } = await rpc(method, {});
    (parsed?.result !== undefined ? methods.supported : methods.unsupported).push(method);
  }

  /* --- transport shape ------------------------------------------------- */
  const getProbe = await fetch(ENDPOINT, { method: 'GET', headers: { Accept: 'text/event-stream' } })
    .then((r) => r.status)
    .catch(() => null);

  const { res: headRes } = await rpc('tools/list', {});
  const headers = Object.fromEntries(
    ['server', 'via', 'date', 'etag', 'last-modified', 'mcp-session-id', 'x-datadome']
      .map((h) => [h, headRes.headers.get(h)])
      .filter(([, v]) => v),
  );

  /* --- tools and resources --------------------------------------------- */
  const { tools = [] } = await client.listTools();
  const { resources = [] } = await client.listResources();

  const app = await client.readResource(APP_URI).then(
    (r) => (r.contents || []).find((c) => typeof c.text === 'string') || null,
    () => null,
  );

  return {
    collectedAt: new Date().toISOString(),
    endpoint: ENDPOINT,

    server: {
      name: init.serverInfo?.name ?? null,
      version: init.serverInfo?.version ?? null,
      instructions: init.instructions ?? null,
      capabilities: init.capabilities ?? {},
    },

    protocol: {
      defaultNegotiated: init.protocolVersion,
      ceiling,
      honoursRequested: probes.filter((p) => negotiation[p] === p),
      clampsTo: Object.fromEntries(Object.entries(negotiation).filter(([k, v]) => v !== k)),
    },

    transport: {
      streamableHttp: true,
      getStatus: getProbe,              // 405 ⇒ no server-initiated SSE stream
      issuesSessionId: Boolean(headers['mcp-session-id']),
      cacheValidators: {
        etag: headers.etag ?? null,
        lastModified: headers['last-modified'] ?? null,
      },
    },

    methods,
    headers,

    tools: tools.map((t) => ({
      name: t.name,
      title: t.title ?? null,
      required: t.inputSchema?.required ?? [],
      parameters: Object.keys(t.inputSchema?.properties ?? {}),
      descriptionChars: (t.description ?? '').length,
      descriptionHash: digest(t.description ?? ''),
      inputSchemaHash: digest(t.inputSchema ?? {}),
      outputSchemaHash: digest(t.outputSchema ?? {}),
    })),

    resources: resources.map((r) => ({
      uri: r.uri,
      name: r.name ?? null,
      mimeType: r.mimeType ?? null,
      metaHash: digest(r._meta ?? {}),
      csp: r._meta?.ui?.csp ?? null,
    })),

    app: app
      ? {
          uri: APP_URI,
          mimeType: app.mimeType ?? null,
          bytes: Buffer.byteLength(app.text),
          sha256: crypto.createHash('sha256').update(app.text).digest('hex'),
        }
      : null,
  };
}

/* -------------------------------------------------------------------- *
 * Diffing
 * -------------------------------------------------------------------- */

// Fields that change on every run and say nothing about the server itself.
const VOLATILE = new Set(['collectedAt', 'headers', 'transport.cacheValidators']);

function flatten(value, prefix = '', out = {}) {
  const key = (k) => (prefix ? `${prefix}.${k}` : k);

  if (Array.isArray(value)) {
    // Arrays of objects are indexed by their `name`/`uri` where one exists, so
    // a diff reads `tools.search_experiences.required` rather than dumping the
    // whole array. Arrays of primitives stay a single comparable leaf.
    if (value.some((v) => v && typeof v === 'object')) {
      for (const [i, item] of value.entries()) {
        flatten(item, key(item?.name || item?.uri || i), out);
      }
    } else {
      out[prefix] = JSON.stringify(value);
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) flatten(v, key(k), out);
  } else {
    out[prefix] = value;
  }
  return out;
}

function diff(before, after) {
  const a = flatten(before);
  const b = flatten(after);
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys
    .filter((k) => ![...VOLATILE].some((v) => k === v || k.startsWith(`${v}.`)))
    .filter((k) => a[k] !== b[k])
    .map((k) => ({ field: k, before: a[k], after: b[k] }));
}

/* -------------------------------------------------------------------- *
 * Reporting
 * -------------------------------------------------------------------- */

function report(s) {
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);

  console.log(`\nViator MCP server metadata            ${s.collectedAt}`);
  console.log('─'.repeat(72));
  line('endpoint', s.endpoint);
  line('server', `${s.server.name} v${s.server.version}`);
  line('instructions', s.server.instructions || '—');
  line('capabilities', Object.keys(s.server.capabilities).join(', ') || 'none');

  console.log('\nProtocol');
  line('default negotiated', s.protocol.defaultNegotiated);
  line('ceiling', s.protocol.ceiling);
  line('honours requested', s.protocol.honoursRequested.join(', ') || 'none');
  line('clamps', Object.entries(s.protocol.clampsTo).map(([k, v]) => `${k}→${v}`).join(', ') || 'none');

  console.log('\nTransport');
  line('GET /mcp', `${s.transport.getStatus}${s.transport.getStatus === 405 ? ' (POST-only, no SSE stream)' : ''}`);
  line('session id issued', s.transport.issuesSessionId ? 'yes' : 'no');
  line('ETag / Last-Modified', `${s.transport.cacheValidators.etag || 'none'} / ${s.transport.cacheValidators.lastModified || 'none'}`);
  line('supported methods', s.methods.supported.join(', ') || 'none');
  line('missing methods', s.methods.unsupported.join(', ') || 'none');

  console.log('\nTools');
  for (const t of s.tools) {
    console.log(`  ${t.name}`);
    line('  required', t.required.join(', '));
    line('  parameters', t.parameters.join(', '));
    line('  schema hashes', `in ${t.inputSchemaHash} · out ${t.outputSchemaHash} · desc ${t.descriptionHash}`);
  }

  console.log('\nResources');
  for (const r of s.resources) {
    console.log(`  ${r.uri}  (${r.mimeType})`);
    line('  meta hash', r.metaHash);
    if (r.csp) line('  csp connect', (r.csp.connectDomains || []).join(', ') || 'none');
  }

  if (s.app) {
    console.log('\nMCP App bundle');
    line('bytes', s.app.bytes.toLocaleString());
    line('sha256', s.app.sha256);
  }

  console.log('\nNo "last updated" is published — compare sha256 and the schema');
  console.log('hashes above against docs/mcp-snapshot.json to detect changes.\n');
}

/* -------------------------------------------------------------------- */

async function main() {
  const args = new Set(process.argv.slice(2));
  const snapshot = await collect();

  if (args.has('--json')) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }

  if (args.has('--diff')) {
    if (!fs.existsSync(SNAPSHOT)) {
      console.error(`\nNo saved snapshot at ${SNAPSHOT}. Run with --save first.\n`);
      process.exit(2);
    }
    const previous = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf8'));
    const changes = diff(previous, snapshot);
    if (!changes.length) {
      console.log(`\nNo change since ${previous.collectedAt}.\n`);
      return;
    }
    console.log(`\n${changes.length} change(s) since ${previous.collectedAt}:\n`);
    for (const c of changes) {
      console.log(`  ${c.field}`);
      console.log(`    before: ${c.before}`);
      console.log(`    after:  ${c.after}`);
    }
    console.log();
    process.exit(1);
  }

  report(snapshot);

  if (args.has('--save')) {
    fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
    fs.writeFileSync(SNAPSHOT, `${JSON.stringify(snapshot, null, 2)}\n`);
    console.log(`Saved ${path.relative(process.cwd(), SNAPSHOT)}\n`);
  }
}

main().catch((err) => {
  console.error('\nMetadata collection failed:', err.message, '\n');
  process.exit(1);
});
