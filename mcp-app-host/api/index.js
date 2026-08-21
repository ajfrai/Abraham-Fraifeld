'use strict';

/**
 * Vercel serverless entry point.
 *
 * Every request under /api/* lands here, via the `rewrites` rule in
 * vercel.json — not via the `[...path]` filesystem catch-all convention,
 * which turned out to be a Next.js-only feature. Outside a framework,
 * Vercel's plain Node function router only supports single dynamic segments
 * (`[id].js` → `[^/]+`); `api/[...path].js` silently compiled to that same
 * single-segment regex, so a route like `/api/servers/viator/info` 404'd at
 * the platform before ever reaching this code. An explicit rewrite to one
 * plainly-named function is the pattern that actually works.
 *
 * The handler re-derives the route from `req.url` on every call, so nothing
 * here needs to inspect anything Vercel parsed out of the path.
 */

const { handleWithFallback } = require('../server/app');

module.exports = (req, res) => handleWithFallback(req, res);
