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

// Visitors share one copy per URL. The Cache API is a no-op on *.workers.dev, so the fresh copy lives
// in isolate memory; a backup copy goes to KV (binding STALE) at most every KEEP_EVERY_MS per URL, which
// keeps writes inside the free tier and survives isolate restarts for when GitHub fails.
const memory = new Map();
const MAX_ENTRIES = 200;
export const KEEP_EVERY_MS = 10 * 60 * 1000;

export default {
  async fetch(request, env, ctx, deps = {}) {
    const fetchImpl = deps.fetch || fetch;
    const mem = deps.memory || memory;
    const now = (deps.now || Date.now)();
    const kv = env.STALE;
    const origins = (env.ALLOWED_ORIGINS || "https://status.apphivesl.com").split(",").map(s => s.trim());
    const cors = corsHeaders(request.headers.get("origin") || "", origins);

    if (request.method === "OPTIONS") return respond(null, 204, {}, cors);
    if (request.method !== "GET") return respond("Method not allowed", 405, { "content-type": "text/plain" }, cors);

    const proxyOrigin = new URL(request.url).origin;
    const target = upstreamUrl(request.url);
    if (!target) return respond(JSON.stringify({ message: "Not found" }), 404, { "content-type": "application/json" }, cors);

    const cached = mem.get(target);
    if (cached && now - cached.at < FRESH_SECONDS * 1000)
      return respond(cached.body, 200, { ...cached.headers, "x-proxy-cache": "hit" }, cors);

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
      const headers = pick(upstream.headers, proxyOrigin);
      const entry = { body, headers, at: now, keptAt: cached ? cached.keptAt : 0 };
      if (kv && now - entry.keptAt >= KEEP_EVERY_MS) {
        entry.keptAt = now;
        const write = kv.put(target, JSON.stringify({ body, headers }), { expirationTtl: STALE_SECONDS });
        if (ctx && ctx.waitUntil) ctx.waitUntil(write); else await write;
      }
      if (!mem.has(target) && mem.size >= MAX_ENTRIES) mem.delete(mem.keys().next().value);
      mem.set(target, entry);
      return respond(body, 200, { ...headers, "x-proxy-cache": "miss" }, cors);
    }

    // GitHub failed (rate limit, outage, network): serve the last good copy rather than an error.
    if (cached && now - cached.at < STALE_SECONDS * 1000)
      return respond(cached.body, 200, { ...cached.headers, "x-proxy-cache": "stale" }, cors);
    if (kv) {
      const kept = await kv.get(target).catch(() => null);
      if (kept) {
        const { body, headers } = JSON.parse(kept);
        return respond(body, 200, { ...headers, "x-proxy-cache": "stale" }, cors);
      }
    }
    const status = upstream ? upstream.status : 502;
    return respond(JSON.stringify({ message: "Status data temporarily unavailable" }), status === 404 ? 404 : 503,
      { "content-type": "application/json", "cache-control": "no-store" }, cors);
  },
};

function pick(headers, selfOrigin) {
  const out = { "cache-control": `public, max-age=${FRESH_SECONDS}` };
  for (const h of PASS_HEADERS) {
    const v = headers.get(h);
    if (v) out[h] = h === "link" ? v.replaceAll("https://api.github.com", selfOrigin) : v;
  }
  return out;
}
