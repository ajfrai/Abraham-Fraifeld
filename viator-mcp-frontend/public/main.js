import { McpAppHost } from './mcp-app-host.js';

const $ = (id) => document.getElementById(id);

const state = {
  host: null,
  frame: null,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  displayMode: 'inline',
  sessionId: crypto.randomUUID(),
  searchTool: null,
  lastArguments: null,
  logEntries: [],
  filters: new Set(['host→app', 'app→host', 'host→server']),
};

/* ------------------------------------------------------------------ *
 * Inspector log
 * ------------------------------------------------------------------ */

function summarise(payload) {
  if (payload.method) {
    return payload.id === undefined ? `notify ${payload.method}` : `→ ${payload.method}`;
  }
  if (payload.error) return `error (id ${payload.id})`;
  return `result (id ${payload.id})`;
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
    head.innerHTML =
      `<span class="log-dir">${entry.direction}</span>` +
      `<span class="log-title"></span>` +
      `<span class="log-time"></span>`;
    head.querySelector('.log-title').textContent = entry.note || summarise(entry.payload);
    head.querySelector('.log-time').textContent = new Date(entry.at).toLocaleTimeString();

    const body = document.createElement('pre');
    body.className = 'log-body';
    body.hidden = true;
    body.textContent = JSON.stringify(entry.payload, null, 2);

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
  if (!res.ok) throw new Error(body.error || `Proxy returned HTTP ${res.status}`);

  addLog({
    direction: 'host→server',
    at: Date.now(),
    note: `result ${name} (${body.elapsedMs}ms)`,
    payload: body.result,
  });
  return body.result;
}

/* ------------------------------------------------------------------ *
 * Click-out
 * ------------------------------------------------------------------ */

/**
 * Opens a link the app asked for, with a fallback for blocked popups.
 *
 * The click that triggered this happened inside the sandboxed iframe, so the
 * top-level document has no transient user activation and `window.open` is
 * blocked outright. When that happens the URL is surfaced as a toast: clicking
 * it is a gesture in *this* document, which the browser does allow.
 */
function openLink(url) {
  const parsed = new URL(url, location.href);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Blocked non-http link: ${parsed.protocol}`);

  const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer');
  if (opened) return;

  showLinkToast(parsed.href);
}

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
  link.textContent = 'Open on Viator ↗';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-close';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(label, link, dismiss);
  document.body.append(toast);

  link.addEventListener('click', () => toast.remove());
  setTimeout(() => toast.remove(), 20000);
}

/* ------------------------------------------------------------------ *
 * Host context
 * ------------------------------------------------------------------ */

function getHostContext() {
  const body = $('stage-body');
  return {
    theme: state.theme,
    displayMode: state.displayMode,
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: {
      width: body.clientWidth || 900,
      maxHeight: Math.max(window.innerHeight - 160, 400),
    },
    locale: $('locale').value || 'en-US',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: 'viator-mcp-frontend/1.0.0',
    platform: 'web',
    deviceCapabilities: {
      touch: matchMedia('(pointer: coarse)').matches,
      hover: matchMedia('(hover: hover)').matches,
    },
    ...(state.searchTool
      ? { toolInfo: { id: 1, tool: state.searchTool } }
      : {}),
  };
}

/* ------------------------------------------------------------------ *
 * Display mode
 * ------------------------------------------------------------------ */

function applyDisplayMode(mode) {
  const allowed = ['inline', 'fullscreen'];
  const applied = allowed.includes(mode) ? mode : 'inline';
  state.displayMode = applied;

  document.body.classList.toggle('is-fullscreen', applied === 'fullscreen');
  $('display-mode-badge').textContent = applied;
  $('exit-fullscreen').hidden = applied !== 'fullscreen';

  // In fullscreen the app owns the viewport, so drop the height the app asked
  // for while inline and let it fill instead.
  if (state.frame) {
    state.frame.style.height = applied === 'fullscreen' ? '100%' : `${state.frame.dataset.inlineHeight || 620}px`;
  }
  return applied;
}

/* ------------------------------------------------------------------ *
 * Mounting the MCP App
 * ------------------------------------------------------------------ */

function teardownApp() {
  if (state.host) {
    state.host.destroy();
    state.host = null;
  }
  if (state.frame) {
    state.frame.remove();
    state.frame = null;
  }
}

function showPlaceholder({ title, text, busy = false }) {
  const placeholder = $('placeholder');
  placeholder.hidden = false;
  $('placeholder-title').textContent = title;
  $('placeholder-text').textContent = text;
  $('placeholder-spinner').hidden = !busy;
}

/**
 * Creates a fresh iframe and completes the handshake.
 *
 * A new app instance per search is deliberate: `tool-input` and `tool-result`
 * are one-shot notifications in this protocol, so re-rendering a live instance
 * with a second result is not something the app is built to receive.
 */
async function mountApp(toolArguments, toolResult) {
  teardownApp();

  const frame = document.createElement('iframe');
  frame.className = 'app-frame';
  frame.title = 'Viator Experiences MCP App';
  // No `allow-same-origin`: the app runs on an opaque origin and cannot reach
  // this page's DOM, cookies or storage. It gets popups so click-outs work.
  frame.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms';
  frame.dataset.inlineHeight = '620';
  frame.style.height = '620px';
  frame.src = '/api/app.html';

  $('stage-body').append(frame);
  state.frame = frame;

  const host = new McpAppHost(frame, {
    getHostContext,
    onLog: addLog,
    callServerTool: async (params) => callServerTool(params.name, params.arguments || {}),
    onOpenLink: openLink,
    onDisplayMode: applyDisplayMode,
    onSizeChanged: ({ height }) => {
      if (!height || state.displayMode === 'fullscreen') return;
      const clamped = Math.min(Math.max(Math.round(height), 240), 4000);
      frame.dataset.inlineHeight = String(clamped);
      frame.style.height = `${clamped}px`;
    },
    onMessage: (text) => {
      if (!text) return;
      $('searchTerm').value = text;
      $('search-form').requestSubmit();
    },
    onTeardown: () => {
      teardownApp();
      showPlaceholder({ title: 'App closed', text: 'The app asked to be torn down. Run a search to load it again.' });
    },
  });
  state.host = host;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The MCP App did not complete its handshake in time')), 20000);
    frame.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The app frame failed to load')); });
    host.whenReady().then(() => { clearTimeout(timer); resolve(); });
  });

  $('placeholder').hidden = true;

  host.sendToolInput(toolArguments);
  host.sendToolResult(toolResult);
}

/* ------------------------------------------------------------------ *
 * Search
 * ------------------------------------------------------------------ */

function collectArguments() {
  const num = (id) => {
    const raw = $(id).value.trim();
    if (raw === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const startDate = $('startDate').value;

  const args = {
    searchTerm: $('searchTerm').value.trim(),
    startDate,
    // The published contract says endDate defaults to startDate, but the live
    // server rejects the call without it, so always send a concrete date.
    endDate: $('endDate').value || startDate,
    sessionId: state.sessionId,
    limit: num('limit') ?? 5,
    currency: $('currency').value,
    locale: $('locale').value.trim() || 'en-US',
  };

  const fromPrice = num('fromPrice');
  const toPrice = num('toPrice');
  const duration = num('duration');
  if (fromPrice !== undefined) args.fromPrice = fromPrice;
  if (toPrice !== undefined) args.toPrice = toPrice;
  if (duration !== undefined) args.duration = duration;

  return args;
}

function countExperiences(result) {
  const structured = result.structuredContent;
  if (structured && Array.isArray(structured.experiences)) return structured.experiences.length;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed.experiences)) return parsed.experiences.length;
    } catch { /* fall through */ }
  }
  return 0;
}

/** Tool errors arrive inside a 200 with isError set, per the MCP contract. */
function toolErrorMessage(result) {
  if (!result.isError) return null;
  const text = result.content?.find((c) => c.type === 'text')?.text;
  return text || 'The Viator MCP server reported an error.';
}

async function runSearch(event) {
  event?.preventDefault();

  const button = $('search-button');
  const args = collectArguments();
  if (!args.searchTerm || !args.startDate) return;

  button.disabled = true;
  button.textContent = 'Searching…';
  teardownApp();
  showPlaceholder({ title: 'Searching Viator…', text: `“${args.searchTerm}”`, busy: true });

  try {
    const result = await callServerTool('search_experiences', args);

    const failure = toolErrorMessage(result);
    if (failure) {
      showPlaceholder({ title: 'The search failed', text: failure });
      return;
    }

    // Keep the server-assigned session id so get_experience_details correlates.
    const sessionId = result.structuredContent?.sessionId;
    if (sessionId) state.sessionId = sessionId;

    if (countExperiences(result) === 0) {
      showPlaceholder({
        title: 'No experiences matched',
        text: 'Try widening the dates, relaxing the price range, or searching a broader destination.',
      });
      return;
    }

    state.lastArguments = args;
    $('stage-sub').textContent = `ui://mcp/experiences · ${args.searchTerm}`;
    await mountApp(args, result);
  } catch (err) {
    console.error(err);
    showPlaceholder({ title: 'Something went wrong', text: String(err.message || err) });
  } finally {
    button.disabled = false;
    button.textContent = 'Search';
  }
}

/* ------------------------------------------------------------------ *
 * Connection panel
 * ------------------------------------------------------------------ */

function setStatus(stateName, text) {
  const el = $('status');
  el.dataset.state = stateName;
  $('status-text').textContent = text;
}

async function loadConnectionInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);

    state.searchTool = (info.tools || []).find((t) => t.name === 'search_experiences') || null;

    $('endpoint').textContent = new URL(info.endpoint).host;
    setStatus('ok', 'Connected');

    const dl = $('connection-details');
    dl.replaceChildren();
    const rows = [
      ['Server', `${info.serverInfo?.name || 'unknown'} v${info.serverInfo?.version || '?'}`],
      ['Protocol', info.protocolVersion || '—'],
      ['Endpoint', info.endpoint],
      ['Auth', 'none required'],
    ];
    for (const [key, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.title = value;
      dl.append(dt, dd);
    }

    const tools = $('tool-list');
    tools.replaceChildren();
    for (const tool of info.tools || []) {
      const row = document.createElement('div');
      row.className = 'tool';
      const name = document.createElement('code');
      name.textContent = tool.name;
      const required = document.createElement('span');
      required.className = 'tool-args';
      required.textContent = (tool.inputSchema?.required || []).join(', ');
      row.append(name, required);
      tools.append(row);
    }
    for (const resource of info.resources || []) {
      const row = document.createElement('div');
      row.className = 'tool resource';
      const name = document.createElement('code');
      name.textContent = resource.uri;
      const kind = document.createElement('span');
      kind.className = 'tool-args';
      kind.textContent = 'MCP App';
      row.append(name, kind);
      tools.append(row);
    }
  } catch (err) {
    setStatus('bad', 'Disconnected');
    $('endpoint').textContent = 'unavailable';
    $('conn-status').textContent = String(err.message || err);
    showPlaceholder({ title: 'Cannot reach the Viator MCP server', text: String(err.message || err) });
  }
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $('theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';
  // Themed hosts are expected to tell the app; it restyles itself to match.
  state.host?.sendContextChanged({ theme });
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

function initDates() {
  const today = new Date();
  const start = new Date(today.getTime() + 7 * 864e5);
  const end = new Date(today.getTime() + 10 * 864e5);
  const iso = (d) => d.toISOString().slice(0, 10);
  $('startDate').value = iso(start);
  $('endDate').value = iso(end);
  $('startDate').min = iso(today);
  $('endDate').min = iso(today);
}

function init() {
  initDates();
  applyTheme(state.theme);

  $('search-form').addEventListener('submit', runSearch);

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      $('searchTerm').value = chip.dataset.term;
      $('search-form').requestSubmit();
    });
  }

  $('theme-toggle').addEventListener('click', () => {
    applyTheme(state.theme === 'dark' ? 'light' : 'dark');
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
    state.host?.sendContextChanged({ displayMode: applied });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.displayMode === 'fullscreen') {
      $('exit-fullscreen').click();
    }
  });

  // Container size is part of the app's layout contract; keep it current.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const body = $('stage-body');
      state.host?.sendContextChanged({
        containerDimensions: {
          width: body.clientWidth,
          maxHeight: Math.max(window.innerHeight - 160, 400),
        },
      });
    }, 200);
  });

  loadConnectionInfo();
}

init();
