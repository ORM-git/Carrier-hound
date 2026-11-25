// @vitest-environment jsdom
// Daily jobs pill refresh edges on the REAL HomePage (real useDailyJobsCount, real page markup, fake
// timers). Only the two DOM animation runtimes are stubbed: their frame-rate timers would otherwise make
// hours of fake time unrunnable. Nothing about the pill, its hook or /api/stats handling is mocked;
// fetch is a controlled fixture.
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });
vi.mock("next/font/google", () => ({ Plus_Jakarta_Sans: () => ({ variable: "mock-jakarta" }) }));
vi.mock("@/components/landing/careermonke-landing-runtime", () => ({ initCareerMonkeLanding: () => () => {} }));
vi.mock("@/components/landing/careermonke-landing-lower-runtime", () => ({ initCareerMonkeLandingLower: () => () => {} }));

import HomePage from "@/app/page";

const flushPromises = async () => {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
};
const NOW_ISO = "2026-11-25T12:00:00.000Z";

function mockStatsFetch(statsHandler: (url: string, opts?: any) => Promise<any>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/stats")) return statsHandler(url, init);
    if (url.startsWith("/api/ticker")) return { ok: true, json: async () => [] };
    if (url.startsWith("/api/jobs")) return { ok: true, json: async () => ({ jobs: [] }) };
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------------------------
// Refresh failure, timeout, Retry-After and day-freshness edges (real HomePage, fake timers).
// ---------------------------------------------------------------------------------------------
const pillOf = (c: HTMLElement) => c.querySelector(".hero-inner .pill");
const isHidden = (c: HTMLElement) => pillOf(c)?.classList.contains("daily-count-pending") === true;
const ok = (jobsToday: unknown, updatedAt = NOW_ISO) => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ jobsToday, updatedAt }) });
const status = (code: number, headers: Record<string, string> = {}) => ({ ok: false, status: code, headers: new Headers(headers), json: async () => ({ error: "x" }) });
// The ticker/preview sections may read matchMedia; jsdom has none.
const stubMatchMedia = () =>
  vi.stubGlobal(
    "matchMedia",
    (q: string) => ({ matches: false, media: q, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false })
  );
// Advances fake time in 1-minute steps, flushing promises between steps so fetch-driven chains settle.
const advance = async (ms: number) => {
  for (let left = ms; left > 0; left -= 60_000) {
    await act(async () => {
      vi.advanceTimersByTime(Math.min(60_000, left));
    });
    await flushPromises();
  }
};

describe("Daily jobs pill: refresh failures never leave an old number visible", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    stubMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["503", () => status(503)],
    ["429", () => status(429, { "Retry-After": "120" })],
    ["malformed", () => ok("forty-two")],
    ["prior IST day", () => ok(77, "2026-11-24T18:29:00.000Z")],
    ["network error", () => Promise.reject(new TypeError("Failed to fetch"))],
  ])("42 then %s on the 5-minute refresh hides the pill", async (_name, second) => {
    let n = 0;
    mockStatsFetch(async () => (++n === 1 ? ok(42) : second()));
    const { container } = render(<HomePage />);
    await flushPromises();
    expect(pillOf(container)?.textContent).toContain("42 new job records added today");
    await advance(300_000);
    expect(n).toBe(2);
    expect(isHidden(container)).toBe(true);
    expect(pillOf(container)?.getAttribute("aria-hidden")).toBe("true");
  });

  it("a hung refresh after success times out: the pill hides, the request is aborted and a retry follows", async () => {
    let n = 0;
    let aborted = false;
    mockStatsFetch((_u, opts) => {
      n++;
      if (n === 1) return Promise.resolve(ok(42));
      if (n === 2) {
        return new Promise((_res, rej) =>
          opts?.signal?.addEventListener("abort", () => {
            aborted = true;
            rej(new DOMException("Aborted", "AbortError"));
          })
        );
      }
      return Promise.resolve(ok(43));
    });
    const { container } = render(<HomePage />);
    await flushPromises();
    await advance(300_000); // refresh starts and hangs
    expect(n).toBe(2);
    expect(pillOf(container)?.textContent).toContain("42"); // still within the timeout window
    await advance(15_000); // past the request timeout
    expect(aborted).toBe(true);
    expect(isHidden(container)).toBe(true);
    await advance(120_000); // bounded backoff retry
    expect(n).toBe(3);
    expect(pillOf(container)?.textContent).toContain("43 new job records added today");
  });
});

describe("Daily jobs pill: Retry-After is honored in full and nothing bypasses it", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    stubMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([
    ["seconds", "600"],
    ["HTTP-date", new Date(Date.parse(NOW_ISO) + 600_000).toUTCString()],
  ])("Retry-After %s = 600s: no request before the deadline, even on tab return", async (_fmt, header) => {
    let n = 0;
    mockStatsFetch(async () => (++n === 1 ? status(429, { "Retry-After": header }) : ok(9)));
    const { container } = render(<HomePage />);
    await flushPromises();
    expect(n).toBe(1);
    await advance(301_000); // the old 300s cap would have retried here
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushPromises();
    expect(n).toBe(1);
    expect(isHidden(container)).toBe(true);
    await advance(300_000); // now past 600s
    expect(n).toBe(2);
    expect(pillOf(container)?.textContent).toContain("9 new job records added today");
  });

  it("a IST-midnight revalidation does not bypass an active rate-limit deadline", async () => {
    vi.setSystemTime(new Date("2026-11-25T18:25:00.000Z"));
    let n = 0;
    mockStatsFetch(async () => (++n === 1 ? status(429, { "Retry-After": "1800" }) : ok(3, new Date().toISOString())));
    render(<HomePage />);
    await flushPromises();
    await advance(10 * 60_000); // crosses IST midnight at 18:25Z + 5 min
    expect(n).toBe(1);
    await advance(21 * 60_000); // past the 30-minute deadline
    expect(n).toBe(2);
  });

  it("repeated invalid data backs off and stops automatic retries (no endless 60s loop)", async () => {
    vi.setSystemTime(new Date("2026-11-25T18:35:00.000Z")); // 00:05 IST: the 12h window below crosses no IST midnight
    let n = 0;
    mockStatsFetch(async () => {
      n++;
      return ok(null);
    });
    render(<HomePage />);
    await flushPromises();
    await advance(6 * 3600_000); // six hours of fake time
    expect(n).toBeLessThanOrEqual(8);
    const settled = n;
    await advance(6 * 3600_000);
    expect(n).toBe(settled); // suspended: only a tab return or the next IST day tries again
  });
});

describe("Daily jobs pill: a count from another IST day is never shown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    stubMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("tab return after a throttled background (clock past midnight, no timers fired) hides yesterday's number before any response", async () => {
    vi.setSystemTime(new Date("2026-11-25T12:00:00.000Z"));
    let n = 0;
    mockStatsFetch(() => (++n === 1 ? Promise.resolve(ok(50, "2026-11-25T12:00:00.000Z")) : new Promise(() => {})));
    const { container } = render(<HomePage />);
    await flushPromises();
    expect(pillOf(container)?.textContent).toContain("50 new job records added today");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.setSystemTime(new Date("2026-11-26T09:00:00.000Z")); // clock moves; no timer callbacks run
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(isHidden(container)).toBe(true); // hidden synchronously, while the new request is pending
  });

  it("a request started before midnight that resolves after it with the old day stays hidden", async () => {
    vi.setSystemTime(new Date("2026-11-25T18:29:58.000Z"));
    let resolveLate: (v: unknown) => void = () => {};
    mockStatsFetch(() => new Promise((res) => (resolveLate = res)));
    const { container } = render(<HomePage />);
    await flushPromises();
    vi.setSystemTime(new Date("2026-11-25T18:30:03.000Z"));
    await act(async () => resolveLate(ok(61, "2026-11-25T18:29:58.500Z")));
    await flushPromises();
    expect(isHidden(container)).toBe(true);
  });
});

describe("Retry-After parsing and the IST day key", () => {
  it("returns the server's full wait in seconds (no 300s cap) for both formats; invalid or past values are ignored", async () => {
    const { parseRetryAfterHeader, istDayKey } = await import("@/lib/api/stats");
    const now = Date.parse("2026-11-25T12:00:00.000Z");
    expect(parseRetryAfterHeader("600", now)).toBe(600);
    expect(parseRetryAfterHeader("86400", now)).toBe(86400);
    expect(parseRetryAfterHeader(new Date(now + 900_000).toUTCString(), now)).toBe(900);
    for (const bad of [null, "", "0", "-5", "12abc", "1.5", "soon", new Date(now - 1000).toUTCString()]) {
      expect(parseRetryAfterHeader(bad as any, now)).toBeUndefined();
    }
    expect(istDayKey("2026-11-25T18:29:59.999Z")).toBe("2026-11-25");
    expect(istDayKey(Date.parse("2026-11-25T18:30:00.000Z"))).toBe("2026-11-26");
    expect(istDayKey("not a date")).toBeNull();
  });
});

describe("Daily jobs pill: every request stays anonymous", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    stubMatchMedia();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("initial, 5-minute, failure-retry and tab-return requests carry no Authorization header or credentials", async () => {
    const inits: Array<RequestInit | undefined> = [];
    let n = 0;
    mockStatsFetch(async (_u, init) => {
      inits.push(init);
      return ++n === 2 ? status(503) : ok(5);
    });
    render(<HomePage />);
    await flushPromises();
    await advance(300_000 + 30_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushPromises();
    expect(inits.length).toBeGreaterThanOrEqual(4);
    for (const init of inits) {
      const h = new Headers(init?.headers as HeadersInit | undefined);
      expect(h.has("authorization")).toBe(false);
      expect(init?.credentials).toBe("omit");
    }
  });
});
