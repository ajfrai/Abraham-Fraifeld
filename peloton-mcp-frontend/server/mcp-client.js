'use strict';

/**
 * Minimal MCP client for the Peloton Experiences server, no dependencies.
 *
 * Peloton answers `resources/read` with plain JSON but `tools/call` with
 * `text/event-stream`, so both encodings are parsed. It also negotiates *down*
 * to protocol 2024-11-05 regardless of what is offered, and the negotiated
 * version is echoed on later requests as the spec requires.
 */

const DEFAULT_ENDPOINT = 'https://mcp.onepeloton.com/mcp';
const PREFERRED_PROTOCOL = '2025-06-18';

class McpError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

/**
 * Extracts the JSON-RPC payload from an SSE body. Keep-alives and unrelated
 * events may precede ours, so every `data:` block is parsed and the one
 * matching `id` wins.
 */
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

class PelotonMcpClient {
  constructor({ endpoint = DEFAULT_ENDPOINT, timeoutMs = 45000, headers = {} } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.extraHeaders = headers;
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
        throw new McpError(`Peloton MCP server did not respond within ${this.timeoutMs}ms`);
      }
      throw new McpError(`Could not reach the Peloton MCP server: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }

    const assigned = res.headers.get('mcp-session-id');
    if (assigned) this.sessionId = assigned;

    if (!expectResponse) {
      if (!res.ok && res.status !== 202) {
        throw new McpError(`Peloton MCP server returned HTTP ${res.status}`);
      }
      return null;
    }

    const text = await res.text();
    if (!res.ok) {
      // 401 is the meaningful one: the tool needed an account and we have none.
      throw new McpError(
        res.status === 401
          ? 'Peloton MCP server requires an authenticated member session for this call'
          : `Peloton MCP server returned HTTP ${res.status}: ${text.slice(0, 300)}`,
        { code: res.status },
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
        throw new McpError(`Peloton MCP server returned a non-JSON body: ${text.slice(0, 300)}`);
      }
    }

    if (!message) throw new McpError('Peloton MCP server returned an empty response');
    if (message.error) {
      throw new McpError(message.error.message || 'Peloton MCP server reported an error', {
        code: message.error.code,
        data: message.error.data,
      });
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
            clientInfo: { name: 'peloton-mcp-frontend', version: '1.0.0' },
          },
        });
        // Peloton negotiates down to 2024-11-05; honour whatever it picked.
        if (result?.protocolVersion) this.protocolVersion = result.protocolVersion;
        this.serverInfo = result;
        await this._post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          { expectResponse: false },
        ).catch(() => null); // Optional; the server tolerates its absence.
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
    return this.request('resources/list', {});
  }

  readResource(uri) {
    return this.request('resources/read', { uri });
  }

  callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
}

module.exports = { PelotonMcpClient, McpError, DEFAULT_ENDPOINT, PREFERRED_PROTOCOL };
