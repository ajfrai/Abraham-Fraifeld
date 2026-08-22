import { adapterFor, STANDARDS } from './hosts/index.js';

const $ = (id) => document.getElementById(id);

const state = {
  adapter: null,
  frame: null,
  servers: [],
  server: null,      // the described server currently selected
  tool: null,
  theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  displayMode: 'inline',
  lastMount: null,
  logEntries: [],
  filters: new Set(['host→app', 'app→host', 'host→server']),
};

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */

function summarise(entry) {
  const p = entry.payload || {};
  if (p.jsonrpc) {
    if (p.method) return p.id === undefined ? `notify ${p.method}` : `→ ${p.method}`;
    return p.error ? `error (id ${p.id})` : `result (id ${p.id})`;
  }
  if (p.type === 'notify') return `notify ${p.method}`;
  if (p.type === 'request') return `→ ${p.method}`;
  if (p.type === 'response') return p.error ? `error (id ${p.id})` : `result (id ${p.id})`;
  return p.type || 'message';
}

function addLog(entry) {
  // Both host implementations label directions their own way; normalise so one
  // set of filters covers either standard.
  const direction = entry.direction
    .replace('host→widget', 'host→app')
    .replace('widget→host', 'app→host');
  state.logEntries.push({ ...entry, direction });
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

async function callTool(name, args) {
  const id = state.server.id;
  addLog({ direction: 'host→server', at: Date.now(), note: `${id} · tools/call ${name}`, payload: { name, arguments: args } });

  const res = await fetch(`/api/servers/${id}/tools/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, arguments: args }),
  });
  const body = await res.json();
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  addLog({ direction: 'host→server', at: Date.now(), note: `result ${name} (${body.elapsedMs}ms)`, payload: body.result });
  return body.result;
}

/* ------------------------------------------------------------------ *
 * Context handed to whichever host is running
 * ------------------------------------------------------------------ */

function getContext() {
  const body = $('stage-body');
  const base = {
    theme: state.theme,
    displayMode: state.displayMode,
    locale: navigator.language || 'en-US',
    userAgent: {
      device: { type: matchMedia('(pointer: coarse)').matches ? 'mobile' : 'desktop' },
      capabilities: {
        hover: matchMedia('(hover: hover)').matches,
        touch: matchMedia('(pointer: coarse)').matches,
      },
    },
  };

  if (state.tool?.standard === STANDARDS.SKYBRIDGE) {
    return { ...base, maxHeight: Math.max(window.innerHeight - 200, 400) };
  }

  // MCP Apps expect a richer context object, including the tool definition.
  return {
    ...base,
    availableDisplayModes: ['inline', 'fullscreen'],
    containerDimensions: {
      width: body.clientWidth || 900,
      maxHeight: Math.max(window.innerHeight - 160, 400),
    },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: 'mcp-app-host/1.0.0',
    platform: 'web',
    deviceCapabilities: base.userAgent.capabilities,
    ...(state.tool ? { toolInfo: { id: 1, tool: { name: state.tool.name, inputSchema: state.tool.inputSchema } } } : {}),
  };
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
 * Mounting
 * ------------------------------------------------------------------ */

function teardown() {
  state.adapter?.destroy();
  state.adapter = null;
  state.frame?.remove();
  state.frame = null;
}

function showPlaceholder({ title, text, busy = false }) {
  $('placeholder').hidden = false;
  $('placeholder-title').textContent = title;
  $('placeholder-text').textContent = text;
  $('placeholder-spinner').hidden = !busy;
}

/**
 * Mounts a widget and, when there is one, hands it a tool result.
 *
 * `result` is optional. Omitting it mounts the app with its bridge live and
 * its context pushed, but no payload — which is how the app's own empty state
 * gets rendered, without inventing fake data to feed it.
 */
async function mount({ tool, result = null, args = null }) {
  teardown();

  const Adapter = adapterFor(tool.standard);

  const frame = document.createElement('iframe');
  frame.className = 'app-frame';
  frame.title = `${state.server.label} — ${tool.name}`;
  // Never allow-same-origin: the widget runs on an opaque origin either way.
  // Skybridge widgets get their bridge from an injected shim instead.
  frame.sandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms';
  frame.dataset.inlineHeight = '620';
  frame.style.height = '620px';

  const params = new URLSearchParams({
    uri: tool.template,
    theme: state.theme,
    locale: navigator.language || 'en-US',
  });
  frame.src = `/api/servers/${state.server.id}/widget?${params}`;

  $('stage-body').append(frame);
  state.frame = frame;

  const adapter = new Adapter(frame, {
    getContext,
    onLog: addLog,
    callTool,
    onDisplayMode: applyDisplayMode,
    onHeight: (height) => {
      if (!height || state.displayMode === 'fullscreen') return;
      const clamped = Math.min(Math.max(Math.round(height), 240), 4000);
      frame.dataset.inlineHeight = String(clamped);
      frame.style.height = `${clamped}px`;
    },
    onFollowUp: (prompt) => {
      if (!prompt) return;
      // No model here; the closest useful reading is "run the tool again".
      const first = firstStringField();
      if (first) {
        const input = $(`arg-${first}`);
        if (input) input.value = prompt;
        $('tool-form').requestSubmit();
      }
    },
    onWidgetState: (widgetState) => {
      addLog({ direction: 'app→host', at: Date.now(), note: 'setWidgetState', payload: widgetState });
    },
    onOpenLink: openLink,
    onTeardown: () => {
      teardown();
      showPlaceholder({ title: 'App closed', text: 'The app asked to be torn down. Run the tool again to reload it.' });
    },
  });
  state.adapter = adapter;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The app did not come up in time')), 30000);
    frame.addEventListener('error', () => { clearTimeout(timer); reject(new Error('The app frame failed to load')); });
    adapter.whenReady().then(() => { clearTimeout(timer); resolve(); });
  });

  $('placeholder').hidden = true;

  // Context first and always; the payload only if there is one.
  adapter.pushContext();
  if (result) {
    adapter.deliver({ result, args });
  } else {
    addLog({
      direction: 'host→app',
      at: Date.now(),
      note: 'empty preview — no tool result sent',
      payload: { tool: tool.name, template: tool.template },
    });
  }

  state.lastMount = { tool, result, args };
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

/** Popups from inside the sandboxed frame are blocked; offer a real link. */
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
  link.textContent = 'Open link ↗';
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
 * Form generation
 *
 * The whole point of the generic host: the argument form is built from the
 * tool's own inputSchema, so a server nobody has seen before is still usable.
 * ------------------------------------------------------------------ */

function firstStringField() {
  const props = state.tool?.inputSchema?.properties || {};
  const required = state.tool?.inputSchema?.required || [];
  return required.find((k) => (props[k]?.type ?? 'string') === 'string') || Object.keys(props)[0];
}

function renderToolFields() {
  const container = $('tool-fields');
  container.replaceChildren();
  if (!state.tool) return;

  const schema = state.tool.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const defaults = state.tool.defaults || {};

  // Required first, then the rest — long optional tails stay out of the way.
  const names = Object.keys(props).sort((a, b) => Number(required.has(b)) - Number(required.has(a)));

  const optionalBox = document.createElement('details');
  optionalBox.className = 'more';
  const summary = document.createElement('summary');
  optionalBox.append(summary);
  let optionalCount = 0;

  for (const name of names) {
    const spec = props[name] || {};
    const field = buildField(name, spec, required.has(name), defaults[name]);
    if (required.has(name)) container.append(field);
    else { optionalBox.append(field); optionalCount += 1; }
  }

  if (optionalCount) {
    summary.textContent = `${optionalCount} optional argument${optionalCount === 1 ? '' : 's'}`;
    container.append(optionalBox);
  }
}

function buildField(name, spec, isRequired, defaultValue) {
  const label = document.createElement('label');
  label.className = 'field';

  const caption = document.createElement('span');
  caption.textContent = isRequired ? `${name} *` : name;
  if (spec.description) caption.title = spec.description;
  label.append(caption);

  let input;
  const enumValues = spec.enum || spec.items?.enum;

  if (enumValues) {
    input = document.createElement('select');
    if (!isRequired) input.append(new Option('—', ''));
    for (const value of enumValues) input.append(new Option(String(value), String(value)));
  } else if (spec.type === 'boolean') {
    input = document.createElement('select');
    input.append(new Option('—', ''), new Option('true', 'true'), new Option('false', 'false'));
  } else if (spec.type === 'integer' || spec.type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    if (spec.minimum !== undefined) input.min = spec.minimum;
    if (spec.maximum !== undefined) input.max = spec.maximum;
    if (spec.type === 'integer') input.step = '1';
  } else if (spec.type === 'array' || spec.type === 'object') {
    // No sensible widget for these; take JSON and validate on submit.
    input = document.createElement('textarea');
    input.rows = 3;
    input.placeholder = spec.type === 'array' ? '[]' : '{}';
  } else {
    const isLong = /term|query|search|prompt|description/i.test(name);
    input = document.createElement(isLong ? 'textarea' : 'input');
    if (isLong) input.rows = 2;
    // A date-shaped field gets a real date picker.
    else if (/date$/i.test(name) || spec.format === 'date') input.type = 'date';
    else input.type = 'text';
  }

  input.id = `arg-${name}`;
  input.name = name;
  input.dataset.type = spec.type || 'string';
  if (defaultValue !== undefined && defaultValue !== null) input.value = String(defaultValue);
  if (isRequired) input.required = true;
  if (spec.description && !input.placeholder) input.placeholder = spec.description.slice(0, 60);

  label.append(input);
  return label;
}

/** Reads the generated form back into a typed arguments object. */
function collectArguments() {
  const schema = state.tool.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const args = {};

  for (const name of Object.keys(props)) {
    const input = $(`arg-${name}`);
    if (!input) continue;
    const raw = input.value.trim();
    if (raw === '') {
      if (required.has(name)) throw new Error(`"${name}" is required`);
      continue;
    }
    const type = props[name].type;
    if (type === 'integer' || type === 'number') {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`"${name}" must be a number`);
      args[name] = type === 'integer' ? Math.round(value) : value;
    } else if (type === 'boolean') {
      args[name] = raw === 'true';
    } else if (type === 'array' || type === 'object') {
      try {
        args[name] = JSON.parse(raw);
      } catch {
        throw new Error(`"${name}" must be valid JSON`);
      }
    } else {
      args[name] = raw;
    }
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * Running a tool
 * ------------------------------------------------------------------ */

async function runTool(event) {
  event?.preventDefault();
  if (!state.tool) return;

  const button = $('run-button');
  let args;
  try {
    args = collectArguments();
  } catch (err) {
    showPlaceholder({ title: 'Check the arguments', text: String(err.message) });
    return;
  }

  button.disabled = true;
  button.textContent = 'Running…';
  teardown();
  showPlaceholder({ title: `Running ${state.tool.name}…`, text: state.server.label, busy: true });

  try {
    const result = await callTool(state.tool.name, args);

    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text')?.text;
      showPlaceholder({ title: 'The tool reported an error', text: text || 'No detail was given.' });
      return;
    }

    if (!state.tool.template) {
      showPlaceholder({
        title: 'No app to render',
        text: `${state.tool.name} returned data but declares no UI resource. The raw result is in the inspector.`,
      });
      return;
    }

    $('stage-sub').textContent = `${state.tool.template} · ${state.tool.name}`;
    await mount({ tool: state.tool, result, args });
  } catch (err) {
    console.error(err);
    showPlaceholder({
      title: err.status === 401 ? 'This tool needs authentication' : 'Something went wrong',
      text: String(err.message || err),
    });
  } finally {
    button.disabled = false;
    button.textContent = 'Run tool';
  }
}

/**
 * Mounts the widget with no tool result at all.
 *
 * Useful for seeing an app's own empty state — what it renders before any data
 * arrives, which is a real design surface and otherwise invisible here. No tool
 * is called, so this also works for a server whose tools need credentials.
 */
async function previewEmpty() {
  if (!state.tool) return;

  if (!state.tool.template) {
    showPlaceholder({
      title: 'No app to preview',
      text: `${state.tool.name} declares no UI resource, so there is nothing to render empty.`,
    });
    return;
  }

  const button = $('preview-button');
  button.disabled = true;
  button.textContent = 'Loading…';
  teardown();
  showPlaceholder({ title: `Loading ${state.tool.template}…`, text: 'no data will be sent', busy: true });

  try {
    $('stage-sub').textContent = `${state.tool.template} · empty`;
    await mount({ tool: state.tool });
  } catch (err) {
    console.error(err);
    showPlaceholder({ title: 'Could not load the app', text: String(err.message || err) });
  } finally {
    button.disabled = false;
    button.textContent = 'Preview empty';
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

function selectTool(name) {
  state.tool = state.server.tools.find((t) => t.name === name) || null;
  $('tool-description').textContent = state.tool?.description?.slice(0, 240) || '';

  const badge = $('standard-badge');
  badge.hidden = !state.tool?.standard;
  if (state.tool?.standard) badge.textContent = state.tool.standard;

  const warning = $('tool-warning');
  if (!state.tool) warning.textContent = '';
  else if (!state.tool.template) {
    // `declared-none` is a statement by the server, not a gap in our detection,
    // so say which it is rather than implying the tool is broken.
    warning.textContent = state.tool.templateSource === 'declared-none'
      ? `${state.tool.name} declares no widget of its own — it returns data, and exists for a rendered app to call.`
      : 'This tool declares no UI resource — it will return data only.';
  } else if (!state.tool.standard) warning.textContent = 'This tool\'s resource uses an unrecognised mime type.';
  else if (state.tool.templateSource === 'sole-ui-resource') {
    warning.textContent = 'Widget inferred: this tool names none, and the server exposes exactly one.';
  } else if (state.tool.securitySchemes && !state.tool.securitySchemes.some((s) => s.type === 'noauth')) {
    warning.textContent = 'This tool needs an authenticated session.';
  } else warning.textContent = '';

  // Nothing to preview when the tool renders nothing.
  $('preview-button').disabled = !state.tool?.template;

  renderToolFields();
}

async function selectServer(id) {
  teardown();
  state.lastMount = null;
  setStatus('pending', 'Connecting');
  showPlaceholder({ title: 'Connecting…', text: id, busy: true });

  try {
    const res = await fetch(`/api/servers/${id}/info`);
    const info = await res.json();
    if (!res.ok) throw new Error(info.error || `HTTP ${res.status}`);

    state.server = info;
    $('endpoint').textContent = new URL(info.endpoint).host;
    $('server-notes').textContent = info.notes || '';
    setStatus('ok', 'Connected');

    const dl = $('server-details');
    dl.replaceChildren();
    for (const [key, value] of [
      ['Server', `${info.serverInfo?.name || '?'} v${info.serverInfo?.version || '?'}`],
      ['Protocol', info.protocolVersion || '—'],
      ['Standard', info.standards.filter(Boolean).join(', ') || 'none detected'],
      ['Tools', String(info.tools.length)],
    ]) {
      const dt = document.createElement('dt');
      dt.textContent = key;
      const dd = document.createElement('dd');
      dd.textContent = value;
      dd.title = value;
      dl.append(dt, dd);
    }

    const select = $('tool-select');
    select.replaceChildren();
    for (const tool of info.tools) {
      // Mark what can actually be rendered, so the choice is informed.
      const suffix = tool.template ? (tool.standard ? '' : ' (unknown UI)') : ' (data only)';
      select.append(new Option(tool.name + suffix, tool.name));
    }

    // Default to the first tool that can actually render something.
    const renderable = info.tools.find((t) => t.template && t.standard);
    select.value = (renderable || info.tools[0])?.name || '';
    selectTool(select.value);

    showPlaceholder({
      title: `${info.label} is ready`,
      text: `Run ${select.value || 'a tool'} to mount its app.`,
    });
  } catch (err) {
    setStatus('bad', 'Disconnected');
    showPlaceholder({ title: `Cannot reach ${id}`, text: String(err.message || err) });
  }
}

function setStatus(name, text) {
  $('status').dataset.state = name;
  $('status-text').textContent = text;
}

/* ------------------------------------------------------------------ *
 * Theme
 * ------------------------------------------------------------------ */

function applyTheme(theme, { remount = false } = {}) {
  state.theme = theme;
  document.documentElement.dataset.theme = theme;
  $('theme-label').textContent = theme === 'dark' ? 'Light' : 'Dark';

  state.adapter?.setTheme(theme);

  // Skybridge widgets read the theme once at boot, so only a reload restyles
  // them. The adapter says which behaviour applies rather than us guessing.
  const needsRemount = state.adapter && adapterFor(state.tool.standard).remountForTheme;
  if (remount && needsRemount && state.lastMount) {
    mount(state.lastMount).catch((err) => {
      showPlaceholder({ title: 'Could not reload the app', text: String(err.message || err) });
    });
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

async function init() {
  applyTheme(state.theme);

  $('tool-form').addEventListener('submit', runTool);
  $('preview-button').addEventListener('click', previewEmpty);
  $('server-select').addEventListener('change', (e) => selectServer(e.target.value));
  $('tool-select').addEventListener('change', (e) => selectTool(e.target.value));

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
  $('clear-log').addEventListener('click', () => { state.logEntries = []; renderLog(); });

  for (const box of document.querySelectorAll('.filter')) {
    box.addEventListener('change', () => {
      if (box.checked) state.filters.add(box.value);
      else state.filters.delete(box.value);
      renderLog();
    });
  }

  $('exit-fullscreen').addEventListener('click', () => {
    const applied = applyDisplayMode('inline');
    state.adapter?.setDisplayMode(applied);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.displayMode === 'fullscreen') $('exit-fullscreen').click();
  });

  try {
    const res = await fetch('/api/servers');
    const { servers } = await res.json();
    state.servers = servers || [];

    const select = $('server-select');
    select.replaceChildren();
    for (const server of state.servers) {
      const suffix = server.requiresAuth && !server.authConfigured ? ' (token missing)' : '';
      select.append(new Option(server.label + suffix, server.id));
    }

    if (!state.servers.length) {
      setStatus('bad', 'No servers');
      showPlaceholder({
        title: 'No servers registered',
        text: 'Add one with: npm run probe -- <endpoint> --save',
      });
      return;
    }
    await selectServer(state.servers[0].id);
  } catch (err) {
    setStatus('bad', 'Failed');
    showPlaceholder({ title: 'Could not load the registry', text: String(err.message || err) });
  }
}

init();
