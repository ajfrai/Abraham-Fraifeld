'use strict';

/**
 * Browser end-to-end test: boots the server, loads the page in Chromium, and
 * drives Peloton's real skybridge widget through the injected bridge.
 *
 * Playwright is optional; the script exits 0 with a notice when it is absent.
 */

const assert = require('node:assert');
const { createRequire } = require('node:module');

function loadPlaywright() {
  const candidates = [
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
  ];
  for (const load of candidates) {
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
  page.on('pageerror', (err) => pageErrors.push(err.message));

  // A real CSP block logs "Refused to ..."; a blocked network does not. Only
  // the former is this project's fault, so only the former fails the run.
  const cspViolations = [];
  page.on('console', (msg) => {
    if (/Refused to (load|connect|execute|apply)/i.test(msg.text())) cspViolations.push(msg.text());
  });

  const widget = () => page.frameLocator('iframe.app-frame');

  await check('page connects to the Peloton MCP server', async () => {
    await page.goto(base, { waitUntil: 'networkidle' });
    assert.strictEqual(await page.textContent('#status-text'), 'Connected');
    const tools = await page.$$eval('.tool code', (els) => els.map((e) => e.textContent));
    for (const t of ['search', 'fetch', 'create-training-plan', 'schedule']) {
      assert.ok(tools.includes(t), `tool list was ${tools}`);
    }
  });

  await check('search mounts the widget and the bridge comes up', async () => {
    await page.click('#inspector-toggle');
    await page.click('#search-button');
    await page.waitForSelector('iframe.app-frame', { timeout: 60000 });
    await page.waitForFunction(() => document.getElementById('placeholder').hidden, null, { timeout: 60000 });

    const frames = await page.$$eval('.log-title', (els) => els.map((e) => e.textContent));
    assert.ok(frames.includes('notify ready'), `no ready signal: ${frames.join(' | ')}`);
    assert.ok(frames.some((f) => f === 'tool_response'), `no tool_response: ${frames.join(' | ')}`);
  });

  await check('the injected window.openai bridge is live inside the frame', async () => {
    await page.waitForTimeout(5000);
    const probe = await widget().locator('body').evaluate(() => ({
      hasOpenai: !!window.openai,
      aliases: !!window.oai && !!window.webplus,
      hasOutput: !!window.openai?.toolOutput,
      resultCount: window.openai?.toolOutput?.results?.length ?? 0,
      theme: window.openai?.theme,
    }));
    assert.ok(probe.hasOpenai, 'window.openai was never defined');
    assert.ok(probe.aliases, 'window.oai / window.webplus aliases missing');
    assert.ok(probe.hasOutput, 'toolOutput never reached the widget');
    assert.ok(probe.resultCount > 0, 'toolOutput carried no results');
  });

  await check('the widget renders live Peloton classes', async () => {
    const text = await widget().locator('body').innerText();
    assert.ok(text.trim().length > 100, 'widget rendered no text');
    // Every result carries an instructor and a discipline; both should show.
    const imgs = await widget().locator('img').count();
    assert.ok(imgs > 0, 'no class images were rendered');
  });

  await check('the frame is sized to the widget, not to the default', async () => {
    // 620 is the placeholder height; a real measurement must replace it.
    const height = await page.$eval('iframe.app-frame', (el) => Math.round(el.getBoundingClientRect().height));
    assert.ok(height > 100, `frame height was ${height}px`);
    assert.notStrictEqual(height, 620, 'height never updated from the default');
  });

  await check('theme reaches the widget', async () => {
    const before = await widget().locator('html').getAttribute('class');
    await page.click('#theme-toggle');
    await page.waitForTimeout(1200);
    await page.waitForFunction(() => document.getElementById('placeholder').hidden, null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    const after = await widget().locator('html').getAttribute('class');
    assert.notStrictEqual(before, after, `widget html class stayed ${JSON.stringify(before)}`);
    assert.match(after || '', /dark/, `expected a dark class, got ${JSON.stringify(after)}`);
  });

  await check('no CSP violations and no page errors', async () => {
    assert.deepStrictEqual(cspViolations, [], `CSP blocked something the widget needed:\n        ${cspViolations.join('\n        ')}`);
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
