'use strict';

/**
 * Loads and validates servers.json, and hands out one MCP client per server.
 *
 * Auth tokens are never stored in the registry file. An entry names an
 * environment variable instead (`"authEnv": "SOME_TOKEN"`), which is read at
 * startup and sent as a bearer.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { McpClient } = require('./mcp-client');

const REGISTRY_PATH = process.env.MCP_SERVERS_FILE || path.join(__dirname, '..', 'servers.json');

class Registry {
  constructor(file = REGISTRY_PATH) {
    this.file = file;
    this.servers = new Map();
    this.clients = new Map();
    this.load();
  }

  load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(`Could not read ${this.file}: ${err.message}`);
    }
    const entries = Array.isArray(raw.servers) ? raw.servers : [];

    this.servers.clear();
    for (const entry of entries) {
      const problem = validate(entry);
      if (problem) {
        console.warn(`[registry] skipping "${entry?.id ?? '(no id)'}": ${problem}`);
        continue;
      }
      this.servers.set(entry.id, entry);
    }
    if (!this.servers.size) console.warn(`[registry] no usable servers in ${this.file}`);
  }

  list() {
    return [...this.servers.values()].map((s) => ({
      id: s.id,
      label: s.label || s.id,
      endpoint: s.endpoint,
      notes: s.notes || null,
      requiresAuth: Boolean(s.authEnv),
      // Surfaced so the UI can warn before a call fails with 401.
      authConfigured: s.authEnv ? Boolean(process.env[s.authEnv]) : true,
    }));
  }

  get(id) {
    return this.servers.get(id) || null;
  }

  /** Clients are memoised so the initialize handshake happens once per server. */
  clientFor(id) {
    const entry = this.get(id);
    if (!entry) return null;
    if (!this.clients.has(id)) {
      const headers = {};
      if (entry.authEnv && process.env[entry.authEnv]) {
        headers.Authorization = `Bearer ${process.env[entry.authEnv]}`;
      }
      this.clients.set(id, new McpClient({ endpoint: entry.endpoint, headers }));
    }
    return this.clients.get(id);
  }

  /** Drops the cached client so the next call re-handshakes. */
  reset(id) {
    this.clients.delete(id);
  }
}

function validate(entry) {
  if (!entry || typeof entry !== 'object') return 'not an object';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.id || '')) return 'id must be lowercase alphanumeric/dashes';
  if (typeof entry.endpoint !== 'string') return 'endpoint is required';
  let url;
  try {
    url = new URL(entry.endpoint);
  } catch {
    return `endpoint is not a URL: ${entry.endpoint}`;
  }
  // Plain HTTP is allowed only for local development servers.
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    return 'endpoint must be https (http is allowed only for localhost)';
  }
  return null;
}

/**
 * Expands `auto:` placeholders in a server's default arguments.
 *
 * Several servers require a session id or a concrete future date before they
 * will answer at all, which makes a static defaults block useless. These
 * tokens are resolved per request instead.
 */
function resolveDefaults(defaults = {}) {
  const out = {};
  for (const [key, value] of Object.entries(defaults)) {
    out[key] = typeof value === 'string' && value.startsWith('auto:')
      ? resolveToken(value.slice(5))
      : value;
  }
  return out;
}

function resolveToken(token) {
  if (token === 'uuid') return crypto.randomUUID();
  const offset = token.match(/^today([+-]\d+)?$/);
  if (offset) {
    const days = offset[1] ? Number(offset[1]) : 0;
    return new Date(Date.now() + days * 864e5).toISOString().slice(0, 10);
  }
  return token;
}

module.exports = { Registry, resolveDefaults, REGISTRY_PATH };
