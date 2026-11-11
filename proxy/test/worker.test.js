import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { KEEP_EVERY_MS } from "../worker.js";
import { upstreamUrl } from "../lib.js";

const P = "https://proxy.example/repos/ApphiveSL/status_page";

class FakeKV {
  constructor() { this.m = new Map(); this.puts = 0; }
  async get(k) { return this.m.get(k) ?? null; }
  async put(k, v) { this.puts++; this.m.set(k, v); }
}

function gh(status, body, extra = {}) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extra } }); };
  f.calls = calls;
  return f;
}

const baseEnv = { GITHUB_TOKEN: "t0k", ALLOWED_ORIGINS: "https://status.apphivesl.com" };
const get = (path, origin = "https://status.apphivesl.com") => new Request(P + path, { headers: { origin } });
const clock = (t = 1_000_000) => { const c = () => c.t; c.t = t; return c; };

test("allows only this repo's issues, comments, commits and contents", () => {
  assert.ok(upstreamUrl(P + "/issues?state=open&labels=status"));
  assert.ok(upstreamUrl(P + "/issues/12/comments"));
  assert.ok(upstreamUrl(P + "/commits?path=history/sms-api.yml"));
  assert.ok(upstreamUrl(P + "/contents/history/summary.json"));
  assert.equal(upstreamUrl("https://proxy.example/repos/ApphiveSL/other/issues"), null);
  assert.equal(upstreamUrl("https://proxy.example/user"), null);
  assert.equal(upstreamUrl(P + "/pulls"), null);
  assert.equal(upstreamUrl(P + "/issues?access_token=x"), null);
});

test("query order does not create separate entries", () => {
  assert.equal(upstreamUrl(P + "/issues?state=open&labels=status"), upstreamUrl(P + "/issues?labels=status&state=open"));
});

test("many visitors share one GitHub call per minute, sent with our token", async () => {
  const memory = new Map(), now = clock(), f = gh(200, [{ number: 1 }]);
  for (let i = 0; i < 25; i++) {
    const r = await worker.fetch(get("/issues?state=open&labels=status"), baseEnv, null, { fetch: f, memory, now });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), [{ number: 1 }]);
    now.t += 1000;
  }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.headers.authorization, "Bearer t0k");
  now.t += 60_000;
  await worker.fetch(get("/issues?state=open&labels=status"), baseEnv, null, { fetch: f, memory, now });
  assert.equal(f.calls.length, 2, "refreshes after a minute");
});

test("when GitHub fails, visitors get the last good copy, not the rate-limit page", async () => {
  const memory = new Map(), now = clock();
  await worker.fetch(get("/issues?labels=status"), baseEnv, null, { fetch: gh(200, [{ number: 7 }]), memory, now });
  now.t += 5 * 60_000;
  const r = await worker.fetch(get("/issues?labels=status"), baseEnv, null, { fetch: gh(403, { message: "API rate limit exceeded" }), memory, now });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-proxy-cache"), "stale");
  assert.deepEqual(await r.json(), [{ number: 7 }]);
});

test("the KV backup survives a restart and is written at most every 10 minutes per URL", async () => {
  const kv = new FakeKV(), env = { ...baseEnv, STALE: kv }, now = clock();
  const memory = new Map();
  for (let i = 0; i < 9; i++) {           // 9 refreshes, one a minute
    await worker.fetch(get("/issues?labels=status"), env, null, { fetch: gh(200, [{ number: i }]), memory, now });
    now.t += 61_000;
  }
  assert.equal(kv.puts, 1);
  now.t += KEEP_EVERY_MS;
  await worker.fetch(get("/issues?labels=status"), env, null, { fetch: gh(200, [{ number: 99 }]), memory, now });
  assert.equal(kv.puts, 2);
  // a fresh isolate (empty memory) with GitHub failing serves the KV copy
  const r = await worker.fetch(get("/issues?labels=status"), env, null, { fetch: gh(403, {}), memory: new Map(), now });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), [{ number: 99 }]);
});

test("GitHub down with nothing kept gives 503 that is never cached", async () => {
  const r = await worker.fetch(get("/issues?labels=status"), baseEnv, null, { fetch: async () => { throw new Error("down"); }, memory: new Map() });
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

test("refuses writes and unknown paths, and never calls GitHub for them", async () => {
  const f = gh(200, {});
  const post = new Request(P + "/issues", { method: "POST", body: "{}" });
  assert.equal((await worker.fetch(post, baseEnv, null, { fetch: f, memory: new Map() })).status, 405);
  assert.equal((await worker.fetch(get("/../../user"), baseEnv, null, { fetch: f, memory: new Map() })).status, 404);
  assert.equal(f.calls.length, 0);
});

test("CORS answers only for the status site", async () => {
  const pre = await worker.fetch(new Request(P + "/issues", { method: "OPTIONS", headers: { origin: "https://status.apphivesl.com" } }), baseEnv, null, {});
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://status.apphivesl.com");
  const r = await worker.fetch(get("/issues", "https://evil.example"), baseEnv, null, { fetch: gh(200, []), memory: new Map() });
  assert.equal(r.headers.get("access-control-allow-origin"), "https://status.apphivesl.com");
});

test("pagination links point back at the proxy, not at GitHub", async () => {
  const f = gh(200, [], { link: '<https://api.github.com/repos/ApphiveSL/status_page/issues?page=2>; rel="next"' });
  const r = await worker.fetch(get("/issues?labels=status"), baseEnv, null, { fetch: f, memory: new Map() });
  assert.equal(r.headers.get("link"), '<https://proxy.example/repos/ApphiveSL/status_page/issues?page=2>; rel="next"');
});
