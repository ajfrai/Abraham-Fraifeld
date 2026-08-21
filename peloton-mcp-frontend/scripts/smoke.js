'use strict';

/**
 * End-to-end smoke test against the real Peloton MCP server.
 * Boots the server on an ephemeral port and exercises every browser route.
 */

const assert = require('node:assert');

process.env.PORT = process.env.PORT || '0';
process.env.HOST = '127.0.0.1';

const { server } = require('../server/index.js');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok    ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${name}\n        ${err.message}`);
    failed += 1;
  }
}

async function main() {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nSmoke testing ${base}\n`);

  let searchTemplate = null;

  await check('GET / serves the front end', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /<title>Peloton Classes/);
  });

  await check('static assets resolve', async () => {
    for (const p of ['/styles.css', '/main.js', '/skybridge-host.js', '/skybridge-shim.js']) {
      const res = await fetch(`${base}${p}`);
      assert.strictEqual(res.status, 200, `${p} returned ${res.status}`);
    }
  });

  await check('static server rejects path traversal', async () => {
    const res = await fetch(`${base}/../server/index.js`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  });

  await check('GET /api/info reports tools and widgets', async () => {
    const res = await fetch(`${base}/api/info`);
    assert.strictEqual(res.status, 200, `got ${res.status}`);
    const info = await res.json();
    assert.strictEqual(info.serverInfo?.name, 'peloton-mcp', `serverInfo was ${JSON.stringify(info.serverInfo)}`);

    const names = info.tools.map((t) => t.name);
    for (const expected of ['search', 'fetch', 'create-training-plan', 'schedule']) {
      assert.ok(names.includes(expected), `tools missing ${expected}: ${names}`);
    }

    const search = info.tools.find((t) => t.name === 'search');
    assert.ok(search.outputTemplate, 'search declares no openai/outputTemplate');
    searchTemplate = search.outputTemplate;

    // Every widget is a skybridge resource, not an MCP App.
    assert.ok(info.resources.length > 0, 'no widget resources listed');
    for (const r of info.resources) {
      assert.strictEqual(r.mimeType, 'text/html+skybridge', `${r.uri} was ${r.mimeType}`);
    }
  });

  await check('GET /api/widget wraps the widget and injects the shim', async () => {
    const res = await fetch(`${base}/api/widget?uri=${encodeURIComponent(searchTemplate)}`);
    assert.strictEqual(res.status, 200, `got ${res.status}`);

    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'no CSP header');
    assert.match(csp, /s3\.amazonaws\.com/, 'CSP omits the class-image host');
    assert.ok(!csp.includes("'self'"), "CSP uses 'self', meaningless in an opaque-origin sandbox");

    const html = await res.text();
    assert.match(html, /^<!doctype html>/i, 'fragment was not wrapped');
    assert.match(html, /window\.openai = bridge/, 'shim was not injected');
    // The shim must precede the widget's own bootstrap, which captures window.openai.
    assert.ok(
      html.indexOf('window.openai = bridge') < html.indexOf('__REPLAY_EARLY_EVENTS__'),
      'shim is injected after the widget bootstrap',
    );
    assert.ok(html.length > 50000, `widget looks truncated (${html.length} bytes)`);
  });

  await check('GET /api/widget rejects a non-widget URI', async () => {
    for (const uri of ['ui://widget/../secret.html', 'https://evil.example/x', 'ui://other/thing.html']) {
      const res = await fetch(`${base}/api/widget?uri=${encodeURIComponent(uri)}`);
      assert.strictEqual(res.status, 400, `${uri} returned ${res.status}`);
    }
  });

  await check('POST /api/tools/call runs search', async () => {
    const res = await fetch(`${base}/api/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search', arguments: { query: '20 min cycling' } }),
    });
    assert.strictEqual(res.status, 200, `got ${res.status}`);
    const { result } = await res.json();
    assert.ok(!result.isError, `tool errored: ${JSON.stringify(result.content)}`);

    const sc = result.structuredContent;
    assert.strictEqual(sc?.type, 'peloton-search', `structuredContent.type was ${sc?.type}`);
    assert.ok(Array.isArray(sc.results) && sc.results.length > 0, 'no results returned');
    for (const key of ['id', 'title', 'instructor', 'discipline', 'imageUrl']) {
      assert.ok(sc.results[0][key] !== undefined, `result is missing "${key}"`);
    }
  });

  await check('POST /api/tools/call refuses tools outside the allowlist', async () => {
    const res = await fetch(`${base}/api/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'resources/read', arguments: {} }),
    });
    assert.strictEqual(res.status, 400, `got ${res.status}`);
  });

  await check('unknown /api routes 404', async () => {
    assert.strictEqual((await fetch(`${base}/api/nope`)).status, 404);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Smoke run crashed:', err);
  server.close();
  process.exit(1);
});
