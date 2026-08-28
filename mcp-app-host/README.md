# MCP App Host

A front end that renders the interactive app from **any** MCP server, across **both**
widget standards, with no per-server code.

Generalised from two single-purpose front ends — one per standard — which it replaced.
Both are in git history if you want the worked examples the abstraction came from:
`git show 72b496c --stat`.

![The host rendering Peloton's widget](docs/screenshot.png)

## Running it

```bash
cd mcp-app-host
npm start                    # → http://127.0.0.1:3200
```

Node 18+. No dependencies, no build step.

```bash
npm run probe -- <endpoint>  # inspect a server before registering it
npm run metadata             # what each server discloses about itself
npm run metadata:diff        # detect changes since the last snapshot
npm test                     # 27 checks against live servers
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3200` | `0` picks a free port. |
| `HOST` | `127.0.0.1` | `0.0.0.0` listens on every interface. |
| `MCP_SERVERS_FILE` | `./servers.json` | Registry location. |

## Adding a server

```bash
npm run probe -- https://example.com/mcp --save --id example --label "Example"
```

Then restart and pick it from the dropdown. The full workflow — including the browser
checks that catch the failures a probe cannot — is in the
[`mcp-app-onboarding` skill](../.claude/skills/mcp-app-onboarding/SKILL.md).

## The problem it solves

Two incompatible widget standards are in the wild. A server declares which one it speaks
through the mime type of its UI resource:

| | `text/html;profile=mcp-app` | `text/html+skybridge` |
| --- | --- | --- |
| | **MCP Apps** (SEP-1865) | **OpenAI Apps SDK** |
| Transport | JSON-RPC over `postMessage` | Property access on `window.openai` |
| Handshake | `ui/initialize` → capabilities | None; the object must already exist |
| Data in | `ui/notifications/tool-result` | `openai.toolOutput` + `openai:set_globals` |
| Calling back | `tools/call` as JSON-RPC | `await openai.callTool(name, args)` |
| Sizing | App notifies `size-changed` | Host measures the document |
| Widget URI | `tool._meta.ui.resourceUri` | `tool._meta["openai/outputTemplate"]` |
| Theme | Live context update | Read once at boot — needs a remount |

Everything downstream follows from detecting that one mime type: which host
implementation runs, whether a shim is injected, and how the CSP is built.

## How it is put together

```
servers.json ──▶ registry.js ──▶ one MCP client per server
                                       │
tool._meta ────▶ detect.js ────────────┤   resolve widget URI + standard
                                       ▼
                                  server/index.js
                     /api/servers            the registry
                     /api/servers/:id/info   tools, schemas, resolved widgets
                     /api/servers/:id/widget the app, wrapped (+ shim if skybridge)
                     /api/servers/:id/tools/call
                                       │
                                       ▼
                     public/main.js ── builds the argument form from inputSchema
                                       │
                     public/hosts/index.js ── picks an adapter by standard
                            ├── mcp-apps-host.js   (JSON-RPC over postMessage)
                            └── skybridge-host.js  (+ skybridge-shim.js, injected)
```

Three things make it generic rather than two special cases welded together:

**Widget resolution is metadata-driven.** `templateForTool()` reads whichever `_meta` key
the server uses, and — importantly — treats a *missing* key as information rather than as
ignorance. A tool that participates in a template convention but names no widget has
opted out, and is reported `declared-none`. The sole-UI-resource guess survives only for
servers that use no per-tool convention at all, and is reported as `sole-ui-resource` so
you can see it was a guess.

That distinction is not academic. Viator's `get_experience_details` carries `_meta.ui`
with a `visibility` but no `resourceUri`: it renders nothing itself and exists for an
already-rendered app to call when someone opens a detail view. Falling back handed it the
search-results widget, which then received a `{experienceDetails}` payload where it
expects `{experiences: [...]}` — and because it sorted first alphabetically, it was what
the UI defaulted to.

**The argument form is generated from `inputSchema`.** Required fields first, optional
ones behind a disclosure, types mapped to real widgets — dates get a date picker, enums
get a select, objects and arrays get validated JSON. A server nobody has seen before is
immediately usable.

**The adapters expose one vocabulary** — `mount`, `deliver`, `setTheme`, `destroy` —
without pretending the standards are the same underneath. `remountForTheme` is the honest
seam: skybridge widgets read the theme once at boot, so the page must reload them, and the
adapter says so rather than hiding it.

## Security posture

- **The widget frame never gets `allow-same-origin`.** Skybridge widgets need a
  same-origin `window.openai`, so the server injects a shim into the widget document
  instead of loosening the sandbox. The widget gets its bridge; the frame stays closed.
- **`'self'` is never emitted in a widget CSP** — the frame runs on an opaque origin,
  where it would match nothing.
- **Tool calls are checked against the server's own `tools/list`,** so the proxy cannot be
  used to reach a tool the server does not advertise, or a tool on a different server.
- **Only `ui://` URIs are fetchable** through the widget route, and traversal is rejected.
- **Tokens live in the environment, never in `servers.json`** — an entry names the
  variable via `authEnv`.

## Registered servers

| id | Standard | Notes |
| --- | --- | --- |
| `viator` | mcp-apps | Tours and activities. No auth. |
| `peloton` | skybridge | Class search. Only `search` is `noauth`. |
| `deepwiki` | *none* | Data-only, included as the graceful-degradation case: the UI marks its tools "data only" rather than failing. |

## Signing in (OAuth)

Servers that guard their tools get a **Connect** button. The flow is fully
self-service — no credentials are arranged in advance:

```
/.well-known/oauth-protected-resource   which authorization server guards this endpoint
/.well-known/oauth-authorization-server  its endpoints and capabilities
POST {registration_endpoint}             register this host, get a client_id (RFC 7591)
{authorization_endpoint}                 you approve in your browser (PKCE S256)
POST {token_endpoint}                    code + verifier -> access token
```

That is what makes it work for a server nobody has registered with before. Peloton's
member tools are the live case: `search` is `noauth`, but `schedule` writes to your
calendar and needs your account.

**Tokens live in a sealed cookie, never on the server.** Two reasons, both load-bearing:
serverless has no durable filesystem, so a server-side store would silently lose tokens
on every cold start; and this deployment is public, so a shared store would mean whoever
authorized last was lending their Peloton account to every other visitor. A cookie is
per-browser by construction. It is AES-256-GCM sealed, so it is opaque and tamper-evident
to the browser holding it, and `state` plus PKCE guard the callback.

Set `MCP_HOST_SECRET` to keep sessions alive across restarts and across serverless
instances. Without it a random key is generated per process, and existing cookies simply
stop opening — safe, but you will be asked to sign in again.

A server that needs a bearer you already hold can still use `authEnv` instead. That is a
deployment-wide credential rather than a per-viewer one, and the UI says so rather than
implying you signed in.

Worth knowing: **not every server reports "sign in" as HTTP 401.** Peloton's `schedule`
returns it as a tool error inside a 200, so the offer to authorize keys off the message
as well as the status code.

## Chained tools

Many servers pair a list tool with ones that take an identifier *from* that list.
Peloton's `fetch`, `create-training-plan` and `schedule` all want an `index` "from search
results", and the indices are sparse — `2, 22, 38, 50…` — so a bare number box is
unusable: there is no way to know what is valid without having run a search and read the
output.

So the last result's rows are kept, and any argument whose name matches a column in those
rows is offered as a real choice, labelled from the row (`8 — 30 min Yoga Flow · Aditi
Shah`). Array-of-object arguments start from a working example built off the schema and
filled with indices that actually exist, rather than an empty `[]` and a guess at the item
shape. Field descriptions are shown in full, since for these tools the description *is*
the answer to "what goes here".

The rule needs no knowledge of any particular server — only that the previous result had
rows carrying a field of the same name.

## Previewing an app with no data

**Preview empty** mounts the widget and brings its bridge up, then sends no tool result.
No tool is called at all.

An app's empty state is a real design surface that is otherwise invisible from here —
every other path through this host arrives with data already in hand. It is also the only
way to see a widget belonging to a tool you cannot call, whether because it needs
credentials or because its arguments are awkward to synthesise.

What you get is the app's own rendering of "nothing yet", not a mock: Peloton draws its
skeleton cards, Viator its loading placeholder. Nothing fabricated is ever handed to a
widget. The button is disabled for tools that declare no widget, since there is nothing
to render empty.

## Detecting server changes

```bash
npm run metadata              # report every registered server
npm run metadata -- viator    # just one
npm run metadata -- --save    # write docs/snapshots/<id>.json
npm run metadata:diff         # compare to the snapshots, exit 1 on drift
```

**There is no "last updated" to read.** MCP has no such field, and none of these servers
publish a version endpoint, an `ETag`, or a `Last-Modified`; their `serverInfo.version` is
pinned at `1.0.0` and never moves. Hashing what they serve is the only honest way to know
something changed, which is what `--diff` does — on a schedule, it becomes the change feed
they do not provide.

It earns its keep. It caught Viator shipping a 54-byte change to its app bundle
mid-session (a loading skeleton added to each card's price), entirely unannounced.

The report also surfaces things the docs do not state: each server's real protocol
ceiling, which older versions it honours versus silently clamps, whether the transport is
POST-only, and which optional methods exist.

## Deploying

Live at **https://mcp-app-host-five.vercel.app** — a stable alias that follows whatever is
current in production, unlike the hash-suffixed URL each individual deploy gets.

```bash
npx vercel link      # first time only
npm run deploy       # vercel deploy --prod
```

The project is a Node HTTP server (`server/app.js`'s `handle(req, res)`), not something
Vercel's zero-config Node runtime can run directly — a serverless platform has no port to
bind. `server/index.js` stays the local-dev entry point (`http.createServer` + listen);
`api/index.js` wraps the identical handler for Vercel, and `vercel.json` rewrites every
`/api/*` request to it. Static assets (`index.html`, `main.js`, `hosts/*.js`) are served
straight from the CDN via `outputDirectory: "public"` and never touch the function.

Two failures only showed up against the real platform, not `vercel build` run locally:

**`[...path].js` looked right and wasn't.** That catch-all bracket syntax is a Next.js
routing convention, not a general Vercel one. Outside a framework, Vercel's plain Node
builder compiled it to a single-segment regex (`^/api/([^/]+)$`) — `/api/servers` matched,
`/api/servers/viator/info` 404'd at the platform, before ever reaching this code. Confirmed
by reading the generated `.vercel/output/config.json` route table directly rather than
guessing from the symptom. Fixed with an explicit `rewrites` rule in `vercel.json` pointing
every `/api/*` request at one plainly-named function (`api/index.js`), the pattern that
actually works for a non-framework project.

**`servers.json` and the skybridge shim need `require()` on a literal path, not
`includeFiles`.** `vercel.json`'s `functions.includeFiles` looked like it worked —
`.vc-config.json` recorded a `filePathMap` entry for it — but the file never actually
landed in the local build output, and `require.resolve()` on a *computed* path (even one
built from an already-literal constant) had the same silent gap. What reliably survives
Vercel's file tracer is `require('../servers.json')` with the string written directly in
the call, no intermediate variable. This was caught by inspecting the built function's
filesystem (`find .vercel/output/functions/... -name servers.json`), not by trusting a
green build.

Everything else — CSP correctness, shim injection, live tool calls returning real Viator
and Peloton data, the graceful data-only case for DeepWiki — was verified against the
actual deployed URL with `curl`, not assumed from a passing local build.

**Security note on going public:** deployment protection (Vercel's SSO wall) was
deliberately turned off so the link works without a Vercel login. That's safe here
specifically because nothing in `servers.json` sets `authEnv` — there is no bearer token
for a public caller to reach through this proxy. Registering a server that does set
`authEnv` on a public deployment would expose that token's calls to anyone with the URL;
put such a server behind deployment protection, or don't deploy it publicly at all.

## Known limits

- **Two standards only.** A third mime type returns HTTP 415 naming what it saw, rather
  than guessing. That is a real gap to fill, not something to paper over.
- **No OAuth flow.** `authEnv` sends a bearer you already have. Servers needing an
  interactive authorization code grant (Peloton's member tools, for example) will 401 —
  the UI reports that rather than hanging.
- **No model.** When an app sends a follow-up prompt, there is nothing to reason about it;
  the host re-runs the tool with that text in the first string argument, which is the most
  useful approximation available.
