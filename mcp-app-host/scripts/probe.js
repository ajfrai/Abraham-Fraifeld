'use strict';

/**
 * Probes an MCP server and reports everything needed to onboard it.
 *
 *   node scripts/probe.js <endpoint> [--save] [--id <id>] [--label <label>]
 *                                    [--auth-env <VAR>] [--json]
 *
 * `--save` appends a validated entry to servers.json. Everything else is
 * read-only, so this is safe to point at a server you know nothing about.
 *
 * The point is to answer, in one run: does it work, which widget standard does
 * it speak, which tools can I actually call without credentials, and what does
 * its CSP need?
 */

const fs = require('node:fs');
const path = require('node:path');
const { McpClient } = require('../server/mcp-client');
const { standardForMimeType, isUiResource, templateForTool } = require('../server/detect');

const REGISTRY = path.join(__dirname, '..', 'servers.json');

function parseArgs(argv) {
  const out = { flags: new Set(), opts: {}, positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--save' || arg === '--json') out.flags.add(arg.slice(2));
    else if (arg.startsWith('--')) { out.opts[arg.slice(2)] = argv[i + 1]; i += 1; }
    else out.positional.push(arg);
  }
  return out;
}

/** Derives a registry id from the endpoint host, e.g. mcp.onepeloton.com → onepeloton. */
function idFromEndpoint(endpoint) {
  const host = new URL(endpoint).hostname;
  const parts = host.split('.').filter((p) => !['www', 'mcp', 'api', 'com', 'io', 'net', 'org', 'ai'].includes(p));
  const guess = (parts[parts.length - 1] || parts[0] || host).toLowerCase();
  return guess.replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

/** First sentence of a server's instructions, for the registry's notes field. */
function summarise(instructions) {
  if (!instructions) return null;
  const firstLine = instructions.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const sentence = firstLine.split(/(?<=\.)\s/)[0] || firstLine;
  return sentence.length > 200 ? `${sentence.slice(0, 197)}…` : sentence;
}

/** Hosts a widget's markup references, so a CSP can be proposed for it. */
function domainsIn(html) {
  const hosts = new Set();
  for (const m of html.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    hosts.add(`https://${m[1].toLowerCase()}`);
  }
  return [...hosts].sort();
}

async function main() {
  const { flags, opts, positional } = parseArgs(process.argv.slice(2));
  const endpoint = positional[0] || opts.endpoint;

  if (!endpoint) {
    console.error('\nUsage: node scripts/probe.js <endpoint> [--save] [--id x] [--label "X"] [--auth-env VAR]\n');
    process.exit(2);
  }

  const headers = {};
  if (opts['auth-env']) {
    const token = process.env[opts['auth-env']];
    if (!token) console.warn(`[warn] $${opts['auth-env']} is not set; probing unauthenticated\n`);
    else headers.Authorization = `Bearer ${token}`;
  }

  const client = new McpClient({ endpoint, headers });
  const report = { endpoint, probedAt: new Date().toISOString() };

  /* --- handshake ------------------------------------------------------ */
  const info = await client.ready();
  report.serverInfo = info.serverInfo || null;
  report.protocolVersion = info.protocolVersion;
  report.capabilities = info.capabilities || {};
  report.instructions = info.instructions || null;

  /* --- surface -------------------------------------------------------- */
  const [toolsResult, resourcesResult] = await Promise.all([
    client.listTools().catch(() => ({ tools: [] })),
    client.listResources().catch(() => ({ resources: [] })),
  ]);
  const resources = resourcesResult.resources || [];
  const uiResources = resources.filter(isUiResource);

  report.standards = [...new Set(uiResources.map((r) => standardForMimeType(r.mimeType)))];
  report.resources = resources.map((r) => ({
    uri: r.uri,
    mimeType: r.mimeType || null,
    standard: standardForMimeType(r.mimeType),
  }));

  report.tools = (toolsResult.tools || []).map((tool) => {
    const { uri, source } = templateForTool(tool, resources);
    const resource = resources.find((r) => r.uri === uri);
    return {
      name: tool.name,
      required: tool.inputSchema?.required || [],
      properties: Object.keys(tool.inputSchema?.properties || {}),
      template: uri,
      templateSource: source,
      standard: standardForMimeType(resource?.mimeType) || null,
      // `noauth` here is the single best predictor of whether a tool is
      // callable with no credentials at all.
      noauth: (tool._meta?.securitySchemes || []).some((s) => s.type === 'noauth'),
    };
  });

  /* --- widget bodies, for CSP guidance -------------------------------- */
  report.widgets = [];
  for (const resource of uiResources.slice(0, 4)) {
    try {
      const read = await client.readResource(resource.uri);
      const entry = (read.contents || []).find((c) => typeof c.text === 'string');
      if (!entry) continue;
      report.widgets.push({
        uri: resource.uri,
        bytes: Buffer.byteLength(entry.text),
        standard: standardForMimeType(entry.mimeType || resource.mimeType),
        declaredCsp: entry._meta?.ui?.csp || resource._meta?.ui?.csp || null,
        // Static references only. Widgets often rewrite image URLs at runtime
        // (Peloton proxies through Cloudinary), so treat this as a starting
        // point and confirm against real CSP violations in a browser.
        referencedDomains: domainsIn(entry.text).slice(0, 25),
      });
    } catch (err) {
      report.widgets.push({ uri: resource.uri, error: err.message });
    }
  }

  if (flags.has('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    print(report);
  }

  /* --- registry entry -------------------------------------------------- */
  if (flags.has('save')) {
    const id = (opts.id || idFromEndpoint(endpoint)).toLowerCase();
    const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
    if ((registry.servers || []).some((s) => s.id === id)) {
      console.error(`\nA server with id "${id}" already exists. Pass --id to choose another.\n`);
      process.exit(1);
    }

    const entry = {
      id,
      label: opts.label || report.serverInfo?.name || id,
      endpoint,
      // `instructions` can run to thousands of characters (a full tool
      // catalogue, in some cases). The registry wants a one-line description,
      // so keep the opening sentence and no more.
      notes: summarise(report.instructions),
    };
    if (opts['auth-env']) entry.authEnv = opts['auth-env'];

    // MCP Apps declare their own CSP; skybridge widgets need one supplied.
    if (report.standards.includes('skybridge')) {
      const domains = [...new Set(report.widgets.flatMap((w) => w.referencedDomains || []))];
      entry.csp = { resourceDomains: domains, connectDomains: [] };
    }

    registry.servers.push(entry);
    fs.writeFileSync(REGISTRY, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(`\nAdded "${id}" to servers.json.`);
    if (entry.csp) {
      console.log('CSP resourceDomains were seeded from static references only —');
      console.log('run the app and check for "Refused to load" before trusting them.');
    }
    console.log();
  }
}

function print(r) {
  const line = (k, v) => console.log(`  ${k.padEnd(20)} ${v}`);
  console.log(`\nMCP server probe                     ${r.probedAt}`);
  console.log('─'.repeat(72));
  line('endpoint', r.endpoint);
  line('server', `${r.serverInfo?.name || '?'} v${r.serverInfo?.version || '?'}`);
  line('protocol', r.protocolVersion);
  line('capabilities', Object.keys(r.capabilities).join(', ') || 'none');
  line('standard', r.standards.filter(Boolean).join(', ') || 'none detected');
  if (r.instructions) line('instructions', r.instructions.slice(0, 90));

  console.log('\nTools');
  if (!r.tools.length) console.log('  (none)');
  for (const t of r.tools) {
    const marks = [
      t.standard || (t.template ? 'unknown-ui' : 'data-only'),
      t.noauth ? 'noauth' : 'auth?',
    ].join(' · ');
    console.log(`  ${t.name}  [${marks}]`);
    line('  required', t.required.join(', ') || '—');
    if (t.template) line('  renders', `${t.template}  (via ${t.templateSource})`);
  }

  console.log('\nUI resources');
  const ui = r.resources.filter((x) => x.standard);
  if (!ui.length) console.log('  (none — this server has no app to host)');
  for (const x of ui) console.log(`  ${x.uri}  ${x.mimeType}`);

  if (r.widgets.length) {
    console.log('\nWidgets');
    for (const w of r.widgets) {
      if (w.error) { console.log(`  ${w.uri}  ERROR ${w.error}`); continue; }
      console.log(`  ${w.uri}  ${w.bytes.toLocaleString()}B  ${w.standard}`);
      if (w.declaredCsp) {
        line('  declared csp', JSON.stringify(w.declaredCsp).slice(0, 80));
      } else if (w.referencedDomains.length) {
        line('  domains seen', w.referencedDomains.slice(0, 6).join(', '));
      }
    }
  }

  const renderable = r.tools.filter((t) => t.standard);
  console.log(`\n${renderable.length} of ${r.tools.length} tool(s) can be rendered by this host.`);
  console.log('Re-run with --save to add it to servers.json.\n');
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err.message}\n`);
  process.exit(1);
});
