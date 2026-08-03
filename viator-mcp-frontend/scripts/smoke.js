'use strict';

/**
 * End-to-end smoke test against the real Viator MCP server.
 *
 * Boots the server on an ephemeral port and exercises every route the browser
 * uses, plus the shapes the front end depends on. Run with `npm run smoke`.
 *
 * This hits the live upstream, so failures may mean Viator is down rather than
 * that this code is broken — the output distinguishes the two where it can.
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

function baseUrl() {
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function main() {
  // The module starts listening on import; wait for the port to be assigned.
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = baseUrl();
  console.log(`\nSmoke testing ${base}\n`);

  let searchResult = null;
  let firstCode = null;

  await check('GET / serves the front end', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Viator Experiences/);
    assert.match(html, /main\.js/);
  });

  await check('GET /styles.css and /main.js resolve', async () => {
    for (const path of ['/styles.css', '/main.js', '/mcp-app-host.js']) {
      const res = await fetch(`${base}${path}`);
      assert.strictEqual(res.status, 200, `${path} returned ${res.status}`);
    }
  });

  await check('static server rejects path traversal', async () => {
    const res = await fetch(`${base}/../server/index.js`, { redirect: 'manual' });
    assert.ok(res.status === 403 || res.status === 404, `expected 403/404, got ${res.status}`);
  });

  await check('GET /api/info reports the MCP server and its tools', async () => {
    const res = await fetch(`${base}/api/info`);
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const info = await res.json();
    assert.ok(info.serverInfo?.name, 'no serverInfo.name');
    const names = (info.tools || []).map((t) => t.name);
    assert.ok(names.includes('search_experiences'), `tools missing search_experiences: ${names}`);
    assert.ok(names.includes('get_experience_details'), `tools missing get_experience_details: ${names}`);
    const uris = (info.resources || []).map((r) => r.uri);
    assert.ok(uris.includes('ui://mcp/experiences'), `resources missing the MCP App: ${uris}`);
  });

  await check('GET /api/app.html returns a full document with a CSP', async () => {
    const res = await fetch(`${base}/api/app.html`);
    assert.strictEqual(res.status, 200);
    const csp = res.headers.get('content-security-policy');
    assert.ok(csp, 'no Content-Security-Policy header');
    assert.match(csp, /tripadvisor\.com/, 'CSP is missing the image CDN');
    assert.ok(!csp.includes("'self'"), "CSP uses 'self', which is meaningless in an opaque-origin sandbox");
    const html = await res.text();
    assert.match(html, /^<!doctype html>/i, 'fragment was not wrapped in a document');
    assert.match(html, /<div id="root">/, 'app root element is missing');
    assert.ok(html.length > 100000, `app bundle looks truncated (${html.length} bytes)`);
  });

  await check('POST /api/tools/call runs search_experiences', async () => {
    const res = await fetch(`${base}/api/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'search_experiences',
        arguments: {
          searchTerm: 'food tours in Rome',
          startDate: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10),
          endDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10),
          limit: 3,
          currency: 'USD',
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
        },
      }),
    });
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    searchResult = body.result;
    assert.ok(!searchResult.isError, `tool reported an error: ${JSON.stringify(searchResult.content)}`);

    const experiences = searchResult.structuredContent?.experiences;
    assert.ok(Array.isArray(experiences), 'structuredContent.experiences is not an array');
    assert.ok(experiences.length > 0, 'search returned no experiences (upstream may be rate limiting)');

    // These are the fields the app and the host both rely on.
    for (const key of ['title', 'code', 'thumbnail', 'clickOffToLander']) {
      assert.ok(experiences[0][key] !== undefined, `experience is missing "${key}"`);
    }
    firstCode = experiences[0].code;
  });

  await check('POST /api/tools/call runs get_experience_details', async () => {
    assert.ok(firstCode, 'skipped: no code from the search above');
    const res = await fetch(`${base}/api/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'get_experience_details',
        arguments: {
          code: firstCode,
          locale: 'en-US',
          currency: 'USD',
          sessionId: searchResult.structuredContent.sessionId,
        },
      }),
    });
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}`);
    const body = await res.json();
    assert.ok(!body.result.isError, `tool reported an error: ${JSON.stringify(body.result.content)}`);
    const details = body.result.structuredContent?.experienceDetails;
    assert.ok(details, 'no experienceDetails in the response');
    assert.strictEqual(details.code, firstCode, 'details are for a different experience');
    assert.ok(details.clickOffToPDP, 'details are missing clickOffToPDP');
  });

  await check('POST /api/tools/call refuses tools outside the allowlist', async () => {
    const res = await fetch(`${base}/api/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'resources/read', arguments: {} }),
    });
    assert.strictEqual(res.status, 400, `expected 400, got ${res.status}`);
  });

  await check('unknown /api routes 404', async () => {
    const res = await fetch(`${base}/api/nope`);
    assert.strictEqual(res.status, 404);
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
