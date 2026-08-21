/**
 * Host side of the skybridge (OpenAI Apps SDK) contract.
 *
 * The counterpart to `skybridge-shim.js`, which runs inside the widget frame.
 * The shim owns the `window.openai` object the widget reads; this class owns
 * the data that goes into it and answers the calls the widget makes.
 *
 * Compared with the MCP Apps protocol, there is no handshake to negotiate and
 * no JSON-RPC: the host simply pushes globals and the widget re-reads them.
 * The only sequencing rule is that the widget must exist before it is fed, so
 * everything waits on the shim's `ready` notification.
 */

export class SkybridgeHost {
  /**
   * @param {HTMLIFrameElement} iframe
   * @param {object} handlers
   * @param {(name:string, args:object) => Promise<object>} [handlers.callTool]
   * @param {(mode:string) => string} [handlers.onDisplayMode] Returns the mode applied.
   * @param {(prompt:string) => void} [handlers.onFollowUp]
   * @param {(state:object) => void} [handlers.onWidgetState]
   * @param {(height:number) => void} [handlers.onHeight]
   * @param {(url:string) => void} [handlers.onOpenExternal]
   * @param {(entry:object) => void} [handlers.onLog]
   */
  constructor(iframe, handlers = {}) {
    this.iframe = iframe;
    this.handlers = handlers;
    this.ready = false;
    this._readyResolvers = [];

    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  destroy() {
    window.removeEventListener('message', this._onMessage);
    this._readyResolvers = [];
  }

  whenReady() {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this._readyResolvers.push(resolve));
  }

  _log(direction, payload, note) {
    this.handlers.onLog?.({ direction, payload, note, at: Date.now() });
  }

  _post(message) {
    const target = this.iframe.contentWindow;
    if (!target) return;
    // The frame is sandboxed onto an opaque origin, so '*' is the only usable
    // target. Inbound messages are authenticated by `event.source` instead.
    target.postMessage({ source: 'mcp-host', ...message }, '*');
  }

  /* ---------------------------------------------------------------- *
   * Inbound
   * ---------------------------------------------------------------- */

  async _onMessage(event) {
    if (!this.iframe.contentWindow || event.source !== this.iframe.contentWindow) return;
    const msg = event.data;
    if (!msg || msg.source !== 'mcp-widget') return;

    if (msg.type === 'notify') {
      // Height chatter would drown the inspector; everything else is logged.
      if (msg.method !== 'heightChanged') this._log('widget→host', msg);
      this._handleNotify(msg);
      return;
    }

    if (msg.type === 'request') {
      this._log('widget→host', msg);
      try {
        const result = await this._handleRequest(msg.method, msg.params || {});
        const reply = { type: 'response', id: msg.id, result };
        this._log('host→widget', reply);
        this._post(reply);
      } catch (err) {
        const reply = { type: 'response', id: msg.id, error: String(err.message || err) };
        this._log('host→widget', reply);
        this._post(reply);
      }
    }
  }

  _handleNotify(msg) {
    switch (msg.method) {
      case 'ready':
        this.ready = true;
        this._readyResolvers.splice(0).forEach((resolve) => resolve());
        return;
      case 'heightChanged':
        this.handlers.onHeight?.(msg.params?.height);
        return;
      case 'setWidgetState':
        this.handlers.onWidgetState?.(msg.params?.state);
        return;
      case 'sendFollowUpMessage':
        this.handlers.onFollowUp?.(msg.params?.prompt);
        return;
      case 'openExternal':
        this.handlers.onOpenExternal?.(msg.params?.href || msg.params?.url);
        return;
      default:
        return;
    }
  }

  async _handleRequest(method, params) {
    switch (method) {
      case 'callTool': {
        if (!this.handlers.callTool) throw new Error('Host cannot proxy tool calls');
        return this.handlers.callTool(params.name, params.arguments || {});
      }
      case 'requestDisplayMode': {
        const requested = params.mode || 'inline';
        const applied = this.handlers.onDisplayMode?.(requested) ?? requested;
        // Report the applied mode back through globals too, so a widget that
        // reads `openai.displayMode` rather than the return value stays right.
        this.setGlobals({ displayMode: applied });
        return { mode: applied };
      }
      default:
        throw new Error(`Host has no handler for "${method}"`);
    }
  }

  /* ---------------------------------------------------------------- *
   * Outbound
   * ---------------------------------------------------------------- */

  /** Pushes a partial globals update; the widget re-reads and re-renders. */
  setGlobals(globals) {
    const message = { type: 'set_globals', globals };
    this._log('host→widget', message, `set_globals ${Object.keys(globals).join(', ')}`);
    this._post(message);
  }

  /**
   * Delivers a tool result. `toolOutput` is what the widget renders, so it is
   * pushed as a global alongside the raw response.
   */
  sendToolResponse(toolResponse, toolOutput, toolInput) {
    const message = {
      type: 'tool_response',
      toolResponse,
      globals: { toolOutput, ...(toolInput !== undefined ? { toolInput } : {}) },
    };
    this._log('host→widget', message, 'tool_response');
    this._post(message);
  }
}
