import { McpAppHost } from './mcp-apps-host.js';
import { SkybridgeHost } from './skybridge-host.js';

/**
 * One interface over two incompatible widget standards.
 *
 * The two host classes have genuinely different shapes — one runs a JSON-RPC
 * handshake and is told the frame's height, the other injects globals and
 * measures the frame itself. Rather than force them into a shared base class,
 * this adapter gives the page a single vocabulary:
 *
 *   mount()      bring the widget up and wait until it can receive data
 *   deliver()    hand it a tool result to render
 *   setTheme()   push a theme change
 *   destroy()
 *
 * `remountForTheme` is the honest part of the abstraction: skybridge widgets
 * read the theme once at boot, so the only way to restyle them is to reload.
 * The page needs to know that, so the adapter reports it rather than hiding it.
 */

export const STANDARDS = { MCP_APPS: 'mcp-apps', SKYBRIDGE: 'skybridge' };

class McpAppsAdapter {
  static remountForTheme = false;

  constructor(iframe, handlers) {
    this.host = new McpAppHost(iframe, {
      getHostContext: handlers.getContext,
      onLog: handlers.onLog,
      callServerTool: (params) => handlers.callTool(params.name, params.arguments || {}),
      onOpenLink: handlers.onOpenLink,
      onDisplayMode: handlers.onDisplayMode,
      onSizeChanged: ({ height }) => handlers.onHeight?.(height),
      onMessage: handlers.onFollowUp,
      onTeardown: handlers.onTeardown,
    });
  }

  whenReady() {
    return this.host.whenReady();
  }

  /**
   * Nothing to do: this standard carries the host context in the reply to the
   * app's own `ui/initialize`, so it has already arrived by the time the app
   * reports itself initialized.
   */
  pushContext() {}

  deliver({ result, args }) {
    // Order is part of the contract: the arguments, then the result.
    this.host.sendToolInput(args);
    this.host.sendToolResult(result);
  }

  setTheme(theme) {
    this.host.sendContextChanged({ theme });
  }

  setDisplayMode(mode) {
    this.host.sendContextChanged({ displayMode: mode });
  }

  destroy() {
    this.host.destroy();
  }
}

class SkybridgeAdapter {
  // Their bootstrap reads openai.theme synchronously, before any message.
  static remountForTheme = true;

  constructor(iframe, handlers) {
    this.handlers = handlers;
    this.host = new SkybridgeHost(iframe, {
      onLog: handlers.onLog,
      callTool: (name, args) => handlers.callTool(name, args),
      onDisplayMode: handlers.onDisplayMode,
      onHeight: handlers.onHeight,
      onFollowUp: handlers.onFollowUp,
      onWidgetState: handlers.onWidgetState,
      onOpenExternal: handlers.onOpenLink,
    });
  }

  whenReady() {
    return this.host.whenReady();
  }

  /**
   * Theme, locale and sizing arrive as globals rather than through a
   * handshake, so they must be pushed explicitly — including when no tool
   * result follows, which is how an empty widget still renders styled.
   */
  pushContext() {
    this.host.setGlobals(this.handlers.getContext());
  }

  deliver({ result, args }) {
    this.host.sendToolResponse(result, result.structuredContent ?? null, args);
  }

  setTheme(theme) {
    this.host.setGlobals({ theme });
  }

  setDisplayMode(mode) {
    this.host.setGlobals({ displayMode: mode });
  }

  destroy() {
    this.host.destroy();
  }
}

const ADAPTERS = {
  [STANDARDS.MCP_APPS]: McpAppsAdapter,
  [STANDARDS.SKYBRIDGE]: SkybridgeAdapter,
};

export function adapterFor(standard) {
  const Adapter = ADAPTERS[standard];
  if (!Adapter) {
    throw new Error(`No host implementation for standard "${standard}"`);
  }
  return Adapter;
}

export function supportedStandards() {
  return Object.keys(ADAPTERS);
}
