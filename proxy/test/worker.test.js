import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../worker.js";
import { upstreamUrl } from "../lib.js";

const P = "https://proxy.example/repos/ApphiveSL/status_page";

class FakeCache {
  constructor() { this.m = new Map(); }
  async match(req) { const r = this.m.get(req.url); return r ? r.clone() : undefined; }
  async put(req, res) { this.m.set(req.url, res.clone()); }
  expireFresh() { for (const k of [...this.m.keys()]) if (k.endsWith("__v=fresh")) this.m.delete(k); }
}

function gh(status, body, extra = {}) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } }); };
  f.calls = calls;
  return f;
}

const env = { GITHUB_TOKEN: "t0k", ALLOWED_ORIGINS: "https://status.apphivesl.com" };
const get = (path, origin = "https://status.apphivesl.com") => new Request(P + path, { headers: { origin } });

test("allows only this repo's issues, comments, commits and contents", () => {
  assert.ok(upstreamUrl(P + "/issues?state=open&labels=status"));
  assert.ok(upstreamUrl(P + "/issues/12/comments"));
  assert.ok(upstreamUrl(P + "/commits?path=history/sms-api.yml"));
  assert.ok(upstreamUrl(P + "/contents/history/summary.json"));
  assert.equal(upstreamUrl("https://proxy.example/repos/ApphiveSL/other/issues"), null);
  assert.equal(upstreamUrl("https://proxy.example/user"), null);
  assert.equal(upstreamUrl(P + "/pulls"), null);
  assert.equal(upstreamUrl(P + "/issues?access_token=x"), null);
  assert.equal(upstreamUrl(P + "/contents/../../secrets"), null);
});

test("query order does not create separate cache entries", () => {
  assert.equal(upstreamUrl(P + "/issues?state=open&labels=status"), upstreamUrl(P + "/issues?labels=status&state=open"));
});

test("many visitors share one GitHub call per minute, sent with our token", async () => {
  const cache = new FakeCache(), f = gh(200, [{ number: 1 }]);
  for (let i = 0; i < 25; i++) {
    const r = await worker.fetch(get("/issues?state=open&labels=status"), env, null, { fetch: f, cache });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [{ number: 1 }]);
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.headers.authorization, "Bearer t0k");
});

test("when GitHub fails, visitors get the last good copy, not an error (the rate-limit page)", async () => {
  const cache = new FakeCache();
  await worker.fetch(get("/issues?labels=status"), env, null, { fetch: gh(200, [{ number: 7 }]), cache });
  cache.expireFresh();
  const r = await worker.fetch(get("/issues?labels=status"), env, null, { fetch: gh(403, { message: "API rate limit exceeded" }), cache });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-proxy-cache"), "stale");
  assert.deepEqual(await r.json(), [{ number: 7 }]);
});

test("GitHub down with nothing cached gives 503 that is never cached", async () => {
  const r = await worker.fetch(get("/issues?labels=status"), env, null, { fetch: async () => { throw new Error("down"); }, cache: new FakeCache() });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("refuses writes and unknown paths, and never calls GitHub for them", async () => {
  const f = gh(200, {});
  const post = new Request(P + "/issues", { method: "POST", body: "{}" });
  assert.equal((await worker.fetch(post, env, null, { fetch: f, cache: new FakeCache() })).status, 405);
  assert.equal((await worker.fetch(get("/../../user"), env, null, { fetch: f, cache: new FakeCache() })).status, 404);
  assert.equal(f.calls.length, 0);
});

test("CORS answers only for the status site", async () => {
  const pre = await worker.fetch(new Request(P + "/issues", { method: "OPTIONS", headers: { origin: "https://status.apphivesl.com" } }), env, null, { cache: new FakeCache() });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://status.apphivesl.com");
  const r = await worker.fetch(get("/issues", "https://evil.example"), env, null, { fetch: gh(200, []), cache: new FakeCache() });
  assert.equal(r.headers.get("access-control-allow-origin"), "https://status.apphivesl.com");
});

test("pagination links point back at the proxy, not at GitHub", async () => {
  const f = gh(200, [], { link: '<https://api.github.com/repos/ApphiveSL/status_page/issues?page=2>; rel="next"' });
  const r = await worker.fetch(get("/issues?labels=status"), env, null, { fetch: f, cache: new FakeCache() });
  assert.equal(r.headers.get("link"), '<https://proxy.example/repos/ApphiveSL/status_page/issues?page=2>; rel="next"');
});
