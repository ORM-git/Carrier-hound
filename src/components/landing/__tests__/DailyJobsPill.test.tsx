// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Plus_Jakarta_Sans: () => ({ variable: "mock-jakarta" }),
}));

import HomePage from "@/app/page";

// The 5-minute refresh test advances fake time through the landing animation runtimes (~4s even on the
// original hook), right at vitest's 5s default.
vi.setConfig({ testTimeout: 30000 });

// Helper to flush pending promises in React
const flushPromises = async () => {
  await act(async () => {
    for (let i = 0; i < 15; i++) await Promise.resolve();
  });
};

const NOW_ISO = "2026-11-25T12:00:00.000Z";

function mockStatsFetch(statsHandler: (url: string, opts?: any) => Promise<any>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/stats")) {
      return statsHandler(url, init);
    }
    // Mock other landing components (ticker, job preview) so they don't consume stats calls
    if (url.startsWith("/api/ticker")) {
      return { ok: true, json: async () => [] };
    }
    if (url.startsWith("/api/jobs")) {
      return { ok: true, json: async () => ({ jobs: [] }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Daily jobs found pill on CM landing (HomePage)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders exact localized count and plural grammar for positive count > 1", async () => {
    let capturedOpts: any;
    mockStatsFetch(async (url, opts) => {
      capturedOpts = opts;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobsToday: 42,
          updatedAt: NOW_ISO,
        }),
      };
    });

    const { container } = render(<HomePage />);
    await flushPromises();

    // The fetch must be anonymous (no auth header, no tokens)
    expect(capturedOpts?.headers).toBeUndefined();

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill).not.toBeNull();
    expect(pill?.classList.contains("daily-count-pending")).toBe(false);
    expect(pill?.textContent).toContain("42 new job records added today");
    expect(pill?.getAttribute("aria-hidden")).toBeNull();
  });

  it("renders singular grammar for positive count === 1", async () => {
    mockStatsFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jobsToday: 1,
        updatedAt: NOW_ISO,
      }),
    }));

    const { container } = render(<HomePage />);
    await flushPromises();

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.classList.contains("daily-count-pending")).toBe(false);
    expect(pill?.textContent).toContain("1 new job record added today");
    expect(pill?.textContent).not.toContain("jobs");
  });

  it("keeps pill hidden for true zero (jobsToday === 0)", async () => {
    mockStatsFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jobsToday: 0,
        updatedAt: NOW_ISO,
      }),
    }));

    const { container } = render(<HomePage />);
    await flushPromises();

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.classList.contains("daily-count-pending")).toBe(true);
    expect(pill?.getAttribute("aria-hidden")).toBe("true");
    expect(pill?.textContent).toContain("Daily jobs count pending verification");
  });

  it("stays hidden while loading with no placeholder flash", async () => {
    // Hang fetch promise to simulate in-flight loading
    mockStatsFetch(() => new Promise(() => {}));

    const { container } = render(<HomePage />);

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.classList.contains("daily-count-pending")).toBe(true);
    expect(pill?.getAttribute("aria-hidden")).toBe("true");
  });

  it("stays hidden on 500/503 server errors and timeouts", async () => {
    mockStatsFetch(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: "Service unavailable" }),
    }));

    const { container, unmount } = render(<HomePage />);
    await flushPromises();

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.classList.contains("daily-count-pending")).toBe(true);
    expect(pill?.getAttribute("aria-hidden")).toBe("true");
    unmount();

    // Verify 429 rate limiting with Retry-After HTTP-date format stays hidden
    mockStatsFetch(async () => ({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      json: async () => ({ error: "Too Many Requests" }),
    }));
    const view429 = render(<HomePage />);
    await flushPromises();
    const pill429 = view429.container.querySelector(".hero-inner .pill");
    expect(pill429?.classList.contains("daily-count-pending")).toBe(true);
    view429.unmount();
  });

  it("stays hidden on malformed data (null, string, float, negative)", async () => {
    mockStatsFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jobsToday: "forty-two",
        updatedAt: NOW_ISO,
      }),
    }));

    const { container } = render(<HomePage />);
    await flushPromises();

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.classList.contains("daily-count-pending")).toBe(true);
  });

  it("stays hidden when updatedAt belongs to a prior IST day (stale cached data)", async () => {
    const yesterdayUtc = "2026-11-24T18:29:00.000Z";
    mockStatsFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jobsToday: 88,
        updatedAt: yesterdayUtc,
      }),
    }));

    const { container } = render(<HomePage />);
    await flushPromises();

    // Prior-day result must stay hidden
    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.classList.contains("daily-count-pending")).toBe(true);
  });

  it("refreshes every 5 minutes while visible", async () => {
    let callCount = 0;
    mockStatsFetch(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobsToday: callCount === 1 ? 10 : 15,
          updatedAt: NOW_ISO,
        }),
      };
    });

    const { container } = render(<HomePage />);
    await flushPromises();
    expect(container.querySelector(".hero-inner .pill")?.textContent).toContain("10 new job records added today");
    expect(callCount).toBe(1);

    // Advance by 5 minutes
    await act(async () => {
      vi.advanceTimersByTime(300_000);
    });
    await flushPromises();

    expect(callCount).toBe(2);
    expect(container.querySelector(".hero-inner .pill")?.textContent).toContain("15 new job records added today");
  });

  it("revalidates on tab return (visibilitychange)", async () => {
    let callCount = 0;
    mockStatsFetch(async () => {
      callCount++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jobsToday: callCount === 1 ? 20 : 25,
          updatedAt: NOW_ISO,
        }),
      };
    });

    const { container } = render(<HomePage />);
    await flushPromises();
    expect(callCount).toBe(1);

    // Switch tab to hidden, then back to visible
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushPromises();

    expect(callCount).toBe(2);
    expect(container.querySelector(".hero-inner .pill")?.textContent).toContain("25 new job records added today");
  });

  it("hides yesterday's count at IST midnight until fresh data arrives", async () => {
    // Current time: 18:29:50 UTC (23:59:50 IST)
    const nearMidnight = new Date("2026-11-25T18:29:50.000Z");
    vi.setSystemTime(nearMidnight);

    let resolveFreshFetch: any;
    const freshFetchPromise = new Promise((res) => {
      resolveFreshFetch = res;
    });

    let callIndex = 0;
    mockStatsFetch(async () => {
      callIndex++;
      if (callIndex === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ jobsToday: 50, updatedAt: nearMidnight.toISOString() }),
        };
      }
      return freshFetchPromise;
    });

    const { container } = render(<HomePage />);
    await flushPromises();
    expect(container.querySelector(".hero-inner .pill")?.textContent).toContain("50 new job records added today");

    // Advance time past IST midnight (11 seconds into 2026-11-26)
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });

    // Yesterday's count must immediately hide while awaiting fresh response
    const pillMid = container.querySelector(".hero-inner .pill");
    expect(pillMid?.classList.contains("daily-count-pending")).toBe(true);

    // Now resolve fresh response for the new UTC day
    const newDayIso = "2026-11-25T18:30:05.000Z";
    await act(async () => {
      resolveFreshFetch({
        ok: true,
        status: 200,
        json: async () => ({ jobsToday: 5, updatedAt: newDayIso }),
      });
    });
    await flushPromises();

    const pillFresh = container.querySelector(".hero-inner .pill");
    expect(pillFresh?.classList.contains("daily-count-pending")).toBe(false);
    expect(pillFresh?.textContent).toContain("5 new job records added today");
  });

  it("prevents stale-response race conditions", async () => {
    let resolveFirst: any;
    const firstPromise = new Promise((res) => {
      resolveFirst = res;
    });

    let reqIndex = 0;
    mockStatsFetch(async () => {
      reqIndex++;
      if (reqIndex === 1) {
        return firstPromise;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jobsToday: 30, updatedAt: NOW_ISO }),
      };
    });

    const { container } = render(<HomePage />);
    // Trigger second request before first finishes
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushPromises();

    expect(container.querySelector(".hero-inner .pill")?.textContent).toContain("30 new job records added today");

    // Late resolution of first (stale) response
    await act(async () => {
      resolveFirst({
        ok: true,
        status: 200,
        json: async () => ({ jobsToday: 10, updatedAt: NOW_ISO }),
      });
    });
    await flushPromises();

    // Must remain 30 (stale slower response discarded)
    expect(container.querySelector(".hero-inner .pill")?.textContent).toContain("30 new job records added today");
  });

  it("cleans up active timers, listeners, and aborts pending fetch on unmount", async () => {
    let aborted = false;
    mockStatsFetch((_url, opts) => {
      opts.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise(() => {});
    });

    const view = render(<HomePage />);
    expect(aborted).toBe(false);

    view.unmount();
    expect(aborted).toBe(true);
  });

  // NEGATIVE CONTROL:
  // Proves that rendered HomePage fails if the old static pending pill is present,
  // and passes when dynamic count from /api/stats is restored.
  it("NEGATIVE CONTROL: renders real count in HomePage and fails if old pending pill is present", async () => {
    mockStatsFetch(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ jobsToday: 1122, updatedAt: NOW_ISO }),
    }));

    const { container } = render(<HomePage />);
    await flushPromises();

    const pill = container.querySelector(".hero-inner .pill");
    expect(pill?.textContent).toContain("1,122 new job records added today");
    expect(pill?.classList.contains("daily-count-pending")).toBe(false);
  });
});
