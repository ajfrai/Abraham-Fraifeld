---
name: mcp-app-onboarding
description: Onboard a new MCP server into mcp-app-host so its interactive app renders in the browser. Use when adding, registering, or troubleshooting an MCP server's widget/app in this repo, when someone asks whether a server "has an app" or which widget standard it speaks, or when a registered app renders blank, unstyled, wrongly sized, or with missing images.
---

# Onboarding an MCP app

`mcp-app-host/` renders interactive apps served by MCP servers. This skill adds a new
server to it and gets its app rendering correctly.

Most of the work is discovery, and most failures are quiet: the app mounts, renders
*something*, and is subtly wrong. Verify in a browser before declaring it done.

## The one thing to understand first

There are **two incompatible widget standards**. A server picks one, and it is declared
in the mime type of its UI resource:

| Mime type | Standard | Bridge |
| --- | --- | --- |
| `text/html;profile=mcp-app` | MCP Apps (SEP-1865) | JSON-RPC over `postMessage`, with a `ui/initialize` handshake |
| `text/html+skybridge` | OpenAI Apps SDK | Direct property access on an injected `window.openai` |

The host already implements both (`public/hosts/`). Onboarding never means writing a new
bridge — if a server speaks either standard, it should work with configuration alone.
If you find a *third* mime type, that is a genuine gap; say so rather than forcing it
into one of the existing adapters.

## Step 1 — Probe

```bash
cd mcp-app-host
node scripts/probe.js <endpoint>
```

Read the output for four things:

1. **`standard:`** — `mcp-apps`, `skybridge`, or `none detected`. If none, the server has
   no app to host; it is data-only and this host cannot render it. Stop and report that.
2. **Per-tool `[standard · noauth]`** — `noauth` tools work with no credentials.
   Anything else needs OAuth, and calls will 401.
3. **`renders … (via …)`** — how the widget was resolved. `tool._meta` is authoritative.
   `sole-ui-resource` is a fallback that only holds while the server has exactly one UI
   resource; note it, because adding a second would silently change behaviour.
4. **`domains seen`** — static URL references, used to seed a CSP. Treat as a starting
   point, never as complete (see Step 4).

If the probe fails at the handshake, the endpoint is wrong or unreachable. Check for a
`/.well-known/oauth-protected-resource` document, which confirms the URL is an MCP
resource server and names its auth server.

## Step 2 — Register

```bash
node scripts/probe.js <endpoint> --save --id <id> --label "<Label>"
```

For a server needing auth, add `--auth-env MY_TOKEN`. Tokens are **never** written to
`servers.json` — the entry stores the variable's name and the value is read from the
environment at startup.

Then add `defaults` for the tools you want one-click runnable. Some servers reject calls
without a session id or a concrete date, so these tokens are resolved per request:

```jsonc
"defaults": {
  "search_experiences": {
    "sessionId": "auto:uuid",       // fresh UUID
    "startDate": "auto:today+7",    // ISO date, offset in days
    "searchTerm": "food tours in Rome"
  }
}
```

## Step 3 — Run it

```bash
npm start        # then pick the server from the dropdown
```

The argument form is generated from each tool's `inputSchema`, so there is no per-server
UI to write. Open the **Inspector** to watch the bridge traffic in both directions.

## Step 4 — Verify in a browser

**This step is not optional.** Every bug worth knowing about in this repo was invisible
from the server side. Run `npm test`, then look at the app.

Check each of these:

- **Images load.** The single most common failure. A widget may rewrite image URLs at
  runtime through a proxy or CDN that never appears in the tool result — Peloton's
  results carry `s3.amazonaws.com` URLs but render through `res.cloudinary.com`. A CSP
  derived from the payload looks right and blocks every image. Add the real host to the
  registry entry's `csp.resourceDomains`.
- **No `Refused to …` in the console.** That string means your CSP is wrong. A blocked
  *network* (`ERR_CONNECTION_RESET`) is a different problem and not yours to fix.
- **The frame is sized to the content**, not stuck at the 620px default.
- **Theme works.** Toggle it. Skybridge widgets read the theme once at boot, so the host
  remounts them; MCP Apps accept a live context update.
- **Interactions work.** Click through to a detail view. Watch for a proxied `tools/call`
  in the inspector.

## Step 5 — Cover it

Add the server to the `expectations` array in `scripts/smoke.js` and `cases` in
`scripts/e2e.js`. Both are data-driven, so a new server is a few lines and the whole
sequence runs against it.

## Step 6 — Snapshot it

```bash
npm run metadata -- <id> --save
```

These servers ship changes without announcing them, and nothing in MCP reports a version
or a modification time. The snapshot in `docs/snapshots/<id>.json` fingerprints the tool
schemas and widget bundles so `npm run metadata:diff` can tell you when one moves — it
exits 1 on drift, so it works as a scheduled check.

Expect real drift: a widget bundle hash changing is normal and usually harmless. A
changed `inputSchemaHash` is not — it means the arguments you send may no longer be
valid, and the defaults in `servers.json` should be re-checked.

## Deploying

`npm run deploy` (`vercel deploy --prod`) ships the host to the stable alias in the
README. Two things about it are not obvious from a passing `vercel build`:

- **`[...path].js` is a Next.js convention, not a Vercel one.** Outside a framework, it
  silently compiles to a single-segment route — multi-segment paths 404 at the platform,
  before your code runs. Use an explicit `rewrites` rule to one plainly-named function
  instead (`api/index.js`, already set up this way).
- **`require('../servers.json')`, written literally in the call, is what survives the
  file tracer.** `includeFiles` in `vercel.json` can *report* success
  (`.vc-config.json` records the mapping) while the file is absent at runtime.
  `require.resolve()` on a path built from a variable has the same gap. Any new file a
  route needs to read at runtime needs this same literal-`require()` treatment, or it
  needs to go through `require.resolve()` written as its own literal call, the way
  `server/app.js` does for the skybridge shim.

Verify a deploy against the **real URL** with curl — routes, both widget standards, a
tool call — not just a local `vercel build`, which was observed to behave differently
from what the platform actually does with `includeFiles`.

**Before making a deployment public,** check `servers.json` for `authEnv`. A server
with one exposes that token's calls to anyone who has the URL, since there's no auth in
front of the proxy itself. Deployment protection (Vercel's SSO wall) is the guard for
that case — only turn it off for deployments where every registered server is `noauth`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| App blank, no errors | Tool result reached the host but not the app. Check for `tool_response`/`tool-result` in the inspector. |
| Images blank, `Refused to load` | CSP is missing a domain. Add it to `csp.resourceDomains`. |
| Images blank, `ERR_CONNECTION_RESET` | Network egress, not CSP. Not a code fix. |
| Frame stuck at 620px | The app never reported a height. For skybridge, the shim measures `document.body` — never `documentElement`, which is clamped to the iframe viewport and reports back whatever the host just set. |
| Theme ignored | Skybridge reads it at boot; make sure the theme reaches `/widget?theme=` and that the toggle remounts. |
| Click-out does nothing | Popups are blocked: the gesture happened in the sandboxed frame, so the top document has no user activation. The host falls back to a toast — confirm it appears. |
| 401 on a tool call | That tool is not `noauth`. Set `authEnv` and export a token. |
| `Unsupported widget type` | A third standard. Report it; do not force it into an existing adapter. |

## Rules

- **Never add `allow-same-origin`** to the widget frame. Skybridge widgets get their
  bridge from an injected shim precisely so the sandbox can stay closed.
- **Never put `'self'` in a widget CSP.** The frame is on an opaque origin, so it matches
  nothing.
- **Never write a token into `servers.json`.** Use `authEnv`.
- **Do not hardcode per-server behaviour** in `main.js`. If a server needs special
  handling, express it in `servers.json`, or in `detect.js` if it is genuinely a property
  of the standard.
