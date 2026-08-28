'use strict';

/**
 * Browser e2e: drives the same page against both widget standards.
 *
 * This is the test that matters for the generalisation — if one page can mount
 * an MCP App and a skybridge widget without per-server code, the abstraction
 * holds. Each server is exercised through the identical UI sequence.
 */

const assert = require('node:assert');
const { createRequire } = require('node:module');

function loadPlaywright() {
  for (const load of [
    () => require('playwright'),
    () => {
      const { execSync } = require('node:child_process');
      // npm leaks its own prefix into child processes, so `npm root -g` run
      // under `npm --prefix X` reports X instead of the real global root.
      const env = { ...process.env };
      delete env.npm_config_prefix;
      delete env.npm_config_global_prefix;
      const root = execSync('npm root -g', { encoding: 'utf8', env }).trim();
      return createRequire(`${root}/`)('playwright');
    },
  ]) {
    try {
      return load();
    } catch { /* next */ }
  }
  return null;
}

const playwright = loadPlaywright();
if (!playwright) {
  console.log('\nSkipping e2e: playwright is not installed.');
  console.log('  npm i -D playwright && npx playwright install chromium\n');
  process.exit(0);
}

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
  console.log(`\nBrowser e2e against ${base}\n`);

  const browser = await playwright.chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();

  const pageErrors = [];
  const cspViolations = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  page.on('console', (msg) => {
    if (/Refused to (load|connect|execute|apply)/i.test(msg.text())) cspViolations.push(msg.text());
  });

  const app = () => page.frameLocator('iframe.app-frame');

  await check('the page loads the registry and connects to the first server', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Connected', null, { timeout: 45000 });
    const options = await page.$$eval('#server-select option', (els) => els.map((e) => e.value));
    assert.ok(options.includes('viator') && options.includes('peloton'), `servers were ${options}`);
  });

  // The same sequence, twice, across two incompatible standards.
  const cases = [
    { id: 'viator', tool: 'search_experiences', standard: 'mcp-apps', expect: /From|\$|Book/i },
    { id: 'peloton', tool: 'search', standard: 'skybridge', expect: /min|Yoga|Ride|Flow/i },
  ];

  for (const { id, tool, standard, expect } of cases) {
    await check(`${id}: selecting the server builds a form from its inputSchema`, async () => {
      await page.selectOption('#server-select', id);
      await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Connected', null, { timeout: 45000 });
      await page.selectOption('#tool-select', tool);
      await page.waitForTimeout(400);

      // Fields are generated, never hardcoded — at least the required ones exist.
      const fields = await page.$$eval('#tool-fields input, #tool-fields select, #tool-fields textarea',
        (els) => els.map((e) => e.name));
      assert.ok(fields.length > 0, 'no argument fields were generated');

      const badge = await page.textContent('#standard-badge');
      assert.strictEqual(badge, standard, `standard badge showed ${badge}`);
    });

    await check(`${id}: running the tool mounts its ${standard} app`, async () => {
      await page.click('#run-button');
      await page.waitForSelector('iframe.app-frame', { timeout: 60000 });
      await page.waitForFunction(() => document.getElementById('placeholder').hidden, null, { timeout: 60000 });
      await page.waitForTimeout(6000);

      const text = await app().locator('body').innerText();
      assert.match(text, expect, `widget text did not look like ${id}: ${text.slice(0, 120)}`);
    });

    await check(`${id}: the frame is sized from the app's own content`, async () => {
      const height = await page.$eval('iframe.app-frame', (el) => Math.round(el.getBoundingClientRect().height));
      assert.ok(height > 100, `frame height was ${height}px`);
      assert.notStrictEqual(height, 620, 'height never moved off the placeholder default');
    });
  }

  // Both standards, mounted with no payload at all.
  for (const { id, tool, standard } of cases) {
    await check(`${id}: previewing empty mounts the ${standard} app with no data`, async () => {
      await page.selectOption('#server-select', id);
      await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Connected', null, { timeout: 45000 });
      await page.selectOption('#tool-select', tool);
      await page.waitForTimeout(400);

      await page.click('#preview-button');
      await page.waitForSelector('iframe.app-frame', { timeout: 60000 });
      await page.waitForFunction(() => document.getElementById('placeholder').hidden, null, { timeout: 60000 });
      await page.waitForTimeout(4000);

      // The app must be alive — not a blank frame — and must not have been
      // handed a result. Skybridge exposes that directly on its bridge.
      const alive = await app().locator('body').evaluate((body) => ({
        html: body.innerHTML.length,
        toolOutput: window.openai ? window.openai.toolOutput : 'n/a',
      }));
      assert.ok(alive.html > 0, 'the frame rendered nothing at all');
      if (alive.toolOutput !== 'n/a') {
        assert.strictEqual(alive.toolOutput, null, 'a tool result leaked into the empty preview');
      }

      // And no tool call was made for it.
      const sent = await page.$$eval('.log-title', (els) => els.map((e) => e.textContent));
      assert.ok(
        sent.some((t) => /empty preview/.test(t)),
        `no empty-preview log entry: ${sent.slice(-4).join(' | ')}`,
      );
    });
  }

  // Peloton's fetch/create-training-plan/schedule all take an `index` "from
  // search results", and those indices are sparse. Without help, the form is
  // a bare number box with no way to know what is valid.
  await check('peloton: a prior result feeds the chained tools\' arguments', async () => {
    await page.selectOption('#server-select', 'peloton');
    await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Connected', null, { timeout: 45000 });

    await page.selectOption('#tool-select', 'search');
    await page.waitForTimeout(300);
    await page.click('#run-button');
    await page.waitForFunction(() => document.getElementById('placeholder').hidden, null, { timeout: 60000 });
    await page.waitForTimeout(2000);

    await page.selectOption('#tool-select', 'fetch');
    await page.waitForTimeout(500);

    assert.strictEqual(await page.isVisible('#carry-hint'), true, 'no carry-forward hint shown');
    const options = await page.$$eval('#list-index option', (els) => els.map((o) => ({ v: o.value, l: o.label || o.textContent })));
    assert.ok(options.length > 0, 'index offered no choices from the previous result');
    assert.match(options[0].l, /\d+ — \S/, `option was not labelled: ${options[0].l}`);
    assert.ok((await page.inputValue('#arg-index')).length > 0, 'index was left empty');

    // Array-of-object arguments start from a valid example, not an empty box.
    await page.selectOption('#tool-select', 'schedule');
    await page.waitForTimeout(500);
    const seeded = JSON.parse(await page.inputValue('#arg-classes'));
    assert.ok(Array.isArray(seeded) && seeded.length > 0, 'classes was not seeded');
    for (const item of seeded) {
      assert.ok(Number.isInteger(item.index), `index missing from ${JSON.stringify(item)}`);
      assert.ok(!Number.isNaN(Date.parse(item.startTime)), `startTime unparseable: ${item.startTime}`);
    }
    // The indices must be real ones from the search, not invented.
    const offered = options.map((o) => Number(o.v));
    assert.ok(offered.includes(seeded[0].index), `seeded index ${seeded[0].index} was not in ${offered.slice(0, 5)}`);
  });

  await check('schema descriptions are shown in full', async () => {
    await page.selectOption('#tool-select', 'fetch');
    await page.waitForTimeout(400);
    const desc = await page.textContent('#tool-fields .field-desc');
    assert.match(desc, /Class index from search results/, `description was ${desc}`);
  });

  await check('a server needing OAuth offers a way to connect', async () => {
    const row = await page.isVisible('#auth-row');
    assert.strictEqual(row, true, 'no auth row for a server that supports OAuth');
    assert.match(await page.textContent('#auth-state'), /Not signed in/);
    assert.match(await page.getAttribute('#auth-login', 'href'), /\/auth\/login$/);
  });

  await check('a tool with no widget cannot be previewed', async () => {
    await page.selectOption('#server-select', 'viator');
    await page.waitForFunction(() => document.getElementById('status-text').textContent === 'Connected', null, { timeout: 45000 });
    await page.selectOption('#tool-select', 'get_experience_details');
    await page.waitForTimeout(400);
    assert.strictEqual(await page.isDisabled('#preview-button'), true, 'preview was offered for a data-only tool');
  });

  await check('no CSP violations across either standard', async () => {
    assert.deepStrictEqual(cspViolations, [], `CSP blocked something:\n        ${cspViolations.join('\n        ')}`);
  });

  await check('no uncaught page errors', async () => {
    assert.deepStrictEqual(pageErrors, [], `errors:\n        ${pageErrors.join('\n        ')}`);
  });

  await browser.close();

  console.log(`\n${passed} passed, ${failed} failed\n`);
  server.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('e2e run crashed:', err);
  server.close();
  process.exit(1);
});
