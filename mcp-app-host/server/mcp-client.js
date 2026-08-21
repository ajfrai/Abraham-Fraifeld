'use strict';

/**
 * Generic MCP client over Streamable HTTP, with no dependencies.
 *
 * Written against the quirks of real servers rather than the happy path:
 * responses arrive as either `application/json` or `text/event-stream`,
 * protocol versions are negotiated in both directions, and some servers
 * answer unsupported methods with a non-JSON-RPC error object.
 */

const PREFERRED_PROTOCOL = '2025-06-18';

class McpError extends Error {
  constructor(message, { code, data, status } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
    this.status = status;
  }
}

function parseEventStream(body, id) {
  const messages = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n');
    if (!data) continue;
    try {
      messages.push(JSON.parse(data));
    } catch {
      /* comment or keep-alive */
    }
  }
  return messages.find((m) => m && m.id === id) || messages[messages.length - 1];
}

class McpClient {
  /**
   * @param {object} options
   * @param {string} options.endpoint
   * @param {object} [options.headers] Static headers, e.g. an Authorization bearer.
   * @param {number} [options.timeoutMs]
   */
  constructor({ endpoint, headers = {}, timeoutMs = 45000 } = {}) {
    if (!endpoint) throw new Error('McpClient requires an endpoint');
    this.endpoint = endpoint;
    this.extraHeaders = headers;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.protocolVersion = PREFERRED_PROTOCOL;
    this.serverInfo = null;
    this._nextId = 0;
    this._ready = null;
  }

  _id() {
    this._nextId += 1;
    return this._nextId;
  }

  async _post(payload, { expectResponse = true } = {}) {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion,
      ...this.extraHeaders,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new McpError(`${this.endpoint} did not respond within ${this.timeoutMs}ms`);
      }
      throw new McpError(`Could not reach ${this.endpoint}: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const assigned = res.headers.get('mcp-session-id');
    if (assigned) this.sessionId = assigned;

    if (!expectResponse) {
      if (!res.ok && res.status !== 202) {
        throw new McpError(`Server returned HTTP ${res.status}`, { status: res.status });
      }
      return null;
    }

    const text = await res.text();
    if (!res.ok) {
      throw new McpError(
        res.status === 401
          ? 'This call needs an authenticated session; the server returned 401'
          : `Server returned HTTP ${res.status}: ${text.slice(0, 300)}`,
        { status: res.status },
      );
    }

    const contentType = res.headers.get('content-type') || '';
    let message;
    if (contentType.includes('text/event-stream')) {
      message = parseEventStream(text, payload.id);
    } else {
      try {
        message = JSON.parse(text);
      } catch {
        throw new McpError(`Server returned a non-JSON body: ${text.slice(0, 300)}`);
      }
    }

    if (!message) throw new McpError('Server returned an empty response');
    if (message.error) {
      throw new McpError(message.error.message || 'Server reported an error', {
        code: message.error.code,
        data: message.error.data,
      });
    }
    // Some servers answer unsupported methods with {"jsonRpcError":null,
    // "message":"..."} — neither result nor error. Surface it as an error
    // rather than returning undefined to the caller.
    if (message.result === undefined) {
      throw new McpError(message.message || 'Server returned a malformed JSON-RPC response');
    }
    return message.result;
  }

  async ready() {
    if (!this._ready) {
      this._ready = (async () => {
        const result = await this._post({
          jsonrpc: '2.0',
          id: this._id(),
          method: 'initialize',
          params: {
            protocolVersion: PREFERRED_PROTOCOL,
            capabilities: {},
            clientInfo: { name: 'mcp-app-host', version: '1.0.0' },
          },
        });
        // Honour whatever the server negotiated, in either direction.
        if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
        this.serverInfo = result;
        await this._post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { expectResponse: false },
        ).catch(() => null);
        return result;
      })().catch((err) => {
        this._ready = null;
        throw err;
      });
    }
    return this._ready;
  }

  async request(method, params) {
    await this.ready();
    return this._post({ jsonrpc: '2.0', id: this._id(), method, params });
  }

  listTools() {
    return this.request('tools/list', {});
  }

  listResources() {
    return this.request('resources/list', {}).catch(() => ({ resources: [] }));
  }

  readResource(uri) {
    return this.request('resources/read', { uri });
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
}

module.exports = { McpClient, McpError, PREFERRED_PROTOCOL };
