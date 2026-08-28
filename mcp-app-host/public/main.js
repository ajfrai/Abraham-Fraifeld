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
  lastRows: [],       // rows from the most recent result, for chained tools
  lastRowsTool: null,
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
    // The server tells us where to send the user when a tool needs consent.
    err.authUrl = body.authUrl || null;
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

/** A transient message for things that happened on another page load. */
function showBanner(text, kind = 'ok') {
  document.getElementById('link-toast')?.remove();
  const toast = document.createElement('div');
  toast.id = 'link-toast';
  toast.className = `toast toast-${kind}`;

  const label = document.createElement('span');
  label.textContent = text;
  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'toast-close';
  dismiss.setAttribute('aria-label', 'Dismiss');
  dismiss.textContent = '×';
  dismiss.addEventListener('click', () => toast.remove());

  toast.append(label, dismiss);
  document.body.append(toast);
  setTimeout(() => toast.remove(), 8000);
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

/* ------------------------------------------------------------------ *
 * Carrying results forward
 *
 * Many servers chain their tools: one returns a list, the rest take an
 * identifier "from the search results". Peloton's `fetch`, `create-training-
 * plan` and `schedule` all want an `index`, and the indices are sparse
 * (2, 22, 38, …) — unguessable, and useless to present as a bare number box.
 *
 * So the last result's rows are kept, and any argument whose name matches a
 * column in those rows is offered as a real choice. That rule is generic: it
 * needs no knowledge of Peloton, only that the previous result had rows with a
 * field of the same name.
 * ------------------------------------------------------------------ */

/** Finds the first array of objects in a result — the "rows" of most payloads. */
function rowsFromResult(result) {
  const structured = result?.structuredContent;
  if (!structured || typeof structured !== 'object') return [];
  for (const value of Object.values(structured)) {
    if (Array.isArray(value) && value.length && typeof value[0] === 'object' && value[0] !== null) {
      return value;
    }
  }
  return [];
}

/** A human label for a row, for the picker. */
function rowLabel(row, valueKey) {
  const text = row.title || row.name || row.label || row.slug || '';
  const extra = row.instructor || row.discipline || '';
  const suffix = [text, extra].filter(Boolean).join(' · ');
  return suffix ? `${row[valueKey]} — ${suffix}`.slice(0, 90) : String(row[valueKey]);
}

/** Column names available from the last result, for matching against arguments. */
function rowColumns() {
  const [first] = state.lastRows || [];
  return first ? Object.keys(first) : [];
}

/**
 * Builds a minimal valid example for a schema, borrowing real values from the
 * last result where a property name matches one of its columns.
 *
 * This is what makes `plan` and `classes` approachable: instead of an empty
 * `[]` and a guess about the item shape, the box starts with a working example
 * carrying indices that actually exist.
 */
function exampleForSchema(spec, depth = 0) {
  const rows = state.lastRows || [];

  if (spec.type === 'array') {
    const item = spec.items || {};
    // One row per available result, capped — enough to show the shape.
    const wanted = Math.max(spec.minItems || 1, 1);
    const count = Math.min(Math.max(wanted, rows.length ? 2 : 1), spec.maxItems || 3, 3);
    return Array.from({ length: count }, (_, i) => exampleForObject(item, i, depth + 1));
  }
  if (spec.type === 'object') return exampleForObject(spec, 0, depth + 1);
  return exampleScalar('value', spec, 0);
}

function exampleForObject(spec, i, depth) {
  const props = spec.properties || {};
  const required = new Set(spec.required || []);
  const columns = rowColumns();
  const out = {};

  for (const [name, sub] of Object.entries(props)) {
    // Include required fields, plus anything the previous result can fill.
    const fillable = columns.includes(name);
    if (!required.has(name) && !fillable) continue;
    if (sub.type === 'object' || sub.type === 'array') {
      if (depth < 2) out[name] = exampleForSchema(sub, depth);
      continue;
    }
    out[name] = exampleScalar(name, sub, i);
  }
  return out;
}

function exampleScalar(name, spec, i) {
  const rows = state.lastRows || [];
  const row = rows[i % Math.max(rows.length, 1)];

  // A real value from the last result always beats a synthesised one.
  if (row && row[name] !== undefined && typeof row[name] !== 'object') return row[name];

  if (spec.enum?.length) return spec.enum[0];
  if (spec.default !== undefined) return spec.default;
  if (spec.type === 'boolean') return false;
  if (spec.type === 'integer' || spec.type === 'number') return spec.minimum ?? 0;

  const day = new Date(Date.now() + (i + 1) * 864e5);
  const text = `${name} ${spec.description || ''}`.toLowerCase();
  if (/iso 8601|date-?time|starttime/.test(text) || spec.format === 'date-time') {
    day.setUTCHours(12, 0, 0, 0);
    return day.toISOString();
  }
  if (/iso date|yyyy-mm-dd|\bdate\b/.test(text) || spec.format === 'date') {
    return day.toISOString().slice(0, 10);
  }
  return '';
}

function renderToolFields() {
  const container = $('tool-fields');
  container.replaceChildren();
  if (!state.tool) return;

  const schema = state.tool.inputSchema || {};
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const defaults = state.tool.defaults || {};

  // Say where the offered values came from, so the pickers are not magic.
  const columns = rowColumns();
  const linked = Object.keys(props).filter((n) => columns.includes(n));
  const carry = $('carry-hint');
  if (state.lastRows?.length && linked.length) {
    carry.hidden = false;
    carry.textContent = `${state.lastRows.length} row(s) from ${state.lastRowsTool} — `
      + `${linked.join(', ')} ${linked.length === 1 ? 'is' : 'are'} offered below.`;
  } else if (state.lastRows?.length) {
    carry.hidden = false;
    carry.textContent = `${state.lastRows.length} row(s) from ${state.lastRowsTool} available.`;
  } else {
    carry.hidden = true;
  }

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
  label.append(caption);

  let input;
  let seeded;
  const enumValues = spec.enum || spec.items?.enum;
  // Does the previous result carry a column of this name to choose from?
  const choices = rowColumns().includes(name)
    ? state.lastRows.filter((r) => r[name] !== undefined && typeof r[name] !== 'object')
    : [];

  if (enumValues) {
    input = document.createElement('select');
    if (!isRequired) input.append(new Option('—', ''));
    for (const value of enumValues) input.append(new Option(String(value), String(value)));
  } else if (spec.type === 'boolean') {
    input = document.createElement('select');
    input.append(new Option('—', ''), new Option('true', 'true'), new Option('false', 'false'));
  } else if (choices.length) {
    // A datalist, not a select: pick a real value, or type one anyway.
    input = document.createElement('input');
    input.type = spec.type === 'integer' || spec.type === 'number' ? 'number' : 'text';
    input.setAttribute('list', `list-${name}`);
    const list = document.createElement('datalist');
    list.id = `list-${name}`;
    for (const row of choices.slice(0, 50)) {
      const option = new Option(rowLabel(row, name), String(row[name]));
      list.append(option);
    }
    label.append(list);
    seeded = String(choices[0][name]);
  } else if (spec.type === 'integer' || spec.type === 'number') {
    input = document.createElement('input');
    input.type = 'number';
    if (spec.minimum !== undefined) input.min = spec.minimum;
    if (spec.maximum !== undefined) input.max = spec.maximum;
    if (spec.type === 'integer') input.step = '1';
  } else if (spec.type === 'array' || spec.type === 'object') {
    // JSON, but never a blank box: start from a valid example built off the
    // schema and, where possible, real values from the last result.
    input = document.createElement('textarea');
    input.rows = spec.type === 'array' ? 6 : 4;
    input.placeholder = spec.type === 'array' ? '[]' : '{}';
    try {
      seeded = JSON.stringify(exampleForSchema(spec), null, 2);
    } catch { /* fall back to the empty placeholder */ }
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
  if (isRequired) input.required = true;

  // A registry default wins; otherwise the synthesised example fills the gap.
  if (defaultValue !== undefined && defaultValue !== null) {
    input.value = typeof defaultValue === 'object'
      ? JSON.stringify(defaultValue, null, 2)
      : String(defaultValue);
  } else if (seeded !== undefined) {
    input.value = seeded;
  }

  label.append(input);

  // The description is the only place a schema explains itself — Peloton's
  // "Class index from search results" is the whole answer to "what goes here".
  // Truncating it into a placeholder threw that away.
  if (spec.description) {
    const help = document.createElement('small');
    help.className = 'field-desc';
    help.textContent = spec.description;
    label.append(help);
  }

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

    // Remember the rows so a chained tool can offer their identifiers.
    const rows = rowsFromResult(result);
    if (rows.length) {
      state.lastRows = rows;
      state.lastRowsTool = state.tool.name;
    }

    if (result.isError) {
      const text = result.content?.find((c) => c.type === 'text')?.text;
      // Not every server signals "you need to sign in" with HTTP 401. Peloton's
      // `schedule` returns it as a tool error inside a 200, so the offer to
      // authorize has to key off the message as well as the status code.
      const looksLikeAuth = /auth|unauthor|token|sign[ -]?in|credential|401/i.test(text || '');
      if (looksLikeAuth && state.auth?.oauthSupported && !state.auth?.authenticated) {
        showAuthPrompt(`/api/servers/${state.server.id}/auth/login`, text);
        return;
      }
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
    if (err.status === 401 && err.authUrl) {
      showAuthPrompt(err.authUrl, err.message);
    } else {
      showPlaceholder({
        title: err.status === 401 ? 'This tool needs authentication' : 'Something went wrong',
        text: String(err.message || err),
      });
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Run tool';
  }
}

/** A 401 with a known authorize URL is an invitation, not a dead end. */
function showAuthPrompt(authUrl, message) {
  showPlaceholder({ title: 'Authorization needed', text: message || 'This tool needs your account.' });

  const inner = document.querySelector('.placeholder-inner');
  const link = document.createElement('a');
  link.className = 'primary auth-cta';
  link.href = authUrl;
  link.textContent = `Connect ${state.server.label}`;
  inner.append(link);
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

/**
 * Reflects this viewer's OAuth state for a server.
 *
 * Authorization is per-browser, held in a sealed cookie, so this is genuinely
 * "are *you* signed in" — not a property of the deployment.
 */
async function refreshAuth(id) {
  const row = $('auth-row');
  try {
    const res = await fetch(`/api/servers/${id}/auth/status`);
    const auth = await res.json();
    if (!res.ok) throw new Error(auth.error || `HTTP ${res.status}`);

    state.auth = auth;

    if (auth.staticToken) {
      // A bearer from the environment belongs to the deployment, not to you.
      row.hidden = false;
      $('auth-state').textContent = 'Using a server-configured token';
      $('auth-login').hidden = true;
      $('auth-logout').hidden = true;
      return auth;
    }
    if (!auth.oauthSupported) {
      row.hidden = true;
      return auth;
    }

    row.hidden = false;
    $('auth-login').href = `/api/servers/${id}/auth/login`;
    if (auth.authenticated) {
      const until = auth.expiresAt ? ` · expires ${new Date(auth.expiresAt).toLocaleTimeString()}` : '';
      $('auth-state').textContent = `Signed in${until}`;
      $('auth-login').hidden = true;
      $('auth-logout').hidden = false;
    } else {
      $('auth-state').textContent = 'Not signed in';
      $('auth-login').hidden = false;
      $('auth-login').textContent = 'Connect';
      $('auth-logout').hidden = true;
    }
    return auth;
  } catch {
    row.hidden = true;
    return null;
  }
}

async function selectServer(id) {
  teardown();
  state.lastMount = null;
  // Rows belong to the server they came from; carrying them across would
  // offer identifiers that mean nothing to the new one.
  state.lastRows = [];
  state.lastRowsTool = null;
  setStatus('pending', 'Connecting');
  showPlaceholder({ title: 'Connecting…', text: id, busy: true });
  refreshAuth(id);

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

  $('auth-logout').addEventListener('click', async () => {
    await fetch(`/api/servers/${state.server.id}/auth/logout`, { method: 'POST' });
    await refreshAuth(state.server.id);
    await selectServer(state.server.id);
  });

  // The OAuth callback lands back here with the outcome in the query string.
  const params = new URLSearchParams(location.search);
  const outcome = params.get('auth');
  if (outcome) {
    const server = params.get('server');
    const reason = params.get('reason');
    const message = {
      ok: `Connected to ${server}.`,
      denied: `Authorization was declined${reason ? ` (${reason})` : ''}.`,
      failed: `Authorization failed${reason ? `: ${reason}` : ''}.`,
      out: `Signed out of ${server}.`,
    }[outcome];
    if (message) showBanner(message, outcome === 'ok' || outcome === 'out' ? 'ok' : 'bad');
    // Keep the URL clean so a refresh does not replay the banner.
    history.replaceState({}, '', location.pathname);
  }
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
