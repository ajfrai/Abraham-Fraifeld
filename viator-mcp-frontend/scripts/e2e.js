'use strict';

/**
 * Browser end-to-end test: boots the server, loads the page in Chromium, and
 * exercises the full MCP Apps handshake against the real Viator app bundle.
 *
 * Playwright is not a dependency of this project. If it is not importable the
 * script exits 0 with a notice, so `npm test` stays useful without it:
 *
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/e2e.js
 */

const assert = require('node:assert');
const { createRequire } = require('node:module');

function loadPlaywright() {
  const candidates = [
    () => require('playwright'),
    // Fall back to a global install, which is how CI images usually ship it.
    () => {
      const { execSync } = require('node:child_process');
      const root = execSync('npm root -g', { encoding: 'utf8' }).trim();
      return createRequire(`${root}/`)('playwright');
    },
  ];
  for (const load of candidates) {
    try {
      return load();
    } catch { /* try the next one */ }
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
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // Anything the app tried to load from a blocked origin shows up here. Image
  // CDN failures are expected on restricted networks and are not counted.
  const cspViolations = [];
  page.on('console', (msg) => {
    if (/Refused to (load|connect|execute)/i.test(msg.text())) cspViolations.push(msg.text());
  });

  const app = () => page.frameLocator('iframe.app-frame');

  await check('page connects to the MCP server', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.strictEqual(await page.textContent('#status-text'), 'Connected');
    const tools = await page.$$eval('.tool code', (els) => els.map((e) => e.textContent));
    assert.ok(tools.includes('search_experiences'), `tool list was ${tools}`);
    assert.ok(tools.includes('ui://mcp/experiences'), 'MCP App resource is not listed');
  });

  await check('search mounts the app and completes the handshake', async () => {
    await page.click('#inspector-toggle');
    await page.click('#search-button');
    await page.waitForSelector('iframe.app-frame', { timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('placeholder').hidden, null, { timeout: 60000 });

    const frames = await page.$$eval('.log-title', (els) => els.map((e) => e.textContent));
    for (const expected of [
      '→ ui/initialize',
      'notify ui/notifications/initialized',
      'notify ui/notifications/tool-input',
      'notify ui/notifications/tool-result',
    ]) {
      assert.ok(frames.includes(expected), `protocol log is missing "${expected}"\n        got: ${frames.join(' | ')}`);
    }
  });

  await check('the app renders live experiences', async () => {
    await page.waitForTimeout(5000);
    const text = await app().locator('#root').innerText();
    assert.match(text, /From \$\d/, 'no price rendered');
    assert.match(text, /Book on Viator/, 'no click-out button rendered');
    const cards = await app().locator('text=View Details').count();
    assert.ok(cards > 0, 'no experience cards rendered');
  });

  await check('the app resized the host frame', async () => {
    const height = await page.$eval('iframe.app-frame', (el) => el.getBoundingClientRect().height);
    assert.ok(height > 200, `frame height was ${height}px`);
  });

  await check('View Details proxies get_experience_details and goes fullscreen', async () => {
    await app().locator('text=View Details').first().click();
    await page.waitForFunction(
      () => document.getElementById('display-mode-badge').textContent === 'fullscreen',
      null,
      { timeout: 20000 },
    );
    assert.ok(await page.evaluate(() => document.body.classList.contains('is-fullscreen')));

    await page.waitForFunction(
      () => [...document.querySelectorAll('.log-title')].some((e) => /get_experience_details/.test(e.textContent)),
      null,
      { timeout: 20000 },
    );
  });

  await check('exiting fullscreen returns the app inline', async () => {
    await page.click('#exit-fullscreen');
    await page.waitForFunction(
      () => document.getElementById('display-mode-badge').textContent === 'inline',
      null,
      { timeout: 10000 },
    );
    assert.strictEqual(await page.evaluate(() => document.body.classList.contains('is-fullscreen')), false);
  });

  await check('click-out reaches the browser', async () => {
    // The gesture happens inside the sandboxed frame, so the top document has
    // no user activation and the popup is blocked. Either the tab opens or the
    // toast fallback appears — both count, silently dropping the link does not.
    const popup = context.waitForEvent('page', { timeout: 6000 }).catch(() => null);
    await app().locator('text=Book on Viator').first().click();
    const opened = await popup;
    if (!opened) {
      await page.waitForSelector('#link-toast', { timeout: 6000 });
      const href = await page.getAttribute('#link-toast a', 'href');
      assert.match(href, /^https:\/\/(www\.)?viator\.com\//, `toast pointed at ${href}`);
    }
  });

  await check('theme changes are pushed to the app', async () => {
    const before = await page.$$eval('.log-title', (e) => e.filter((x) => /host-context-changed/.test(x.textContent)).length);
    await page.click('#theme-toggle');
    await page.waitForTimeout(800);
    const after = await page.$$eval('.log-title', (e) => e.filter((x) => /host-context-changed/.test(x.textContent)).length);
    assert.ok(after > before, 'no host-context-changed notification was sent');
  });

  await check('no CSP violations and no page errors', async () => {
    assert.deepStrictEqual(cspViolations, [], `CSP blocked something the app needed:\n        ${cspViolations.join('\n        ')}`);
    assert.deepStrictEqual(pageErrors, [], `uncaught errors:\n        ${pageErrors.join('\n        ')}`);
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
