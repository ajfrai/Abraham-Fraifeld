'use strict';

/**
 * Smoke test for the generic host, run against both registered servers.
 *
 * The point of most of these is that one code path handles two standards, so
 * the same assertions run twice with different expected standards.
 */

const assert = require('node:assert');

process.env.PORT = process.env.PORT || '0';
process.env.HOST = '127.0.0.1';

const { server } = require('../server/index.js');
const { standardForMimeType, templateForTool, buildCsp, isSafeWidgetUri } = require('../server/detect');

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

/* ---------------------------------------------------------------- *
 * Unit: detection
 * ---------------------------------------------------------------- */

async function unitTests() {
  await check('standardForMimeType maps both standards and rejects others', () => {
    assert.strictEqual(standardForMimeType('text/html;profile=mcp-app'), 'mcp-apps');
    assert.strictEqual(standardForMimeType('text/html+skybridge'), 'skybridge');
    assert.strictEqual(standardForMimeType('text/html'), null);
    assert.strictEqual(standardForMimeType(undefined), null);
  });

  await check('templateForTool reads either standard\'s metadata key', () => {
    const resources = [{ uri: 'ui://a', mimeType: 'text/html+skybridge' }];
    assert.strictEqual(
      templateForTool({ _meta: { ui: { resourceUri: 'ui://mcp/x' } } }, resources).uri,
      'ui://mcp/x',
    );
    assert.strictEqual(
      templateForTool({ _meta: { 'openai/outputTemplate': 'ui://widget/y.html' } }, resources).uri,
      'ui://widget/y.html',
    );
    // Falls back only when exactly one UI resource exists.
    assert.strictEqual(templateForTool({}, resources).uri, 'ui://a');
    assert.strictEqual(
      templateForTool({}, [...resources, { uri: 'ui://b', mimeType: 'text/html+skybridge' }]).uri,
      null,
    );
  });

  // Regression: Viator's get_experience_details carries _meta.ui with a
  // visibility but no resourceUri. Inheriting the server's only widget by
  // fallback handed the search-results app a {experienceDetails} payload.
  await check('templateForTool: a tool that declares no widget does not inherit one', () => {
    const resources = [{ uri: 'ui://mcp/experiences', mimeType: 'text/html;profile=mcp-app' }];
    const detail = { name: 'get_experience_details', _meta: { ui: { visibility: ['app', 'model'] } } };
    const search = {
      name: 'search_experiences',
      _meta: { ui: { resourceUri: 'ui://mcp/experiences', visibility: ['app', 'model'] } },
    };

    // Declaring `ui` without a resourceUri is a statement, not a gap.
    assert.deepStrictEqual(
      templateForTool(detail, resources, [detail, search]),
      { uri: null, source: 'declared-none' },
    );
    assert.strictEqual(templateForTool(search, resources, [detail, search]).uri, 'ui://mcp/experiences');

    // Same conclusion from a sibling using the other standard's key.
    const bare = { name: 'helper', _meta: {} };
    const templated = { name: 'search', _meta: { 'openai/outputTemplate': 'ui://widget/s.html' } };
    assert.strictEqual(templateForTool(bare, resources, [bare, templated]).source, 'declared-none');

    // But with no convention in use anywhere, the sole-resource guess stands.
    const lone = { name: 'only' };
    assert.strictEqual(templateForTool(lone, resources, [lone]).source, 'sole-ui-resource');
  });

  await check('buildCsp never emits \'self\' and merges both sources', () => {
    const csp = buildCsp({
      resourceMeta: { ui: { csp: { connectDomains: ['https://a.example'] } } },
      extra: { resourceDomains: ['https://b.example'] },
    });
    assert.ok(!csp.includes("'self'"), `CSP contained 'self': ${csp}`);
    assert.match(csp, /connect-src[^;]*https:\/\/a\.example/);
    assert.match(csp, /img-src[^;]*https:\/\/b\.example/);
  });

  await check('isSafeWidgetUri rejects traversal and non-ui schemes', () => {
    assert.ok(isSafeWidgetUri('ui://widget/search.html'));
    assert.ok(!isSafeWidgetUri('ui://widget/../secret'));
    assert.ok(!isSafeWidgetUri('https://evil.example/x'));
    assert.ok(!isSafeWidgetUri('file:///etc/passwd'));
  });
}

/* ---------------------------------------------------------------- *
 * Integration
 * ---------------------------------------------------------------- */

async function main() {
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nSmoke testing ${base}\n`);

  await unitTests();

  await check('GET / serves the front end', async () => {
    const res = await fetch(`${base}/`);
    assert.strictEqual(res.status, 200);
    assert.match(await res.text(), /<title>MCP App Host/);
  });

  await check('static assets resolve, including both host implementations', async () => {
    for (const p of ['/styles.css', '/main.js', '/hosts/index.js',
      '/hosts/mcp-apps-host.js', '/hosts/skybridge-host.js', '/hosts/skybridge-shim.js']) {
      assert.strictEqual((await fetch(`${base}${p}`)).status, 200, `${p} failed`);
    }
  });

  await check('GET /api/servers lists the registry', async () => {
    const { servers } = await (await fetch(`${base}/api/servers`)).json();
    const ids = servers.map((s) => s.id);
    assert.ok(ids.includes('viator') && ids.includes('peloton'), `registry was ${ids}`);
  });

  // The core claim: one code path, two standards.
  const expectations = [
    { id: 'viator', standard: 'mcp-apps', tool: 'search_experiences' },
    { id: 'peloton', standard: 'skybridge', tool: 'search' },
  ];

  for (const { id, standard, tool } of expectations) {
    await check(`${id}: /info detects "${standard}" and resolves the tool's widget`, async () => {
      const res = await fetch(`${base}/api/servers/${id}/info`);
      assert.strictEqual(res.status, 200, `got ${res.status}`);
      const info = await res.json();
      assert.ok(info.standards.includes(standard), `standards were ${info.standards}`);

      const found = info.tools.find((t) => t.name === tool);
      assert.ok(found, `tool ${tool} missing from ${info.tools.map((t) => t.name)}`);
      assert.ok(found.template, `${tool} resolved no widget`);
      assert.strictEqual(found.standard, standard);
      assert.ok(found.inputSchema?.properties, 'no inputSchema to build a form from');
    });

    await check(`${id}: /widget serves a document with the right shim policy`, async () => {
      const info = await (await fetch(`${base}/api/servers/${id}/info`)).json();
      const uri = info.tools.find((t) => t.name === tool).template;
      const res = await fetch(`${base}/api/servers/${id}/widget?uri=${encodeURIComponent(uri)}`);
      assert.strictEqual(res.status, 200, `got ${res.status}`);
      assert.strictEqual(res.headers.get('x-mcp-standard'), standard);

      const csp = res.headers.get('content-security-policy');
      assert.ok(csp && !csp.includes("'self'"), `bad CSP: ${csp}`);

      const html = await res.text();
      assert.match(html, /^<!doctype html>/i);

      // The shim is injected for skybridge only — MCP Apps must not get it.
      const hasShim = html.includes('window.openai = bridge');
      assert.strictEqual(hasShim, standard === 'skybridge',
        standard === 'skybridge' ? 'skybridge widget did not get the shim'
          : 'MCP App wrongly received the skybridge shim');
    });

    await check(`${id}: /tools/call runs ${tool}`, async () => {
      const info = await (await fetch(`${base}/api/servers/${id}/info`)).json();
      const found = info.tools.find((t) => t.name === tool);
      const res = await fetch(`${base}/api/servers/${id}/tools/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: tool, arguments: found.defaults }),
      });
      // Read the body once: an assertion message that awaits res.text() would
      // consume it before res.json() ever runs.
      const body = await res.json();
      assert.strictEqual(res.status, 200, `got ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
      const { result } = body;
      assert.ok(!result.isError, `tool errored: ${JSON.stringify(result.content).slice(0, 200)}`);
      assert.ok(result.structuredContent, 'no structuredContent to render');
    });
  }

  await check('peloton: CSP includes the Cloudinary host the widget really uses', async () => {
    const uri = 'ui://widget/search-dpl_7bx6.html';
    const res = await fetch(`${base}/api/servers/peloton/widget?uri=${encodeURIComponent(uri)}`);
    assert.match(res.headers.get('content-security-policy'), /res\.cloudinary\.com/);
  });

  await check('widget route rejects unsafe URIs', async () => {
    for (const uri of ['ui://widget/../x', 'https://evil.example/x', 'file:///etc/passwd']) {
      const res = await fetch(`${base}/api/servers/peloton/widget?uri=${encodeURIComponent(uri)}`);
      assert.strictEqual(res.status, 400, `${uri} returned ${res.status}`);
    }
  });

  await check('tool calls are restricted to the server\'s own tool list', async () => {
    const res = await fetch(`${base}/api/servers/peloton/tools/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'search_experiences', arguments: {} }),
    });
    assert.strictEqual(res.status, 400, `cross-server tool call returned ${res.status}`);
  });

  // A server with no UI resources must degrade gracefully rather than error.
  // The live counterpart to the unit test above: only search_experiences may
  // render, so the UI cannot default to feeding a detail payload to the list.
  await check('viator: only search_experiences resolves a widget', async () => {
    const info = await (await fetch(`${base}/api/servers/viator/info`)).json();

    const detail = info.tools.find((t) => t.name === 'get_experience_details');
    assert.ok(detail, 'get_experience_details missing from the tool list');
    assert.strictEqual(detail.template, null, `it resolved ${detail.template}`);
    assert.strictEqual(detail.templateSource, 'declared-none');

    const search = info.tools.find((t) => t.name === 'search_experiences');
    assert.strictEqual(search.template, 'ui://mcp/experiences');
    assert.strictEqual(search.templateSource, 'tool._meta');

    // What the browser picks as its default tool.
    const renderable = info.tools.filter((t) => t.template && t.standard);
    assert.deepStrictEqual(renderable.map((t) => t.name), ['search_experiences']);
  });

  await check('deepwiki: a data-only server reports no renderable tools', async () => {
    const res = await fetch(`${base}/api/servers/deepwiki/info`);
    assert.strictEqual(res.status, 200, `got ${res.status}`);
    const info = await res.json();
    assert.deepStrictEqual(info.standards, [], `standards were ${JSON.stringify(info.standards)}`);
    assert.ok(info.tools.length > 0, 'no tools listed');
    assert.ok(info.tools.every((t) => !t.standard), 'a tool claimed a standard');
    assert.ok(info.tools.every((t) => !t.template), 'a tool resolved a widget');
  });

  /* --- OAuth ---------------------------------------------------------- */

  await check('auth/status reports real OAuth capability per server', async () => {
    const peloton = await (await fetch(`${base}/api/servers/peloton/auth/status`)).json();
    assert.strictEqual(peloton.oauthSupported, true, 'peloton should advertise OAuth');
    assert.ok(peloton.scopesSupported.includes('offline_access'), `scopes were ${peloton.scopesSupported}`);
    assert.strictEqual(peloton.authenticated, false, 'no cookie was sent, so nobody is signed in');

    // Viator publishes no OAuth metadata; that must be reported, not guessed.
    const viator = await (await fetch(`${base}/api/servers/viator/auth/status`)).json();
    assert.strictEqual(viator.oauthSupported, false);
  });

  await check('auth/login refuses a server with no OAuth metadata', async () => {
    const res = await fetch(`${base}/api/servers/viator/auth/login`, { redirect: 'manual' });
    assert.strictEqual(res.status, 400, `got ${res.status}`);
  });

  await check('auth/callback rejects a missing or mismatched state (CSRF)', async () => {
    // No state cookie at all.
    const bare = await fetch(`${base}/api/servers/peloton/auth/callback?code=x&state=y`, { redirect: 'manual' });
    assert.strictEqual(bare.status, 302);
    assert.match(bare.headers.get('location'), /auth=failed.*missing-state/);

    // A provider-side refusal is surfaced rather than swallowed.
    const denied = await fetch(`${base}/api/servers/peloton/auth/callback?error=access_denied`, { redirect: 'manual' });
    assert.match(denied.headers.get('location'), /auth=denied/);
  });

  await check('sealed session cookies are tamper-evident', async () => {
    const { seal, unseal } = require('../server/session');
    const sealed = seal({ accessToken: 'secret', scope: 'a' });
    assert.deepStrictEqual(unseal(sealed).accessToken, 'secret');
    assert.ok(!sealed.includes('secret'), 'the token appears in the cookie in clear text');

    // Flipping any byte of the ciphertext must fail the GCM tag, not decode.
    const bytes = Buffer.from(sealed, 'base64url');
    bytes[bytes.length - 1] ^= 0xff;
    assert.strictEqual(unseal(bytes.toString('base64url')), null, 'a tampered cookie was accepted');
  });

  await check('unknown servers and routes 404', async () => {
    assert.strictEqual((await fetch(`${base}/api/servers/nope/info`)).status, 404);
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
