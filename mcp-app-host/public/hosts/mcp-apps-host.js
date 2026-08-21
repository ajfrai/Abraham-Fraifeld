/**
 * Host side of the MCP Apps protocol (SEP-1865).
 *
 * An MCP App is an HTML resource that runs in a sandboxed iframe and talks
 * JSON-RPC to whoever embedded it, over `postMessage`. The app is the client;
 * this module is the server it calls. The exchange goes:
 *
 *   app  → host   ui/initialize                     (handshake)
 *   host → app    { protocolVersion, hostInfo, hostCapabilities, hostContext }
 *   app  → host   ui/notifications/initialized
 *   host → app    ui/notifications/tool-input       (what the tool was called with)
 *   host → app    ui/notifications/tool-result      (what it returned — the render payload)
 *
 * After that the app drives itself: `tools/call` to fetch experience details,
 * `ui/open-link` to click out to Viator, `ui/request-display-mode` to go
 * fullscreen, `ui/notifications/size-changed` as its content grows.
 *
 * Everything is transport-agnostic here — the embedder supplies `callServerTool`
 * and friends, so this file never knows the Viator endpoint exists.
 */

const PROTOCOL_VERSION = '2025-11-21';

export class McpAppHost {
  /**
   * @param {HTMLIFrameElement} iframe Sandboxed frame the app runs in.
   * @param {object} handlers
   * @param {(params:{name:string,arguments:object}) => Promise<object>} handlers.callServerTool
   * @param {(params:object) => Promise<object>} [handlers.readServerResource]
   * @param {(params:object) => Promise<object>} [handlers.listServerResources]
   * @param {(url:string) => void} [handlers.onOpenLink]
   * @param {(mode:string) => string} [handlers.onDisplayMode] Returns the mode actually applied.
   * @param {(size:{width?:number,height?:number}) => void} [handlers.onSizeChanged]
   * @param {(text:string) => void} [handlers.onMessage] App asked to send a user message.
   * @param {() => void} [handlers.onTeardown]
   * @param {(entry:object) => void} [handlers.onLog] Every frame, for the inspector.
   * @param {() => object} handlers.getHostContext
   */
  constructor(iframe, handlers = {}) {
    this.iframe = iframe;
    this.handlers = handlers;
    this.appInfo = null;
    this.appCapabilities = null;
    this.initialized = false;
    this._nextId = 0;
    this._pending = new Map();
    this._readyResolvers = [];

    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  destroy() {
    window.removeEventListener('message', this._onMessage);
    for (const { reject } of this._pending.values()) {
      reject(new Error('Host was torn down'));
    }
    this._pending.clear();
    this._readyResolvers = [];
  }

  /** Resolves once the app has sent `ui/notifications/initialized`. */
  whenReady() {
    if (this.initialized) return Promise.resolve();
    return new Promise((resolve) => this._readyResolvers.push(resolve));
  }

  _log(direction, payload, note) {
    if (this.handlers.onLog) {
      this.handlers.onLog({ direction, payload, note, at: Date.now() });
    }
  }

  _post(message) {
    const target = this.iframe.contentWindow;
    if (!target) return;
    // The frame is sandboxed without `allow-same-origin`, so its origin is
    // opaque and '*' is the only usable target origin. Inbound messages are
    // authenticated by comparing `event.source` instead.
    target.postMessage(message, '*');
  }

  notify(method, params) {
    const message = { jsonrpc: '2.0', method, params };
    this._log('host→app', message);
    this._post(message);
  }

  /* ---------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------- */

  _onMessage(event) {
    if (!this.iframe.contentWindow || event.source !== this.iframe.contentWindow) return;
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;

    // A response to something the host asked the app.
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      this._log('app→host', message);
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'App returned an error'));
      else pending.resolve(message.result);
      return;
    }

    if (!message.method) return;
    this._log('app→host', message);

    if (message.id === undefined) {
      this._handleNotification(message).catch((err) => {
        console.warn(`[host] notification ${message.method} failed:`, err);
      });
      return;
    }

    this._handleRequest(message).then(
      (result) => this._reply(message.id, { result }),
      (err) => this._reply(message.id, { error: { code: -32603, message: String(err.message || err) } }),
    );
  }

  _reply(id, payload) {
    const message = { jsonrpc: '2.0', id, ...payload };
    this._log('host→app', message);
    this._post(message);
  }

  async _handleNotification(message) {
    const { method, params } = message;
    switch (method) {
      case 'ui/notifications/initialized':
        this.initialized = true;
        this._readyResolvers.splice(0).forEach((resolve) => resolve());
        return;
      case 'ui/notifications/size-changed':
        this.handlers.onSizeChanged?.(params || {});
        return;
      case 'ui/notifications/request-teardown':
        this.handlers.onTeardown?.();
        return;
      default:
        // Unknown notifications are ignored by design — the protocol is
        // versioned and apps may emit things this host does not model.
        return;
    }
  }

  async _handleRequest(message) {
    const { method, params } = message;
    switch (method) {
      case 'ui/initialize': {
        this.appInfo = params?.appInfo || null;
        this.appCapabilities = params?.appCapabilities || null;
        return {
          // Echo the app's version when it offers one: this host implements the
          // shape both drafts share, so agreeing with the app is the safe move.
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          hostInfo: { name: 'mcp-app-host', version: '1.0.0' },
          hostCapabilities: {
            openLinks: {},
            serverTools: {},
            serverResources: {},
            logging: {},
            message: {},
            updateModelContext: {},
          },
          hostContext: this.handlers.getHostContext(),
        };
      }

      case 'tools/call': {
        if (!this.handlers.callServerTool) throw new Error('Host cannot proxy tool calls');
        return this.handlers.callServerTool(params || {});
      }

      case 'resources/read':
        if (!this.handlers.readServerResource) throw new Error('Host cannot read resources');
        return this.handlers.readServerResource(params || {});

      case 'resources/list':
        if (!this.handlers.listServerResources) throw new Error('Host cannot list resources');
        return this.handlers.listServerResources(params || {});

      case 'ui/open-link': {
        const url = params?.url;
        try {
          this.handlers.onOpenLink?.(url);
          return {};
        } catch (err) {
          return { isError: true, message: String(err.message || err) };
        }
      }

      case 'ui/request-display-mode': {
        const requested = params?.mode || 'inline';
        const applied = this.handlers.onDisplayMode?.(requested) ?? requested;
        // The context must reflect reality, or the app will keep re-requesting.
        this.notify('ui/notifications/host-context-changed', { displayMode: applied });
        return { mode: applied };
      }

      case 'ui/message': {
        const blocks = params?.content || [];
        const text = blocks
          .filter((b) => b && b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        this.handlers.onMessage?.(text);
        return {};
      }

      case 'ui/update-model-context':
        // No model in this front end; the inspector log is where it surfaces.
        return {};

      case 'ui/download-file':
        return { isError: true, message: 'Downloads are not supported by this host' };

      case 'ping':
        return {};

      default:
        throw new Error(`Host has no handler for "${method}"`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Outbound convenience
   * ---------------------------------------------------------------- */

  /** Tells the app which arguments produced the result it is about to receive. */
  sendToolInput(args) {
    this.notify('ui/notifications/tool-input', { arguments: args || {} });
  }

  /** Delivers the tool result — this is what the app actually renders. */
  sendToolResult(result) {
    this.notify('ui/notifications/tool-result', {
      content: result.content || [],
      structuredContent: result.structuredContent,
      isError: Boolean(result.isError),
    });
  }

  /** Pushes a partial context update (theme change, resize, …). */
  sendContextChanged(patch) {
    this.notify('ui/notifications/host-context-changed', patch);
  }
}

export { PROTOCOL_VERSION };
