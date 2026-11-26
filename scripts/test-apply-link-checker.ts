/**
 * Offline tests for scripts/lib/apply-link-checker.ts and the check-apply-links CLI.
 * No real DNS, no network, no database: fetch and lookup are fakes; addresses are
 * RFC 5737 documentation IPs; hostnames use the reserved .example TLD.
 *
 *   npx tsx scripts/test-apply-link-checker.ts
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  checkJobs,
  createHostScheduler,
  exitCodeFor,
  sampleJobs,
  EXIT,
  type ApplyJob,
  type CheckerDeps,
  type FetchFn,
} from "./lib/apply-link-checker";

const PUBLIC = "203.0.113.10"; // TEST-NET-3, not in any private range
const job = (id: string, url: string): ApplyJob => ({ id, title: `Role ${id}`, company: "Acme", apply_url: url });
const lookup = async (host: string) => {
  const table: Record<string, string> = { "evil-rebind.example": "10.0.0.5", "metadata.example": "169.254.169.254" };
  return [{ address: table[host] ?? PUBLIC, family: 4 }];
};

/** Virtual clock: sleep() resolves only when run() advances time to it. */
function virtualClock() {
  let t = 0;
  const timers: { at: number; fire: () => void }[] = [];
  return {
    now: () => t,
    sleep: (ms: number) => new Promise<void>((fire) => timers.push({ at: t + ms, fire })),
    async run<T>(p: Promise<T>): Promise<T> {
      let done = false;
      p.then(() => (done = true), () => (done = true));
      while (!done) {
        await new Promise((r) => setImmediate(r));
        if (done || timers.length === 0) continue;
        timers.sort((a, b) => a.at - b.at);
        const next = timers.shift()!;
        t = Math.max(t, next.at);
        next.fire();
      }
      return p;
    },
  };
}

/** Fake fetch from a "METHOD url" -> status/headers table; tracks body cancels and calls. */
function fakeFetch(table: Record<string, { status: number; headers?: Record<string, string> } | "hang" | "reset">) {
  const calls: { method: string; url: string }[] = [];
  let bodies = 0;
  let cancelled = 0;
  const fetch: FetchFn = (url, init) => {
    calls.push({ method: String(init.method), url });
    const r = table[`${init.method} ${url}`];
    if (r === "hang") {
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    }
    if (r === "reset" || !r) return Promise.reject(new TypeError("fetch failed: ECONNRESET"));
    bodies++;
    const body = new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(1024)); // endless page: must never be read to completion
      },
      cancel() {
        cancelled++;
      },
    });
    return Promise.resolve(new Response(body, { status: r.status, headers: r.headers }));
  };
  return { fetch, calls, stats: () => ({ bodies, cancelled }) };
}

const realTimeDeps = (fetch: FetchFn, extra: Partial<CheckerDeps> = {}): CheckerDeps => ({
  fetch,
  lookup,
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  hostGapMs: 0,
  ...extra,
});

const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test("seed unused: no seed means first n in universe order", () => {
  const u = Array.from({ length: 10 }, (_, i) => i);
  assert.deepEqual(sampleJobs(u, 4, null), [0, 1, 2, 3]);
});

test("seed used: same seed same sample, different seed different sample, bounded by universe", () => {
  const u = Array.from({ length: 50 }, (_, i) => i);
  const a = sampleJobs(u, 10, 42);
  assert.deepEqual(sampleJobs(u, 10, 42), a);
  assert.notDeepEqual(sampleJobs(u, 10, 43), a);
  assert.notDeepEqual(a, u.slice(0, 10));
  assert.equal(new Set(a).size, 10);
  assert.equal(sampleJobs(u, 500, 7).length, 50);
  assert.deepEqual(u, Array.from({ length: 50 }, (_, i) => i), "universe not mutated");
});

test("scheduler: concurrent same-host starts are spaced, other hosts are not delayed", async () => {
  const clock = virtualClock();
  const schedule = createHostScheduler(1000, clock.now, clock.sleep);
  const starts: Record<string, number[]> = { a: [], b: [] };
  const go = (h: "a" | "b") => schedule(`${h}.example`).then(() => starts[h].push(clock.now()));
  await clock.run(Promise.all([go("a"), go("a"), go("a"), go("b"), go("b")]));
  assert.deepEqual(starts.a, [0, 1000, 2000]);
  assert.deepEqual(starts.b, [0, 1000]);
});

test("checkJobs: 5 parallel jobs on one host start >=1000ms apart; a second host runs alongside", async () => {
  const clock = virtualClock();
  const table: Record<string, { status: number }> = {};
  const jobs: ApplyJob[] = [];
  for (let i = 0; i < 4; i++) {
    table[`HEAD https://same.example/${i}`] = { status: 200 };
    jobs.push(job(`s${i}`, `https://same.example/${i}`));
  }
  table["HEAD https://other.example/x"] = { status: 200 };
  jobs.push(job("o", "https://other.example/x"));
  const f = fakeFetch(table);
  const results = await clock.run(checkJobs(jobs, { fetch: f.fetch, lookup, now: clock.now, sleep: clock.sleep, concurrency: 5 }));
  const same = results.filter((r) => r.id.startsWith("s")).map((r) => r.hops[0].startedAt).sort((a, b) => a - b);
  assert.deepEqual(same, [0, 1000, 2000, 3000]);
  assert.equal(results.find((r) => r.id === "o")!.hops[0].startedAt, 0);
});

test("HEAD 405 -> GET fallback and redirect hops are each scheduled; evidence keeps original and final", async () => {
  const clock = virtualClock();
  const f = fakeFetch({
    "HEAD https://jobs.example/a": { status: 405 },
    "GET https://jobs.example/a": { status: 302, headers: { location: "/b" } },
    "GET https://jobs.example/b": { status: 200 },
  });
  const [r] = await clock.run(checkJobs([job("1", "https://jobs.example/a")], { fetch: f.fetch, lookup, now: clock.now, sleep: clock.sleep }));
  assert.equal(r.category, "reachable");
  assert.equal(r.originalUrl, "https://jobs.example/a");
  assert.equal(r.finalUrl, "https://jobs.example/b");
  assert.equal(r.finalStatus, 200);
  assert.deepEqual(r.hops.map((h) => [h.method, h.status, h.startedAt]), [["HEAD", 405, 0], ["GET", 302, 1000], ["GET", 200, 2000]]);
  assert.deepEqual(f.stats(), { bodies: 3, cancelled: 3 }, "every body cancelled, endless GET page never downloaded");
});

test("redirect loop and redirect limit are failed findings, bounded request count", async () => {
  const loop = fakeFetch({
    "HEAD https://a.example/x": { status: 301, headers: { location: "https://b.example/y" } },
    "HEAD https://b.example/y": { status: 301, headers: { location: "https://a.example/x" } },
  });
  const [r] = await checkJobs([job("1", "https://a.example/x")], realTimeDeps(loop.fetch));
  assert.equal(r.category, "redirect_failed");
  assert.match(r.error!, /loop/);
  assert.equal(loop.calls.length, 2);

  const chain: Record<string, { status: number; headers: Record<string, string> }> = {};
  for (let i = 0; i < 20; i++) chain[`HEAD https://c.example/${i}`] = { status: 302, headers: { location: `/${i + 1}` } };
  const long = fakeFetch(chain);
  const [r2] = await checkJobs([job("2", "https://c.example/0")], realTimeDeps(long.fetch, { maxRedirects: 3 }));
  assert.equal(r2.category, "redirect_failed");
  assert.equal(long.calls.length, 4, "initial + 3 redirects, then stop");
});

test("unsafe URLs are refused before any request, including on a redirect hop", async () => {
  const bad = [
    "ftp://jobs.example/a",
    "javascript:alert(1)",
    "not a url",
    "https://user:pw@jobs.example/a",
    "https://jobs.example:8443/a",
    "http://localhost/a",
    "http://127.0.0.1/a",
    "http://[::1]/a",
    "http://2130706433/a",
    "http://169.254.169.254/latest",
    "https://evil-rebind.example/a",
    "https://metadata.example/a",
    "http://intranet/a",
  ];
  const f = fakeFetch({ "HEAD https://jobs.example/r": { status: 302, headers: { location: "http://10.1.2.3/admin" } } });
  const results = await checkJobs([...bad.map((u, i) => job(`b${i}`, u)), job("r", "https://jobs.example/r")], realTimeDeps(f.fetch));
  for (const r of results) assert.equal(r.category, "unsafe_url", `${r.originalUrl}: ${r.category} ${r.error}`);
  assert.deepEqual(f.calls, [{ method: "HEAD", url: "https://jobs.example/r" }], "only the safe first hop was requested");
  assert.equal(results.at(-1)!.finalStatus, 302);
});

test("timeout is classified and its timer cleared; transport error is distinct", async () => {
  const timersBefore = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  const f = fakeFetch({ "HEAD https://slow.example/a": "hang", "HEAD https://down.example/a": "reset" });
  const results = await checkJobs([job("t", "https://slow.example/a"), job("e", "https://down.example/a")], realTimeDeps(f.fetch, { timeoutMs: 30 }));
  assert.equal(results[0].category, "timeout");
  assert.match(results[0].error!, /timed out after 30ms/);
  assert.equal(results[1].category, "transport_error");
  assert.match(results[1].error!, /ECONNRESET/);
  assert.equal(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length, timersBefore, "no leaked timers");
});

test("status classes: 2xx reachable, 404/410 missing, 429/403/challenge indeterminate, 5xx indeterminate; bodies cancelled", async () => {
  const f = fakeFetch({
    "HEAD https://s.example/ok": { status: 200 },
    "HEAD https://s.example/gone": { status: 404 },
    "HEAD https://s.example/gone2": { status: 410 },
    "HEAD https://s.example/slow-down": { status: 429, headers: { "retry-after": "60" } },
    "HEAD https://s.example/forbidden": { status: 403 },
    "HEAD https://s.example/cf": { status: 503, headers: { "cf-mitigated": "challenge" } },
    "HEAD https://s.example/boom": { status: 500 },
    "HEAD https://s.example/teapot": { status: 418 },
  });
  const urls = ["ok", "gone", "gone2", "slow-down", "forbidden", "cf", "boom", "teapot"];
  const results = await checkJobs(urls.map((u) => job(u, `https://s.example/${u}`)), realTimeDeps(f.fetch));
  assert.deepEqual(
    results.map((r) => r.category),
    ["reachable", "missing", "missing", "blocked_or_challenge", "blocked_or_challenge", "blocked_or_challenge", "server_error", "client_error"],
  );
  assert.equal(f.calls.length, urls.length, "no retries, including after 429");
  assert.deepEqual(f.stats(), { bodies: 8, cancelled: 8 });
});

test("exit contract: reachable-only 0, any failure 1, indeterminate-only 2, nothing 3", () => {
  const r = (category: Parameters<typeof exitCodeFor>[0][number]["category"]) =>
    ({ category }) as Parameters<typeof exitCodeFor>[0][number];
  assert.equal(exitCodeFor([r("reachable")]), EXIT.ALL_REACHABLE);
  assert.equal(exitCodeFor([r("reachable"), r("missing"), r("timeout")]), EXIT.FAILED_FINDINGS);
  assert.equal(exitCodeFor([r("reachable"), r("blocked_or_challenge")]), EXIT.INDETERMINATE);
  assert.equal(exitCodeFor([]), EXIT.NOT_RUN);
});


// ---- review #818 regressions: IPv6 policy, challenge priority, bounded DNS ----
const dnsErr = (code: string) => Object.assign(new Error(`getaddrinfo ${code} host`), { code });
const v6Lookup = (table: Record<string, string[]>) => async (host: string) =>
  (table[host] ?? [PUBLIC]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));

test("IPv6: loopback/unspecified spellings, multicast, ULA, link-local, mapped, NAT64, 6to4, Teredo, doc are refused with zero fetches", async () => {
  const denied = [
    "0:0:0:0:0:0:0:1", "::1", "::", "0::0", "ff02::1", "fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::7f00:1", "64:ff9b::10.0.0.1", "64:ff9b:1::1",
    "2002:7f00:1::", "2002:cb00:710a::1", "2001:0:4136:e378::1", "2001:db8::1", "3fff::1",
  ];
  const f = fakeFetch({});
  const jobs = denied.map((_, i) => job(`v${i}`, `https://ssrf${i}.example/a`));
  const table = Object.fromEntries(denied.map((a, i) => [`ssrf${i}.example`, [a]]));
  const results = await checkJobs(jobs, realTimeDeps(f.fetch, { lookup: v6Lookup(table) }));
  results.forEach((r, i) => assert.equal(r.category, "unsafe_url", `${denied[i]} -> ${r.category} ${r.error ?? ""}`));
  assert.equal(f.calls.length, 0);
});

test("IPv6: bracketed literal URLs are refused; a public AAAA is allowed and pinned", async () => {
  const f = fakeFetch({ "HEAD https://v6.example/a": { status: 200 } });
  const results = await checkJobs(
    [job("l1", "http://[0:0:0:0:0:0:0:1]/a"), job("l2", "http://[2002:7f00:1::]/a"), job("l3", "http://[ff02::1]/a"), job("ok", "https://v6.example/a")],
    realTimeDeps(f.fetch, { lookup: v6Lookup({ "v6.example": ["2a00:1450:4001::1"] }) }),
  );
  assert.deepEqual(results.map((r) => r.category), ["unsafe_url", "unsafe_url", "unsafe_url", "reachable"]);
  assert.deepEqual(f.calls, [{ method: "HEAD", url: "https://v6.example/a" }]);
});

test("DNS: one denied answer among several public ones refuses the host", async () => {
  const f = fakeFetch({});
  const [r] = await checkJobs([job("m", "https://mixed.example/a")], realTimeDeps(f.fetch, { lookup: v6Lookup({ "mixed.example": [PUBLIC, "2a00:1450:4001::1", "fd00::1"] }) }));
  assert.equal(r.category, "unsafe_url");
  assert.equal(f.calls.length, 0);
});

test("IPv6: redirect to a host resolving to multicast/NAT64-loopback is refused after the first hop", async () => {
  const f = fakeFetch({
    "HEAD https://jobs.example/r1": { status: 302, headers: { location: "https://mc.example/x" } },
    "HEAD https://jobs.example/r2": { status: 301, headers: { location: "https://nat64.example/x" } },
  });
  const results = await checkJobs(
    [job("r1", "https://jobs.example/r1"), job("r2", "https://jobs.example/r2")],
    realTimeDeps(f.fetch, { lookup: v6Lookup({ "mc.example": ["ff02::1"], "nat64.example": ["64:ff9b::7f00:1"] }) }),
  );
  assert.deepEqual(results.map((r) => r.category), ["unsafe_url", "unsafe_url"]);
  assert.equal(f.calls.length, 2, "only the two safe first hops");
});

test("challenge header wins over HTTP status: 200+challenge and 503+challenge indeterminate, plain 200 reachable", async () => {
  const f = fakeFetch({
    "HEAD https://c.example/a": { status: 200, headers: { "cf-mitigated": "challenge" } },
    "HEAD https://c.example/b": { status: 503, headers: { "cf-mitigated": "challenge" } },
    "HEAD https://c.example/c": { status: 200 },
  });
  const results = await checkJobs(["a", "b", "c"].map((x) => job(x, `https://c.example/${x}`)), realTimeDeps(f.fetch));
  assert.deepEqual(results.map((r) => r.category), ["blocked_or_challenge", "blocked_or_challenge", "reachable"]);
  assert.equal(exitCodeFor([results[0]]), EXIT.INDETERMINATE);
});

test("DNS failures are transport_error (indeterminate), not unsafe_url; private answers stay unsafe_url", async () => {
  const f = fakeFetch({});
  const lk = async (host: string) => {
    if (host === "nx.example") throw dnsErr("ENOTFOUND");
    if (host === "again.example") throw dnsErr("EAI_AGAIN");
    return [{ address: "192.168.1.10", family: 4 }];
  };
  const results = await checkJobs(
    [job("nx", "https://nx.example/a"), job("ag", "https://again.example/a"), job("pv", "https://private.example/a")],
    realTimeDeps(f.fetch, { lookup: lk }),
  );
  assert.deepEqual(results.map((r) => r.category), ["transport_error", "transport_error", "unsafe_url"]);
  assert.match(results[0].error!, /DNS.*ENOTFOUND/);
  assert.match(results[1].error!, /DNS.*EAI_AGAIN/);
  assert.equal(exitCodeFor(results.slice(0, 2)), EXIT.INDETERMINATE, "transient DNS-only evidence is exit 2, not 1");
  assert.equal(f.calls.length, 0);
});

test("DNS: a hung lookup times out within the hop deadline; a late rejection is swallowed; timers cleared", async () => {
  const timersBefore = process.getActiveResourcesInfo().filter((x) => x === "Timeout").length;
  let unhandled = 0;
  const onUnhandled = () => unhandled++;
  process.on("unhandledRejection", onUnhandled);
  const lk = (host: string) =>
    host === "hang.example"
      ? new Promise<never>(() => {})
      : new Promise<never>((_, reject) => setTimeout(() => reject(dnsErr("ESERVFAIL")), 60));
  const f = fakeFetch({});
  const t0 = Date.now();
  const results = await checkJobs([job("h", "https://hang.example/a"), job("late", "https://late.example/a")], realTimeDeps(f.fetch, { lookup: lk, timeoutMs: 10 }));
  assert.ok(Date.now() - t0 < 100, `took ${Date.now() - t0}ms`);
  assert.deepEqual(results.map((r) => r.category), ["timeout", "timeout"]);
  assert.match(results[0].error!, /DNS lookup timed out after 10ms/);
  assert.equal(process.getActiveResourcesInfo().filter((x) => x === "Timeout").length, timersBefore + 1, "only the fake resolver's own late timer remains");
  await new Promise((r) => setTimeout(r, 100));
  process.off("unhandledRejection", onUnhandled);
  assert.equal(unhandled, 0, "late rejection did not escape");
  assert.equal(f.calls.length, 0);
});

// ---- CLI, spawned in an empty temp dir with no Supabase env, so --db cannot reach anything ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "applylink-"));
const cli = path.resolve(__dirname, "check-apply-links.ts");
const tsxCli = require.resolve("tsx/cli");
function runCli(args: string[]) {
  const env = { ...process.env };
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  delete env.SUPABASE_SERVICE_ROLE_KEY;
  delete env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const out = spawnSync(process.execPath, [tsxCli, cli, ...args], { cwd: tmp, env, encoding: "utf8", timeout: 60_000 });
  return { code: out.status, text: out.stdout + out.stderr };
}
function fixture(name: string, body: unknown) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, JSON.stringify(body));
  return p;
}

test("CLI: missing config, no mode and empty fixture exit 3 and never print a reachable verdict", () => {
  for (const args of [["--db"], [], ["--fixture", fixture("empty.json", { jobs: [] })], ["--fixture", path.join(tmp, "nope.json")]]) {
    const { code, text } = runCli(args);
    assert.equal(code, EXIT.NOT_RUN, `${args.join(" ")}: ${text}`);
    assert.match(text, /NOT RUN/);
    assert.doesNotMatch(text, /ALL REACHABLE/);
  }
});

test("CLI fixture mode: all-2xx exits 0 with transport-only wording; a 404 exits 1; a 429 alone exits 2", () => {
  const dns = { "jobs.example": PUBLIC };
  const ok = runCli(["--fixture", fixture("ok.json", { dns, jobs: [job("1", "https://jobs.example/a")], responses: { "HEAD https://jobs.example/a": { status: 200 } } })]);
  assert.equal(ok.code, EXIT.ALL_REACHABLE, ok.text);
  assert.match(ok.text, /ALL REACHABLE \(HTTP 2xx transport only; job openness and company match not verified\)/);
  assert.match(ok.text, /unseeded, not random/);

  const jobs = [job("1", "https://jobs.example/a"), job("2", "https://jobs.example/gone")];
  const responses = { "HEAD https://jobs.example/a": { status: 200 }, "HEAD https://jobs.example/gone": { status: 404 } };
  const bad = runCli(["--fixture", fixture("bad.json", { dns, jobs, responses }), "--seed", "7"]);
  assert.equal(bad.code, EXIT.FAILED_FINDINGS, bad.text);
  assert.match(bad.text, /seed=7/);
  assert.match(bad.text, /\[failed\/missing\]/);

  const limited = runCli(["--fixture", fixture("429.json", { dns, jobs: [job("1", "https://jobs.example/a")], responses: { "HEAD https://jobs.example/a": { status: 429 } } })]);
  assert.equal(limited.code, EXIT.INDETERMINATE, limited.text);
  assert.match(limited.text, /INDETERMINATE/);
});

test("CLI fixture mode: a 200 challenge alone exits 2; DNS ENOTFOUND alone exits 2, not 1", () => {
  const ch = runCli(["--fixture", fixture("ch.json", { dns: { "jobs.example": PUBLIC }, jobs: [job("1", "https://jobs.example/a")], responses: { "HEAD https://jobs.example/a": { status: 200, headers: { "cf-mitigated": "challenge" } } } })]);
  assert.equal(ch.code, EXIT.INDETERMINATE, ch.text);
  assert.doesNotMatch(ch.text, /ALL REACHABLE/);
  const nx = runCli(["--fixture", fixture("nx.json", { dns: {}, jobs: [job("1", "https://nowhere.example/a")], responses: {} })]);
  assert.equal(nx.code, EXIT.INDETERMINATE, nx.text);
  assert.match(nx.text, /\[indeterminate\/transport_error\]/);
});

process.exitCode = 1; // fail closed: a test that never settles drains the loop and must not exit 0
(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name}\n     ${(e as Error).stack}`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
