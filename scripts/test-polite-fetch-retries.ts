/**
 * scripts/test-polite-fetch-retries.ts
 *
 * Deterministic offline behavioral test suite for `politeFetch` (Backend audit rows:
 * Retries / Exponential Backoff).
 *
 * Verifies at runtime (with mocked fetch, controlled virtual clock/timers, and pinned jitter RNG):
 * 1. Immediate success stops after 1 attempt with 0 retry sleeps.
 * 2. Transient failure followed by success stops retrying immediately after the succeeding attempt.
 * 3. Retryable failures (network / HTTP 5xx) stop strictly at MAX_RETRIES=2 (3 total attempts),
 *    follow jittered 1500 * 2^(attempt-1) backoff, and propagate the final error without trailing sleep.
 * 4. HTTP 429 honors `Retry-After` verbatim (un-jittered) when present, uses jittered 2000 * 2^attempt
 *    fallback backoff when absent, and propagates HTTP error 429 when retries are exhausted.
 * 5. Retry attempts still respect per-domain pacing (`throttleDomain`) across sibling subdomains
 *    and custom `rateLimitMs`.
 * 6. Subprocess negative control (`--negative-control`) exits non-zero on assertion failure.
 *
 * Run directly: npx tsx scripts/test-polite-fetch-retries.ts
 * Negative control: npx tsx scripts/test-polite-fetch-retries.ts --negative-control
 */

import assert from "assert";
import { spawnSync } from "child_process";
import {
  lastRequestByDomain,
  politeFetch,
  politeFetchJson,
  politeFetchText,
  robotsCache,
} from "./utils/polite-fetch";

if (process.argv.includes("--negative-control")) {
  console.log("Running negative control: expecting deliberate assertion failure...");
  assert.strictEqual(
    1,
    2,
    "NEGATIVE CONTROL: Deliberate assertion failure proving suite exits non-zero"
  );
  process.exit(1);
}

/**
 * Installs a deterministic virtual clock that intercepts `Date.now`, `globalThis.setTimeout`,
 * `globalThis.clearTimeout`, and `Math.random` so `sleep(ms)` and `throttleDomain` advance
 * virtual time immediately (0ms wall-clock delay) while recording every sleep duration.
 */
function withVirtualClock<T>(
  initialTimeMs: number,
  randValue: number,
  fn: (clock: { now: () => number; sleeps: number[] }) => Promise<T>
): Promise<T> {
  const realDateNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realMathRandom = Math.random;
  const realConsoleWarn = console.warn;

  let currentNow = initialTimeMs;
  const sleeps: number[] = [];

  Date.now = () => currentNow;
  Math.random = () => randValue;
  console.warn = () => {};

  // Intercept setTimeout: for finite delays <= 12,000ms (retry backoffs & domain throttle waits),
  // advance virtual clock and schedule microtask callback; for long request abort timeouts
  // (DEFAULT_TIMEOUT_MS = 15,000ms), hold inert handle unless cleared.
  let nextHandleId = 1000;
  const activeTimers = new Set<number>();

  (globalThis as any).setTimeout = (cb: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    const delay = Number(ms) || 0;
    const id = nextHandleId++;
    activeTimers.add(id);

    if (delay < 15000) {
      sleeps.push(delay);
      currentNow += delay;
      realSetTimeout(() => {
        if (activeTimers.has(id)) {
          activeTimers.delete(id);
          cb(...args);
        }
      }, 0);
    }
    return id as any;
  };

  (globalThis as any).clearTimeout = (id: any) => {
    activeTimers.delete(Number(id));
    realClearTimeout(id);
  };

  return fn({ now: () => currentNow, sleeps }).finally(() => {
    Date.now = realDateNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    Math.random = realMathRandom;
    console.warn = realConsoleWarn;
  });
}

async function runSuite() {
  console.log("================================================================================");
  console.log("       POLITE-FETCH RETRIES, BACKOFF & DOMAIN PACING BEHAVIORAL SUITE          ");
  console.log("================================================================================\n");

  const realFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: First-attempt 200 OK stops immediately (1 attempt, 0 sleeps)
    // -------------------------------------------------------------------------
    console.log("[TEST 1] First-attempt 200 OK stops immediately without retries...");
    lastRequestByDomain.clear();
    robotsCache.clear();
    await withVirtualClock(100_000, 0.5, async ({ sleeps }) => {
      const attemptTimes: number[] = [];
      globalThis.fetch = (async () => {
        attemptTimes.push(Date.now());
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      const data = await politeFetchJson<{ ok: boolean }>(
        "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
        { skipRobotsCheck: true }
      );

      assert.deepStrictEqual(data, { ok: true });
      assert.strictEqual(attemptTimes.length, 1, "Expected exactly 1 fetch attempt");
      assert.deepStrictEqual(attemptTimes, [100_000]);
      assert.deepStrictEqual(sleeps, [], "Expected 0 backoff sleeps on first-attempt success");
    });
    console.log("  -> [PASS-LOCAL] 1 fetch attempt, 0 sleeps.\n");

    // -------------------------------------------------------------------------
    // TEST 2: Transient failure on attempt 1 + success on attempt 2 stops early
    // -------------------------------------------------------------------------
    console.log("[TEST 2] Transient failure followed by 200 OK stops at attempt 2...");
    lastRequestByDomain.clear();
    await withVirtualClock(100_000, 0.5, async ({ sleeps }) => {
      const attemptTimes: number[] = [];
      globalThis.fetch = (async () => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          return new Response("gateway error", { status: 502, statusText: "Bad Gateway" });
        }
        return new Response("recovered", { status: 200 });
      }) as typeof fetch;

      const body = await politeFetchText("https://api.lever.co/v0/postings/acme", {
        skipRobotsCheck: true,
      });

      assert.strictEqual(body, "recovered");
      assert.strictEqual(attemptTimes.length, 2, "Must stop at attempt 2 after recovery");
      assert.deepStrictEqual(attemptTimes, [100_000, 101_500]);
      assert.deepStrictEqual(sleeps, [1500]);
    });
    console.log("  -> [PASS-LOCAL] Stopped at attempt 2 after single 1500ms backoff.\n");

    // -------------------------------------------------------------------------
    // TEST 3: Persistent failure stops at MAX_RETRIES=2 (3 attempts) & propagates
    // -------------------------------------------------------------------------
    console.log("[TEST 3] Persistent 503 failure stops at 3 attempts and propagates final error...");
    lastRequestByDomain.clear();
    await withVirtualClock(100_000, 0.5, async ({ sleeps, now }) => {
      const attemptTimes: number[] = [];
      globalThis.fetch = (async () => {
        attemptTimes.push(Date.now());
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }) as typeof fetch;

      let caught: Error | null = null;
      try {
        await politeFetch("https://api.lever.co/v0/postings/outage", { skipRobotsCheck: true });
      } catch (err: any) {
        caught = err;
      }

      assert.ok(caught, "Expected politeFetch to throw after exhausting retries");
      assert.ok(
        caught!.message.includes("HTTP error 503 (Service Unavailable)"),
        `Unexpected error message: ${caught!.message}`
      );
      assert.strictEqual(attemptTimes.length, 3, "Expected exactly 3 attempts (initial + 2 retries)");
      assert.deepStrictEqual(attemptTimes, [100_000, 101_500, 104_500]);
      assert.deepStrictEqual(sleeps, [1500, 3000]);
      assert.strictEqual(now(), 104_500, "Must not sleep after the final failed attempt");
    });

    // Jitter lower bound (rand=0 -> 0.8x: 1200ms, 2400ms) and upper bound (rand=0.999999999 -> 1.2x: 1800ms, 3600ms)
    lastRequestByDomain.clear();
    await withVirtualClock(100_000, 0, async ({ sleeps }) => {
      globalThis.fetch = (async () => {
        throw new Error("ECONNRESET");
      }) as typeof fetch;
      await assert.rejects(
        () => politeFetch("https://boards-api.greenhouse.io/v1/boards/a/jobs", { skipRobotsCheck: true }),
        /ECONNRESET/
      );
      assert.deepStrictEqual(sleeps, [1200, 2400]);
    });

    lastRequestByDomain.clear();
    await withVirtualClock(100_000, 0.999999999, async ({ sleeps }) => {
      globalThis.fetch = (async () => {
        throw new Error("ETIMEDOUT");
      }) as typeof fetch;
      await assert.rejects(
        () => politeFetch("https://boards-api.greenhouse.io/v1/boards/b/jobs", { skipRobotsCheck: true }),
        /ETIMEDOUT/
      );
      assert.deepStrictEqual(sleeps, [1800, 3600]);
    });
    console.log("  -> [PASS-LOCAL] Bounded at 3 attempts; base/min/max jitter waits verified.\n");

    // -------------------------------------------------------------------------
    // TEST 4: HTTP 429 Retry-After verbatim vs fallback 2000 * 2^attempt backoff
    // -------------------------------------------------------------------------
    console.log("[TEST 4] HTTP 429 Retry-After header vs fallback exponential backoff...");
    lastRequestByDomain.clear();
    // 4a. Retry-After: 6 is honored verbatim (6000ms) even when rand=0
    await withVirtualClock(100_000, 0, async ({ sleeps }) => {
      const attemptTimes: number[] = [];
      globalThis.fetch = (async () => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          return new Response("rate limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "6" },
          });
        }
        return new Response("ok-after-429", { status: 200 });
      }) as typeof fetch;

      const text = await politeFetchText("https://boards-api.greenhouse.io/v1/boards/acme/jobs", {
        skipRobotsCheck: true,
      });
      assert.strictEqual(text, "ok-after-429");
      assert.deepStrictEqual(attemptTimes, [100_000, 106_000]);
      assert.deepStrictEqual(sleeps, [6000]);
    });

    // 4b. 429 without Retry-After uses jittered 2000 * 2^attempt (4000ms, 8000ms at rand=0.5) and throws on 3rd 429
    lastRequestByDomain.clear();
    await withVirtualClock(100_000, 0.5, async ({ sleeps, now }) => {
      const attemptTimes: number[] = [];
      globalThis.fetch = (async () => {
        attemptTimes.push(Date.now());
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }) as typeof fetch;

      await assert.rejects(
        () => politeFetch("https://api.smartrecruiters.com/v1/companies/acme/postings", { skipRobotsCheck: true }),
        /HTTP error 429 \(Too Many Requests\)/
      );
      assert.strictEqual(attemptTimes.length, 3);
      assert.deepStrictEqual(attemptTimes, [100_000, 104_000, 112_000]);
      assert.deepStrictEqual(sleeps, [4000, 8000]);
      assert.strictEqual(now(), 112_000);
    });
    console.log("  -> [PASS-LOCAL] 429 Retry-After and fallback 2000*2^attempt paths verified.\n");

    // -------------------------------------------------------------------------
    // TEST 5: Retry attempts respect per-domain pacing (throttleDomain)
    // -------------------------------------------------------------------------
    console.log("[TEST 5] Retry attempts respect per-domain pacing...");
    lastRequestByDomain.clear();
    await withVirtualClock(100_000, 0.5, async ({ sleeps }) => {
      const attemptTimes: number[] = [];
      globalThis.fetch = (async () => {
        attemptTimes.push(Date.now());
        if (attemptTimes.length === 1) {
          return new Response("server err", { status: 500, statusText: "Internal Server Error" });
        }
        return new Response("ok", { status: 200 });
      }) as typeof fetch;

      // rateLimitMs = 3000ms > failure backoff (1500ms), so Attempt 2 must wait an additional 1500ms in throttleDomain
      const text = await politeFetchText("https://jobs.ashbyhq.com/api/non-user-graphql", {
        skipRobotsCheck: true,
        rateLimitMs: 3000,
      });

      assert.strictEqual(text, "ok");
      assert.deepStrictEqual(attemptTimes, [100_000, 103_000]);
      assert.deepStrictEqual(sleeps, [1500, 1500]);
    });
    console.log("  -> [PASS-LOCAL] Retry attempt waited for remaining per-domain throttle window.\n");

    // -------------------------------------------------------------------------
    // TEST 6: Subprocess Negative Control
    // -------------------------------------------------------------------------
    console.log("[TEST 6] Verifying subprocess negative control exits non-zero...");
    const neg = spawnSync(
      process.execPath,
      ["--import", "tsx", __filename, "--negative-control"],
      { encoding: "utf8" }
    );
    assert.notStrictEqual(neg.status, 0, "Negative control must exit non-zero");
    console.log("  -> [PASS-LOCAL] Negative control exited with non-zero code as expected.\n");

    console.log("================================================================================");
    console.log("ALL 6 POLITE-FETCH RETRY & BACKOFF CHECKS PASSED [PASS-LOCAL]");
    console.log("================================================================================");
  } finally {
    globalThis.fetch = realFetch;
  }
}

runSuite().catch((err) => {
  console.error("Suite failed:", err);
  process.exit(1);
});
