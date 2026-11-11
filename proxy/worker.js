// Read-only, cached proxy in front of the GitHub API for status.apphivesl.com (RFC 013).
//
// Upptime's status page calls the GitHub API from each visitor's browser. Unauthenticated, GitHub
// allows 60 requests an hour per IP and every page load uses 4, so a shared office network or a
// refreshing visitor hits "Rate limit exceeded". This Worker answers those calls from one shared
// cache, refreshed with our own token at most once a minute per URL, so visitors never touch
// GitHub's per-IP limit. It only proxies GET reads of this one repo's issues, comments, commits
// and contents, with an allowlisted query string, so the token can't be used for anything else.

import { upstreamUrl, corsHeaders, FRESH_SECONDS, STALE_SECONDS, PASS_HEADERS } from "./lib.js";

function respond(body, status, headers, cors) {
  return new Response(body, { status, headers: { ...headers, ...cors } });
}

export default {
  async fetch(request, env, ctx, deps = {}) {
    const fetchImpl = deps.fetch || fetch;
    const cache = deps.cache || caches.default;
    const origins = (env.ALLOWED_ORIGINS || "https://status.apphivesl.com").split(",").map(s => s.trim());
    const cors = corsHeaders(request.headers.get("origin") || "", origins);

    if (request.method === "OPTIONS") return respond(null, 204, {}, cors);
    if (request.method !== "GET") return respond("Method not allowed", 405, { "content-type": "text/plain" }, cors);

    const proxyOrigin = new URL(request.url).origin;
    const target = upstreamUrl(request.url);
    if (!target) return respond(JSON.stringify({ message: "Not found" }), 404, { "content-type": "application/json" }, cors);

    const freshKey = new Request(target + (target.includes("?") ? "&" : "?") + "__v=fresh");
    const staleKey = new Request(target + (target.includes("?") ? "&" : "?") + "__v=stale");

    const fresh = await cache.match(freshKey);
    if (fresh) return respond(fresh.body, fresh.status, pick(fresh.headers, "hit", proxyOrigin), cors);

    let upstream;
    try {
      upstream = await fetchImpl(target, {
        headers: {
          "accept": "application/vnd.github+json",
          "user-agent": "apphive-status-proxy",
          "x-github-api-version": "2022-11-28",
          ...(env.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
        },
      });
    } catch (e) {
      upstream = null;
    }

    if (upstream && upstream.ok) {
      const body = await upstream.text();
      const headers = pick(upstream.headers, "miss", proxyOrigin);
      const store = (key, ttl) => cache.put(key, new Response(body, { status: 200, headers: { ...headers, "cache-control": `public, max-age=${ttl}` } }));
      const writes = Promise.all([store(freshKey, FRESH_SECONDS), store(staleKey, STALE_SECONDS)]);
      if (ctx && ctx.waitUntil) ctx.waitUntil(writes); else await writes;
      return respond(body, 200, headers, cors);
    }

    // GitHub failed (rate limit, outage, network): serve the last good copy rather than an error.
    const stale = await cache.match(staleKey);
    if (stale) return respond(stale.body, 200, pick(stale.headers, "stale", proxyOrigin), cors);
    const status = upstream ? upstream.status : 502;
    return respond(JSON.stringify({ message: "Status data temporarily unavailable" }), status === 404 ? 404 : 503,
      { "content-type": "application/json", "cache-control": "no-store" }, cors);
  },
};

function pick(headers, cacheState, selfOrigin) {
  const out = { "cache-control": `public, max-age=${FRESH_SECONDS}`, "x-proxy-cache": cacheState };
  for (const h of PASS_HEADERS) {
    const v = headers.get(h);
    if (v) out[h] = h === "link" ? v.replaceAll("https://api.github.com", selfOrigin) : v;
  }
  return out;
}
