'use strict';

/**
 * Collects what a registered MCP server discloses about itself, and
 * fingerprints it so changes can be detected over time.
 *
 *   node scripts/metadata.js                    every registered server
 *   node scripts/metadata.js <id>               just one
 *   node scripts/metadata.js <id> --json        the raw snapshot
 *   node scripts/metadata.js --save             write docs/snapshots/<id>.json
 *   node scripts/metadata.js --diff             compare to saved, exit 1 on drift
 *
 * Why fingerprints: MCP has no "last updated" field, and none of the servers
 * seen so far publish a version endpoint, an ETag, or a Last-Modified. Their
 * `serverInfo.version` is typically pinned at 1.0.0 and never moves. Hashing
 * what they serve is the only honest way to know something changed — run
 * `--diff` on a schedule and it becomes the change feed they do not provide.
 *
 * This proved itself immediately: it caught Viator shipping a 54-byte change
 * to its app bundle mid-session, entirely unannounced.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Registry } = require('../server/registry');
const { standardForMimeType, isUiResource, templateForTool } = require('../server/detect');

const SNAPSHOT_DIR = path.join(__dirname, '..', 'docs', 'snapshots');

/** Stable hash: keys are sorted so formatting churn is not "a change". */
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

async function rawPost(endpoint, body) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* SSE or an error page */ }
  if (!parsed) {
    const line = text.split('\n').find((l) => l.startsWith('data:'));
    if (line) { try { parsed = JSON.parse(line.slice(5).trim()); } catch { /* give up */ } }
  }
  return { res, parsed };
}

async function collect(entry) {
  const registry = new Registry();
  const client = registry.clientFor(entry.id);
  const init = await client.ready();

  /* --- protocol negotiation ------------------------------------------- */
  // Asking across a range reveals the ceiling and which older versions are
  // honoured — neither of which a server advertises directly.
  const probes = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-21', '2099-01-01'];
  const negotiation = {};
  for (const requested of probes) {
    const { parsed } = await rawPost(entry.endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: requested, capabilities: {}, clientInfo: { name: 'metadata-probe', version: '1.0.0' } },
    });
    negotiation[requested] = parsed?.result?.protocolVersion ?? null;
  }
  const granted = Object.values(negotiation).filter(Boolean);
  const ceiling = granted.find((v) => !probes.includes(v)) || init.protocolVersion;

  /* --- method surface --------------------------------------------------- */
  const optional = ['ping', 'resources/templates/list', 'prompts/list', 'completion/complete', 'logging/setLevel'];
  const methods = { supported: [], unsupported: [] };
  for (const method of optional) {
    const { parsed } = await rawPost(entry.endpoint, { jsonrpc: '2.0', id: 9, method, params: {} });
    (parsed?.result !== undefined ? methods.supported : methods.unsupported).push(method);
  }

  const getStatus = await fetch(entry.endpoint, { method: 'GET', headers: { Accept: 'text/event-stream' } })
    .then((r) => r.status)
    .catch(() => null);

  /* --- surface ---------------------------------------------------------- */
  const [toolsResult, resourcesResult] = await Promise.all([
    client.listTools().catch(() => ({ tools: [] })),
    client.listResources().catch(() => ({ resources: [] })),
  ]);
  const resources = resourcesResult.resources || [];

  const widgets = [];
  for (const resource of resources.filter(isUiResource)) {
    try {
      const read = await client.readResource(resource.uri);
      const content = (read.contents || []).find((c) => typeof c.text === 'string');
      if (!content) continue;
      widgets.push({
        uri: resource.uri,
        standard: standardForMimeType(content.mimeType || resource.mimeType),
        bytes: Buffer.byteLength(content.text),
        sha256: crypto.createHash('sha256').update(content.text).digest('hex'),
      });
    } catch (err) {
      widgets.push({ uri: resource.uri, error: err.message });
    }
  }

  return {
    id: entry.id,
    collectedAt: new Date().toISOString(),
    endpoint: entry.endpoint,

    server: {
      name: init.serverInfo?.name ?? null,
      version: init.serverInfo?.version ?? null,
      instructionsHash: init.instructions ? digest(init.instructions) : null,
      capabilities: init.capabilities ?? {},
    },

    protocol: {
      defaultNegotiated: init.protocolVersion,
      ceiling,
      honoursRequested: probes.filter((p) => negotiation[p] === p),
      clampsTo: Object.fromEntries(Object.entries(negotiation).filter(([k, v]) => v !== k)),
    },

    transport: {
      getStatus,                       // 405 ⇒ POST-only, no server-initiated SSE
      issuesSessionId: Boolean(client.sessionId),
    },

    methods,

    tools: (toolsResult.tools || []).map((tool) => {
      const { uri, source } = templateForTool(tool, resources);
      const resource = resources.find((r) => r.uri === uri);
      return {
        name: tool.name,
        required: tool.inputSchema?.required ?? [],
        parameters: Object.keys(tool.inputSchema?.properties ?? {}),
        template: uri,
        templateSource: source,
        standard: standardForMimeType(resource?.mimeType) ?? null,
        noauth: (tool._meta?.securitySchemes || []).some((s) => s.type === 'noauth'),
        descriptionHash: digest(tool.description ?? ''),
        inputSchemaHash: digest(tool.inputSchema ?? {}),
        outputSchemaHash: digest(tool.outputSchema ?? {}),
      };
    }),

    resources: resources.map((r) => ({
      uri: r.uri,
      mimeType: r.mimeType ?? null,
      standard: standardForMimeType(r.mimeType),
      metaHash: digest(r._meta ?? {}),
    })),

    widgets,
  };
}

/* -------------------------------------------------------------------- *
 * Diffing
 * -------------------------------------------------------------------- */

const VOLATILE = new Set(['collectedAt']);

function flatten(value, prefix = '', out = {}) {
  const key = (k) => (prefix ? `${prefix}.${k}` : k);
  if (Array.isArray(value)) {
    // Index arrays of objects by name/uri so a diff pinpoints the field
    // rather than dumping the whole array.
    if (value.some((v) => v && typeof v === 'object')) {
      for (const [i, item] of value.entries()) flatten(item, key(item?.name || item?.uri || i), out);
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
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .sort()
    .filter((k) => ![...VOLATILE].some((v) => k === v || k.startsWith(`${v}.`)))
    .filter((k) => a[k] !== b[k])
    .map((k) => ({ field: k, before: a[k], after: b[k] }));
}

/* -------------------------------------------------------------------- *
 * Reporting
 * -------------------------------------------------------------------- */

function report(s) {
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
  console.log(`\n${s.id}  —  ${s.endpoint}`);
  console.log('─'.repeat(72));
  line('server', `${s.server.name} v${s.server.version}`);
  line('capabilities', Object.keys(s.server.capabilities).join(', ') || 'none');
  line('protocol', `${s.protocol.defaultNegotiated} (ceiling ${s.protocol.ceiling})`);
  line('honours', s.protocol.honoursRequested.join(', ') || 'none');
  line('GET endpoint', `${s.transport.getStatus}${s.transport.getStatus === 405 ? ' (POST-only)' : ''}`);
  line('methods', s.methods.supported.join(', ') || 'none');
  line('missing', s.methods.unsupported.join(', ') || 'none');

  console.log('\n  Tools');
  for (const t of s.tools) {
    console.log(`    ${t.name}  [${t.standard || 'data-only'}${t.noauth ? ' · noauth' : ''}]`);
    line('    schemas', `in ${t.inputSchemaHash} · out ${t.outputSchemaHash} · desc ${t.descriptionHash}`);
  }

  if (s.widgets.length) {
    console.log('\n  Widgets');
    for (const w of s.widgets) {
      if (w.error) console.log(`    ${w.uri}  ERROR ${w.error}`);
      else console.log(`    ${w.uri}  ${w.bytes.toLocaleString()}B  ${w.sha256.slice(0, 16)}…`);
    }
  }
  console.log();
}

/* -------------------------------------------------------------------- */

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith('--')).map((a) => a.slice(2)));
  const wanted = args.filter((a) => !a.startsWith('--'));

  const registry = new Registry();
  const entries = wanted.length
    ? wanted.map((id) => {
      const entry = registry.get(id);
      if (!entry) {
        console.error(`\nNo server "${id}" in the registry. Known: ${registry.list().map((s) => s.id).join(', ')}\n`);
        process.exit(2);
      }
      return entry;
    })
    : registry.list().map((s) => registry.get(s.id));

  let drifted = 0;

  for (const entry of entries) {
    let snapshot;
    try {
      snapshot = await collect(entry);
    } catch (err) {
      console.error(`\n${entry.id}: probe failed — ${err.message}\n`);
      drifted += 1;
      continue;
    }

    if (flags.has('json')) {
      console.log(JSON.stringify(snapshot, null, 2));
    } else if (!flags.has('diff')) {
      report(snapshot);
    }

    const file = path.join(SNAPSHOT_DIR, `${entry.id}.json`);

    if (flags.has('diff')) {
      if (!fs.existsSync(file)) {
        console.error(`${entry.id}: no saved snapshot. Run with --save first.`);
        drifted += 1;
        continue;
      }
      const previous = JSON.parse(fs.readFileSync(file, 'utf8'));
      const changes = diff(previous, snapshot);
      if (!changes.length) {
        console.log(`${entry.id}: no change since ${previous.collectedAt}`);
      } else {
        drifted += 1;
        console.log(`\n${entry.id}: ${changes.length} change(s) since ${previous.collectedAt}\n`);
        for (const c of changes) {
          console.log(`  ${c.field}`);
          console.log(`    before: ${c.before}`);
          console.log(`    after:  ${c.after}`);
        }
        console.log();
      }
    }

    if (flags.has('save')) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(snapshot, null, 2)}\n`);
      console.log(`Saved ${path.relative(process.cwd(), file)}`);
    }
  }

  if (flags.has('diff') && drifted) process.exit(1);
}

main().catch((err) => {
  console.error('\nMetadata collection failed:', err.message, '\n');
  process.exit(1);
});
