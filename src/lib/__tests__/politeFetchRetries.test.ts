import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastRequestByDomain,
  politeFetch,
  politeFetchJson,
  politeFetchText,
  robotsCache,
} from "../../../scripts/utils/polite-fetch";

describe("politeFetch deterministic retry, backoff, Retry-After, and domain pacing behavior", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    lastRequestByDomain.clear();
    robotsCache.clear();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("stops immediately on first-attempt 200 OK with 1 fetch call and 0 retry waits", async () => {
    const attemptTimes: number[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attemptTimes.push(Date.now());
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const data = await politeFetchJson<{ ok: boolean }>(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      { skipRobotsCheck: true }
    );

    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(attemptTimes).toEqual([100_000]);
  });

  it("stops retrying as soon as a retry attempt succeeds (attempt 2 of 3 succeeds after 1 backoff wait)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // pins withJitter(base) to exact 1.0x base
    const attemptTimes: number[] = [];

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 1) {
        return new Response("bad gateway", { status: 502, statusText: "Bad Gateway" });
      }
      return new Response("recovered-payload", { status: 200 });
    });

    const promise = politeFetchText("https://api.lever.co/v0/postings/acme", {
      skipRobotsCheck: true,
    });

    await vi.runAllTimersAsync();
    const text = await promise;

    expect(text).toBe("recovered-payload");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Attempt 1 at 100_000; failure backoff #1 = 1500 * 2^0 = 1500ms -> Attempt 2 at 101_500
    expect(attemptTimes).toEqual([100_000, 101_500]);
  });

  it("stops at default MAX_RETRIES=2 (3 total attempts) on persistent network/5xx failures and propagates the final error without trailing sleep", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const attemptTimes: number[] = [];

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attemptTimes.push(Date.now());
      return new Response("unavailable", {
        status: 503,
        statusText: "Service Unavailable",
      });
    });

    const promise = politeFetch("https://api.lever.co/v0/postings/outage", {
      skipRobotsCheck: true,
    });
    const assertion = expect(promise).rejects.toThrow(
      "HTTP error 503 (Service Unavailable) for https://api.lever.co/v0/postings/outage"
    );

    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Attempt 1: 100_000
    // Backoff 1: 1500 * 2^0 = 1500ms -> Attempt 2: 101_500
    // Backoff 2: 1500 * 2^1 = 3000ms -> Attempt 3: 104_500
    // Attempt 3 fails and throws immediately at 104_500 with no 3rd sleep
    expect(attemptTimes).toEqual([100_000, 101_500, 104_500]);
    expect(Date.now()).toBe(104_500);
  });

  it("applies deterministic ±20% jitter bounds to failure exponential backoff (1500 * 2^(attempt-1))", async () => {
    // 1. Lower bound: Math.random() = 0 -> 0.8x base (1200ms, then 2400ms)
    vi.spyOn(Math, "random").mockReturnValue(0);
    const lowTimes: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      lowTimes.push(Date.now());
      throw new Error("ECONNRESET");
    });

    const lowPromise = politeFetch("https://boards-api.greenhouse.io/v1/boards/low/jobs", {
      skipRobotsCheck: true,
    });
    const lowAssertion = expect(lowPromise).rejects.toThrow("ECONNRESET");
    await vi.runAllTimersAsync();
    await lowAssertion;

    expect(lowTimes).toEqual([100_000, 101_200, 103_600]);
    expect([lowTimes[1] - lowTimes[0], lowTimes[2] - lowTimes[1]]).toEqual([1200, 2400]);

    // 2. Upper bound: Math.random() = 0.999999999 -> 1.2x base (1800ms, then 3600ms)
    lastRequestByDomain.clear();
    vi.setSystemTime(200_000);
    vi.spyOn(Math, "random").mockReturnValue(0.999999999);
    const highTimes: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      highTimes.push(Date.now());
      throw new Error("ETIMEDOUT");
    });

    const highPromise = politeFetch("https://boards-api.greenhouse.io/v1/boards/high/jobs", {
      skipRobotsCheck: true,
    });
    const highAssertion = expect(highPromise).rejects.toThrow("ETIMEDOUT");
    await vi.runAllTimersAsync();
    await highAssertion;

    expect(highTimes).toEqual([200_000, 201_800, 205_400]);
    expect([highTimes[1] - highTimes[0], highTimes[2] - highTimes[1]]).toEqual([1800, 3600]);
  });

  it("honors explicit retries=0 (single attempt, zero retry sleeps) and retries=1 (2 attempts)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const zeroRetryTimes: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      zeroRetryTimes.push(Date.now());
      return new Response("not found", { status: 404, statusText: "Not Found" });
    });

    const p0 = politeFetch("https://api.lever.co/v0/postings/missing", {
      skipRobotsCheck: true,
      retries: 0,
    });
    const a0 = expect(p0).rejects.toThrow("HTTP error 404 (Not Found)");
    await vi.runAllTimersAsync();
    await a0;

    expect(zeroRetryTimes).toEqual([100_000]);
    expect(Date.now()).toBe(100_000);

    lastRequestByDomain.clear();
    vi.setSystemTime(300_000);
    const oneRetryTimes: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      oneRetryTimes.push(Date.now());
      return new Response("server error", { status: 500, statusText: "Internal Server Error" });
    });

    const p1 = politeFetch("https://api.lever.co/v0/postings/err", {
      skipRobotsCheck: true,
      retries: 1,
    });
    const a1 = expect(p1).rejects.toThrow("HTTP error 500 (Internal Server Error)");
    await vi.runAllTimersAsync();
    await a1;

    expect(oneRetryTimes).toEqual([300_000, 301_500]);
    expect(Date.now()).toBe(301_500);
  });

  it("honors HTTP 429 Retry-After header verbatim (un-jittered) and succeeds on the subsequent attempt", async () => {
    // Set Math.random to 0 so any accidental jitter would shrink the wait by 20%
    vi.spyOn(Math, "random").mockReturnValue(0);
    const attemptTimes: number[] = [];

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attemptTimes.push(Date.now());
      if (attemptTimes.length === 1) {
        return new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "7" },
        });
      }
      return new Response(JSON.stringify({ jobs: [1, 2] }), { status: 200 });
    });

    const promise = politeFetchJson<{ jobs: number[] }>(
      "https://boards-api.greenhouse.io/v1/boards/acme/jobs",
      { skipRobotsCheck: true }
    );

    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({ jobs: [1, 2] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Exact 7000ms wait from Retry-After: 7
    expect(attemptTimes).toEqual([100_000, 107_000]);
  });

  it("uses jittered 2000 * 2^attempt fallback backoff on HTTP 429 when Retry-After is absent, and propagates 429 when retries are exhausted", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5); // 1.0x base: 4000ms, then 8000ms
    const attemptTimes: number[] = [];

    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      attemptTimes.push(Date.now());
      return new Response("too many requests", {
        status: 429,
        statusText: "Too Many Requests",
      });
    });

    const promise = politeFetch("https://api.smartrecruiters.com/v1/companies/acme/postings", {
      skipRobotsCheck: true,
    });
    const assertion = expect(promise).rejects.toThrow(
      "HTTP error 429 (Too Many Requests) for https://api.smartrecruiters.com/v1/companies/acme/postings"
    );

    await vi.runAllTimersAsync();
    await assertion;

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Attempt 1 at 100_000 -> 429 (attempt becomes 1) -> wait 2000 * 2^1 = 4000ms
    // Attempt 2 at 104_000 -> 429 (attempt becomes 2) -> wait 2000 * 2^2 = 8000ms
    // Attempt 3 at 112_000 -> 429 (attempt === retries, falls through to !response.ok and throws)
    expect(attemptTimes).toEqual([100_000, 104_000, 112_000]);
    expect(Date.now()).toBe(112_000);
  });

  it("enforces per-domain pacing (throttleDomain) on retry attempts across sibling subdomains and custom rateLimitMs", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // Part A: Retry attempt on a.greenhouse.io is paced behind an intervening request on b.greenhouse.io
    const callLog: Array<{ host: string; attempt: number; time: number }> = [];
    let callAAttempts = 0;
    let callBAttempts = 0;

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
      const url = new URL(String(input));
      if (url.hostname === "a.greenhouse.io") {
        callAAttempts++;
        callLog.push({ host: url.hostname, attempt: callAAttempts, time: Date.now() });
        if (callAAttempts === 1) {
          return new Response("transient 503", { status: 503, statusText: "Service Unavailable" });
        }
        return new Response("ok-a", { status: 200 });
      }
      callBAttempts++;
      callLog.push({ host: url.hostname, attempt: callBAttempts, time: Date.now() });
      return new Response("ok-b", { status: 200 });
    });

    const pA = politeFetchText("https://a.greenhouse.io/v1/boards/a/jobs", {
      skipRobotsCheck: true,
    });
    const pB = politeFetchText("https://b.greenhouse.io/v1/boards/b/jobs", {
      skipRobotsCheck: true,
    });

    await vi.runAllTimersAsync();
    const [resA, resB] = await Promise.all([pA, pB]);

    expect(resA).toBe("ok-a");
    expect(resB).toBe("ok-b");
    // 1. a.greenhouse.io attempt 1 starts at 100_000, fails, and sleeps 1500ms (until 101_500).
    // 2. b.greenhouse.io attempt 1 is throttled by greenhouse.io (1000ms) and starts at 101_000.
    // 3. When a.greenhouse.io wakes at 101_500, throttleDomain("greenhouse.io", 1000) enforces
    //    1000ms after b.greenhouse.io's 101_000 start, so a.greenhouse.io attempt 2 fires at 102_000.
    expect(callLog).toEqual([
      { host: "a.greenhouse.io", attempt: 1, time: 100_000 },
      { host: "b.greenhouse.io", attempt: 1, time: 101_000 },
      { host: "a.greenhouse.io", attempt: 2, time: 102_000 },
    ]);

    // Part B: When rateLimitMs (3000ms) > failure backoff (1500ms), retry attempt waits for the full 3000ms domain interval
    lastRequestByDomain.clear();
    vi.setSystemTime(500_000);
    const customRateTimes: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      customRateTimes.push(Date.now());
      if (customRateTimes.length === 1) {
        return new Response("err", { status: 500, statusText: "Server Error" });
      }
      return new Response("ok", { status: 200 });
    });

    const pCustom = politeFetchText("https://jobs.ashbyhq.com/api/non-user-graphql", {
      skipRobotsCheck: true,
      rateLimitMs: 3000,
    });
    await vi.runAllTimersAsync();
    expect(await pCustom).toBe("ok");
    expect(customRateTimes).toEqual([500_000, 503_000]);
  });

  it("retries after per-attempt timeoutMs abort and respects pre-fetch forbidden/robots guards without retrying", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    // 1. Forbidden domain rejects before any fetch or timer
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(politeFetch("https://www.linkedin.com/jobs/view/123")).rejects.toThrow(
      "Scraping forbidden for target domain"
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    // 2. Per-attempt AbortController timeout triggers retry backoff and succeeds on attempt 2
    const timeoutAttemptTimes: number[] = [];
    fetchSpy.mockImplementation((_input: any, init?: RequestInit) => {
      timeoutAttemptTimes.push(Date.now());
      if (timeoutAttemptTimes.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error("The operation was aborted"));
            },
            { once: true }
          );
        });
      }
      return Promise.resolve(new Response("ok-after-timeout", { status: 200 }));
    });

    const timeoutPromise = politeFetchText("https://apply.workable.com/api/v1/widget/accounts/acme", {
      skipRobotsCheck: true,
      timeoutMs: 500,
      retries: 1,
    });

    await vi.runAllTimersAsync();
    expect(await timeoutPromise).toBe("ok-after-timeout");
    // Attempt 1 starts at 100_000, aborts at 100_500, sleeps 1500ms backoff -> Attempt 2 starts at 102_000
    expect(timeoutAttemptTimes).toEqual([100_000, 102_000]);
  });
});
