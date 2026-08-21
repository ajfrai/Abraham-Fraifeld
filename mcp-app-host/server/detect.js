'use strict';

/**
 * Standard detection.
 *
 * Two mutually incompatible widget standards are in the wild, and a server
 * declares which one it speaks through the mime type of its UI resource:
 *
 *   text/html;profile=mcp-app   MCP Apps (SEP-1865). JSON-RPC over postMessage.
 *   text/html+skybridge         OpenAI Apps SDK. Property access on window.openai.
 *
 * Everything downstream — which host implementation runs, whether a shim is
 * injected, how the CSP is derived — follows from this one decision.
 */

const STANDARDS = {
  MCP_APPS: 'mcp-apps',
  SKYBRIDGE: 'skybridge',
};

function standardForMimeType(mimeType) {
  if (typeof mimeType !== 'string') return null;
  const value = mimeType.toLowerCase();
  if (value.includes('profile=mcp-app')) return STANDARDS.MCP_APPS;
  if (value.includes('+skybridge')) return STANDARDS.SKYBRIDGE;
  return null;
}

/** True for anything that looks like a renderable UI resource. */
function isUiResource(resource) {
  return Boolean(resource && standardForMimeType(resource.mimeType));
}

/**
 * Finds the UI resource a tool renders into.
 *
 * Both standards put this on the tool definition, under their own key. When
 * neither is present the server may still expose exactly one UI resource, in
 * which case there is no ambiguity to resolve.
 */
function templateForTool(tool, resources = []) {
  const meta = tool?._meta || {};

  const declared =
    meta.ui?.resourceUri ||           // MCP Apps
    meta['openai/outputTemplate'];    // OpenAI Apps SDK
  if (declared) return { uri: declared, source: 'tool._meta' };

  const uiResources = resources.filter(isUiResource);
  if (uiResources.length === 1) {
    return { uri: uiResources[0].uri, source: 'sole-ui-resource' };
  }
  return { uri: null, source: 'none' };
}

/**
 * Builds a Content-Security-Policy for a widget frame.
 *
 * MCP Apps resources declare their own domains in `_meta.ui.csp`, which is
 * authoritative and used as-is. Skybridge resources declare nothing, so the
 * server entry in the registry supplies them.
 *
 * `'self'` is never emitted: the frame is sandboxed onto an opaque origin,
 * where it would match nothing at all.
 */
function buildCsp({ resourceMeta = {}, extra = {} } = {}) {
  const declared = resourceMeta?.ui?.csp || {};
  const connect = [...(declared.connectDomains || []), ...(extra.connectDomains || [])];
  const resource = [...(declared.resourceDomains || []), ...(extra.resourceDomains || [])];
  const frame = [...(declared.frameDomains || []), ...(extra.frameDomains || [])];

  const uniq = (list) => [...new Set(list)].filter(Boolean);
  const res = uniq(resource);

  const directives = [
    "default-src 'none'",
    // Widget bundles are inline scripts and evaluate inline styles.
    "script-src 'unsafe-inline' 'unsafe-eval'",
    `style-src 'unsafe-inline' ${uniq(res.filter((d) => d.includes('fonts.googleapis'))).join(' ')}`.trim(),
    `img-src data: blob: ${res.join(' ')}`.trim(),
    `font-src data: ${res.join(' ')}`.trim(),
    `connect-src ${uniq(['data:', ...connect]).join(' ')}`.trim(),
    `media-src ${res.join(' ')}`.trim(),
    "base-uri 'none'",
    "form-action 'none'",
  ].filter((d) => !/ $/.test(d));

  if (frame.length) directives.push(`frame-src ${uniq(frame).join(' ')}`);
  return directives.join('; ');
}

/** Only `ui://` resources may be fetched through the widget route. */
function isSafeWidgetUri(uri) {
  return typeof uri === 'string' && /^ui:\/\/[\w./-]+$/.test(uri) && !uri.includes('..');
}

module.exports = {
  STANDARDS,
  standardForMimeType,
  isUiResource,
  templateForTool,
  buildCsp,
  isSafeWidgetUri,
};
