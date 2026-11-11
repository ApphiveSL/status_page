// Pure helpers for worker.js (the Workers runtime allows only handler exports from the main module).

export const REPO_PREFIX = "/repos/ApphiveSL/status_page/";
export const ALLOWED_RESOURCES = /^(issues(\/\d+(\/comments)?)?|commits|contents\/[A-Za-z0-9._\/-]+)$/;
export const ALLOWED_PARAMS = new Set(["state", "filter", "sort", "direction", "labels", "per_page", "page", "since", "path", "sha"]);
export const FRESH_SECONDS = 60;          // how long visitors share one copy
export const STALE_SECONDS = 24 * 3600;   // fallback copy served when GitHub fails
export const PASS_HEADERS = ["content-type", "link", "etag", "last-modified", "x-ratelimit-limit"]; // limit 5000 = our token is in use

/** The canonical GitHub API URL for a request, or null if this proxy must refuse it. */
export function upstreamUrl(requestUrl) {
  const url = new URL(requestUrl);
  if (!url.pathname.startsWith(REPO_PREFIX)) return null;
  const resource = url.pathname.slice(REPO_PREFIX.length);
  if (!ALLOWED_RESOURCES.test(resource) || resource.includes("..")) return null;
  const params = [];
  for (const [k, v] of url.searchParams) {
    if (!ALLOWED_PARAMS.has(k) || v.length > 100) return null;
    params.push([k, v]);
  }
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); // one cache entry per distinct query
  const qs = new URLSearchParams(params).toString();
  return `https://api.github.com${url.pathname}${qs ? "?" + qs : ""}`;
}

export function corsHeaders(origin, allowedOrigins) {
  const allow = allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "accept, content-type, x-github-api-version, if-none-match",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}
