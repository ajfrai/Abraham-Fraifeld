/**
 * `window.openai` shim — injected INTO the Peloton widget document.
 *
 * Peloton's widgets are OpenAI Apps SDK ("skybridge") resources, not MCP Apps.
 * They do not speak JSON-RPC over postMessage; they expect a host object to
 * already exist on their own window:
 *
 *     const bridge = window.openai ?? window.oai ?? window.webplus;
 *     bridge.toolOutput          // the render payload
 *     bridge.widgetState         // persisted widget state
 *     bridge.theme               // 'light' | 'dark'
 *     await bridge.setWidgetState(s)
 *     await bridge.sendFollowUpMessage({ prompt })
 *     await bridge.requestDisplayMode({ mode })
 *
 * and they re-read those properties when `openai:set_globals` fires on window.
 *
 * The host page cannot assign that object across an origin boundary, so this
 * script is injected into the widget document instead and relays everything to
 * the parent over postMessage. Net effect: the widget gets the same-origin
 * bridge it expects, while the frame keeps a real sandbox.
 *
 * This must run BEFORE the widget's own bootstrap, which captures whatever
 * `window.openai` already holds.
 */
(function () {
  'use strict';

  var pending = new Map();
  var nextId = 0;

  function send(type, payload) {
    parent.postMessage(Object.assign({ source: 'peloton-widget', type: type }, payload), '*');
  }

  /** Round-trips a request to the host and resolves when it answers. */
  function call(method, params) {
    return new Promise(function (resolve, reject) {
      var id = ++nextId;
      pending.set(id, { resolve: resolve, reject: reject });
      send('request', { id: id, method: method, params: params });
      // Never leave the widget awaiting forever if the host goes away.
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error('Host did not answer ' + method));
        }
      }, 20000);
    });
  }

  var bridge = {
    // --- data the widget reads directly ---------------------------------
    toolInput: null,
    toolOutput: null,
    widgetState: null,
    theme: 'light',
    locale: 'en-US',
    displayMode: 'inline',
    maxHeight: 640,
    safeArea: { insets: { top: 0, right: 0, bottom: 0, left: 0 } },
    userAgent: { device: { type: 'desktop' }, capabilities: { hover: true, touch: false } },

    // --- methods --------------------------------------------------------
    setWidgetState: function (state) {
      bridge.widgetState = state;
      send('notify', { method: 'setWidgetState', params: { state: state } });
      return Promise.resolve();
    },

    sendFollowUpMessage: function (args) {
      send('notify', { method: 'sendFollowUpMessage', params: args || {} });
      return Promise.resolve();
    },

    requestDisplayMode: function (args) {
      return call('requestDisplayMode', args || {});
    },

    callTool: function (name, args) {
      return call('callTool', { name: name, arguments: args || {} });
    },

    openExternal: function (args) {
      send('notify', { method: 'openExternal', params: args || {} });
      return Promise.resolve();
    },
  };

  // Boot-time globals baked in by the server, so `openai.theme` is already
  // right when the widget's own bootstrap reads it a few lines below.
  var seed = window.__HOST_GLOBALS__;
  if (seed) {
    Object.keys(seed).forEach(function (key) { bridge[key] = seed[key]; });
  }

  // The widgets probe all three names.
  window.openai = bridge;
  window.oai = bridge;
  window.webplus = bridge;

  /**
   * Applies a partial globals update and tells the widget to re-read.
   * Order matters: properties first, event second.
   */
  function setGlobals(globals) {
    Object.keys(globals || {}).forEach(function (key) {
      bridge[key] = globals[key];
    });
    window.dispatchEvent(
      new CustomEvent('openai:set_globals', { detail: { globals: globals } }),
    );
  }

  window.addEventListener('message', function (event) {
    if (event.source !== parent) return;
    var msg = event.data;
    if (!msg || msg.source !== 'peloton-host') return;

    if (msg.type === 'set_globals') {
      setGlobals(msg.globals);
      return;
    }

    if (msg.type === 'tool_response') {
      if (msg.globals) {
        Object.keys(msg.globals).forEach(function (k) { bridge[k] = msg.globals[k]; });
      }
      window.dispatchEvent(
        new CustomEvent('openai:tool_response', { detail: { tool_response: msg.toolResponse } }),
      );
      // Widgets that only listen for set_globals still need to re-render.
      setGlobals(msg.globals || {});
      return;
    }

    if (msg.type === 'response') {
      var entry = pending.get(msg.id);
      if (!entry) return;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve(msg.result);
    }
  });

  /* --------------------------------------------------------------- *
   * Height reporting
   *
   * Skybridge hosts size the frame themselves rather than being told, so
   * measure the document and push it up whenever it changes.
   * --------------------------------------------------------------- */
  var lastHeight = 0;
  function reportHeight() {
    var body = document.body;
    if (!body) return;
    // Measure the body, never documentElement: the latter is clamped to the
    // iframe's own viewport, so it reports back whatever height the host just
    // set and the frame can never shrink or grow to fit its content.
    var height = Math.max(
      body.scrollHeight,
      body.offsetHeight,
      Math.ceil(body.getBoundingClientRect().height),
    );
    if (height && Math.abs(height - lastHeight) > 2) {
      lastHeight = height;
      send('notify', { method: 'heightChanged', params: { height: height } });
    }
  }

  if (typeof ResizeObserver === 'function') {
    var observer = new ResizeObserver(reportHeight);
    var attach = function () {
      if (document.body) observer.observe(document.body);
      reportHeight();
    };
    if (document.body) attach();
    else document.addEventListener('DOMContentLoaded', attach);
  }
  setInterval(reportHeight, 500);

  send('notify', { method: 'ready', params: {} });
})();
