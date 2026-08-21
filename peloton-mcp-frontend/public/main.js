import { SkybridgeHost } from './skybridge-host.js';

const $ = (id) => document.getElementById(id);

const state = {
  host: null,
  frame: null,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  displayMode: 'inline',
  tools: [],
  logEntries: [],
  filters: new Set(['host→widget', 'widget→host', 'host→server']),
};

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

function summarise(entry) {
  const p = entry.payload || {};
  if (p.type === 'notify') return `notify ${p.method}`;
  if (p.type === 'request') return `→ ${p.method}`;
  if (p.type === 'response') return p.error ? `error (id ${p.id})` : `result (id ${p.id})`;
  if (p.type) return p.type;
  return 'message';
}

function addLog(entry) {
  state.logEntries.push(entry);
  if (state.logEntries.length > 400) state.logEntries.shift();
  renderLog();
}

function renderLog() {
  const list = $('log');
  const atBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 40;
  list.replaceChildren();

  for (const entry of state.logEntries) {
    if (!state.filters.has(entry.direction)) continue;

    const item = document.createElement('li');
    item.className = 'log-entry';
    item.dataset.direction = entry.direction;

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'log-head';
    head.innerHTML = '<span class="log-dir"></span><span class="log-title"></span><span class="log-time"></span>';
    head.querySelector('.log-dir').textContent = entry.direction;
    head.querySelector('.log-title').textContent = entry.note || summarise(entry);
    head.querySelector('.log-time').textContent = new Date(entry.at).toLocaleTimeString();

    const body = document.createElement('pre');
    body.className = 'log-body';
    body.hidden = true;
    // Tool payloads are large; keep the inspector responsive.
    const json = JSON.stringify(entry.payload, null, 2) ?? '';
    body.textContent = json.length > 20000 ? `${json.slice(0, 20000)}\n… truncated` : json;

    head.addEventListener('click', () => { body.hidden = !body.hidden; });
    item.append(head, body);
    list.append(item);
  }

  if (atBottom) list.scrollTop = list.scrollHeight;
}

/* ------------------------------------------------------------------ *
 * Server proxy
 * ------------------------------------------------------------------ */

async function callServerTool(name, args) {
  addLog({ direction: 'host→server', at: Date.now(), note: `tools/call ${name}`, payload: { name, arguments: args } });

  const res = await fetch('/api/tools/call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `Proxy returned HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  addLog({
    direction: 'host→server',
    at: Date.now(),
    note: `result ${name} (${body.elapsedMs}ms)`,
    payload: body.result,
  });
  return body.result;
}

/* ------------------------------------------------------------------ *
 * Display mode
 * ------------------------------------------------------------------ */

function applyDisplayMode(mode) {
  const applied = ['inline', 'fullscreen', 'pip'].includes(mode) ? mode : 'inline';
  state.displayMode = applied;

  document.body.classList.toggle('is-fullscreen', applied === 'fullscreen');
  $('display-mode-badge').textContent = applied;
  $('exit-fullscreen').hidden = applied !== 'fullscreen';

  if (state.frame) {
    state.frame.style.height = applied === 'fullscreen'
      ? '100%'
      : `${state.frame.dataset.inlineHeight || 620}px`;
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * Mounting a widget
 * ------------------------------------------------------------------ */

function teardownWidget() {
  state.host?.destroy();
  state.host = null;
  state.frame?.remove();
  state.frame = null;
}

function showPlaceholder({ title, text, busy = false }) {
  $('placeholder').hidden = false;
  $('placeholder-title').textContent = title;
  $('placeholder-text').textContent = text;
  $('placeholder-spinner').hidden = !busy;
}

function baseGlobals() {
  return {
    theme: state.theme,
    displayMode: state.displayMode,
    locale: navigator.language || 'en-US',
    maxHeight: Math.max(window.innerHeight - 200, 400),
    userAgent: {
      device: { type: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop' },
      capabilities: {
        hover: matchMedia('(hover: hover)').matches,
        touch: matchMedia('(pointer: coarse)').matches,
      },
    },
  };
}

/**
 * Mounts a widget and feeds it a tool result.
 *
 * A fresh frame per result keeps widget state from leaking between searches,
 * and matches how a chat host would render each tool call as its own card.
 */
async function mountWidget(uri, toolResult, toolInput) {
  teardownWidget();

  const frame = document.createElement('iframe');
  frame.className = 'app-frame';
  frame.title = 'Peloton widget';
  // No `allow-same-origin`: the widget runs on an opaque origin and cannot
  // touch this page. The shim gives it its bridge from the inside instead.
  frame.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';
  frame.dataset.inlineHeight = '620';
  frame.style.height = '620px';
  // Theme travels in the URL, not over the bridge: the widget's bootstrap
  // reads it synchronously at load, before any message could arrive.
  const params = new URLSearchParams({
    uri,
    theme: state.theme,
    locale: navigator.language || 'en-US',
  });
  frame.src = `/api/widget?${params}`;

  $('stage-body').append(frame);
  state.frame = frame;

  const host = new SkybridgeHost(frame, {
    onLog: addLog,
    callTool: (name, args) => callServerTool(name, args),
    onDisplayMode: applyDisplayMode,
    onHeight: (height) => {
      if (!height || state.displayMode === 'fullscreen') return;
      const clamped = Math.min(Math.max(Math.round(height), 240), 4000);
      frame.dataset.inlineHeight = String(clamped);
      frame.style.height = `${clamped}px`;
    },
    onFollowUp: (prompt) => {
      // The widget asked the "model" something. There is no model here, so
      // treat a follow-up as a new search, which is the useful reading.
      if (!prompt) return;
      $('query').value = prompt;
      $('search-form').requestSubmit();
    },
    onWidgetState: (widgetState) => {
      addLog({ direction: 'widget→host', at: Date.now(), note: 'setWidgetState', payload: widgetState });
    },
    onOpenExternal: openLink,
  });
  state.host = host;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The widget did not signal ready in time')), 25000);
    frame.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The widget frame failed to load')); });
    host.whenReady().then(() => { clearTimeout(timer); resolve(); });
  });

  $('placeholder').hidden = true;

  host.setGlobals(baseGlobals());
  host.sendToolResponse(toolResult, toolResult.structuredContent ?? null, toolInput);

  // Remembered so a theme change can remount without re-running the search.
  state.lastMount = { uri, toolResult, toolInput };
}

/* ------------------------------------------------------------------ *
 * Click-out
 * ------------------------------------------------------------------ */

function openLink(url) {
  if (!url) return;
  const parsed = new URL(url, location.href);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Blocked non-http link: ${parsed.protocol}`);
  if (window.open(parsed.href, '_blank', 'noopener,noreferrer')) return;
  showLinkToast(parsed.href);
}

/** Popups opened from inside the sandboxed frame are blocked; offer a real link. */
function showLinkToast(href) {
  document.getElementById('link-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'link-toast';
  toast.className = 'toast';

  const label = document.createElement('span');
  label.textContent = 'Your browser blocked the popup.';

  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = 'Open on Peloton ↗';
  link.addEventListener('click', () => toast.remove());

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-close';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(label, link, dismiss);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 20000);
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function widgetFor(toolName) {
  const tool = state.tools.find((t) => t.name === toolName);
  // Fall back to the un-suffixed widget if the tool declares no template.
  return tool?.outputTemplate || `ui://widget/${toolName}.html`;
}

function resultCount(result) {
  const results = result?.structuredContent?.results;
  return Array.isArray(results) ? results.length : 0;
}

async function runSearch(event) {
  event?.preventDefault();

  const button = $('search-button');
  const query = $('query').value.trim();
  if (!query) return;

  button.disabled = true;
  button.textContent = 'Searching…';
  teardownWidget();
  showPlaceholder({ title: 'Searching Peloton…', text: `“${query}”`, busy: true });

  try {
    const args = { query };
    const result = await callServerTool('search', args);

    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text')?.text;
      showPlaceholder({ title: 'The search failed', text: text || 'The Peloton MCP server reported an error.' });
      return;
    }

    if (resultCount(result) === 0) {
      showPlaceholder({
        title: 'No classes matched',
        text: 'Try a broader query — a discipline, a duration, or an instructor name.',
      });
      return;
    }

    const uri = widgetFor('search');
    $('stage-sub').textContent = `${uri} · ${query}`;
    await mountWidget(uri, result, args);
  } catch (err) {
    console.error(err);
    showPlaceholder({
      title: err.status === 401 ? 'That call needs a Peloton account' : 'Something went wrong',
      text: String(err.message || err),
    });
  } finally {
    button.disabled = false;
    button.textContent = 'Search';
  }
}

/* ------------------------------------------------------------------ *
 * Connection panel
 * ------------------------------------------------------------------ */

function setStatus(name, text) {
  $('status').dataset.state = name;
  $('status-text').textContent = text;
}

async function loadConnectionInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);

    state.tools = info.tools || [];
    $('endpoint').textContent = new URL(info.endpoint).host;
    setStatus('ok', 'Connected');

    const dl = $('connection-details');
    dl.replaceChildren();
    for (const [key, value] of [
      ['Server', `${info.serverInfo?.name || '?'} v${info.serverInfo?.version || '?'}`],
      ['Protocol', info.protocolVersion || '—'],
      ['Widgets', String((info.resources || []).length)],
      ['Auth', state.tools.some((t) => t.securitySchemes?.some((s) => s.type === 'noauth'))
        ? 'noauth (search)' : 'OAuth'],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.title = value;
      dl.append(dt, dd);
    }

    const list = $('tool-list');
    list.replaceChildren();
    for (const tool of state.tools) {
      const row = document.createElement('div');
      row.className = 'tool';
      const name = document.createElement('code');
      name.textContent = tool.name;
      const meta = document.createElement('span');
      meta.className = 'tool-args';
      meta.textContent = (tool.required || []).join(', ') || '—';
      row.append(name, meta);
      row.title = tool.outputTemplate ? `renders ${tool.outputTemplate}` : 'no widget';
      list.append(row);
    }
  } catch (err) {
    setStatus('bad', 'Disconnected');
    $('endpoint').textContent = 'unavailable';
    $('conn-status').textContent = String(err.message || err);
    showPlaceholder({ title: 'Cannot reach the Peloton MCP server', text: String(err.message || err) });
  }
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

function applyTheme(theme, { remount = false } = {}) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $('theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';

  // Push the global for widgets that watch it live...
  state.host?.setGlobals({ theme });

  // ...but Peloton's set their dark class once, in a bootstrap that runs
  // before any message arrives. Remounting is the only way to actually
  // restyle them, and the last result is replayed so no search is repeated.
  if (remount && state.lastMount) {
    const { uri, toolResult, toolInput } = state.lastMount;
    mountWidget(uri, toolResult, toolInput).catch((err) => {
      showPlaceholder({ title: 'Could not reload the widget', text: String(err.message || err) });
    });
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function init() {
  applyTheme(state.theme);

  $('search-form').addEventListener('submit', runSearch);

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      $('query').value = chip.dataset.q;
      $('search-form').requestSubmit();
    });
  }

  $('theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark', { remount: true });
  });

  $('inspector-toggle').addEventListener('click', () => {
    const inspector = $('inspector');
    inspector.hidden = !inspector.hidden;
    $('inspector-toggle').setAttribute('aria-expanded', String(!inspector.hidden));
    if (!inspector.hidden) renderLog();
  });
  $('close-inspector').addEventListener('click', () => {
    $('inspector').hidden = true;
    $('inspector-toggle').setAttribute('aria-expanded', 'false');
  });
  $('clear-log').addEventListener('click', () => {
    state.logEntries = [];
    renderLog();
  });

  for (const box of document.querySelectorAll('.filter')) {
    box.addEventListener('change', () => {
      if (box.checked) state.filters.add(box.value);
      else state.filters.delete(box.value);
      renderLog();
    });
  }

  $('exit-fullscreen').addEventListener('click', () => {
    const applied = applyDisplayMode('inline');
    state.host?.setGlobals({ displayMode: applied });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.displayMode === 'fullscreen') $('exit-fullscreen').click();
  });

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      state.host?.setGlobals({ maxHeight: Math.max(window.innerHeight - 200, 400) });
    }, 200);
  });

  loadConnectionInfo();
}

init();
