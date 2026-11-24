// @vitest-environment jsdom
// CM mobile item 21: infinite-scroll lifecycle on the real /jobs page (FIXTURE transport + IntersectionObserver).
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  deferred,
  fixtureJob,
  flush,
  h,
  installBrowserStandIns,
  io,
  page,
  range,
  resetHarness,
} from "./jobsHarness";

vi.mock("@/lib/jobs/service", async () => (await import("./jobsHarness")).jobsServiceMock());
vi.mock("@/lib/auth/session", async () => (await import("./jobsHarness")).sessionMock());
vi.mock("@/lib/billing/subscription", async () => (await import("./jobsHarness")).billingMock());
vi.mock("@/lib/tracker/storage", async () => (await import("./jobsHarness")).trackerMock());
vi.mock("@/lib/resume/storage", async () => (await import("./jobsHarness")).resumeStorageMock());
vi.mock("next/navigation", async () => (await import("./jobsHarness")).navigationMock());
vi.mock("@/lib/analytics/funnel", async () => (await import("./jobsHarness")).funnelMock());
vi.mock("@/lib/supabase/client", async () => (await import("./jobsHarness")).supabaseClientMock());
vi.mock("react-toastify", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

import JobsPage from "@/app/jobs/page";

const jobs = (ids: number[]) => ids.map((i) => fixtureJob(i));
const titles = () => screen.queryAllByRole("heading", { level: 2 }).map((el) => el.textContent?.trim()).filter((t) => t?.startsWith("Fixture Analyst"));
const uniqueTitles = () => Array.from(new Set(titles()));
const pagesRequested = () => h.calls.map((c) => c.page);
const loadMoreButton = () => screen.queryByRole("button", { name: /Load More Verified Positions|Retry|Loading Positions/ });

async function mount(url = "/jobs") {
  window.history.replaceState(null, "", url);
  const view = render(<JobsPage />);
  await flush();
  return view;
}

beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/jobs");
});

describe("mobile infinite scroll on the real feed (item 21)", () => {
  it("chains 3 pages through sentinel re-entry, keeps server order and stops when hasNextPage is false", async () => {
    h.transport = async ({ page: p }) =>
      p === 1 ? page(jobs(range(1, 25)), true) : p === 2 ? page(jobs(range(26, 50)), true) : page(jobs(range(51, 60)), false);
    await mount();
    expect(uniqueTitles()).toHaveLength(25);
    expect(loadMoreButton()).toBeNull();
    expect(screen.getByTestId("jobs-load-more-sentinel")).toBeTruthy();

    await act(async () => io.enter());
    await flush();
    expect(uniqueTitles()).toHaveLength(50);

    await act(async () => io.enter());
    await flush();
    expect(uniqueTitles()).toHaveLength(60);
    expect(uniqueTitles()).toEqual(range(1, 60).map((i) => `Fixture Analyst ${i}`));
    expect(pagesRequested()).toEqual([1, 2, 3]);

    // End: no sentinel, no button, an end message, and a further sentinel event requests nothing.
    expect(screen.queryByTestId("jobs-load-more-sentinel")).toBeNull();
    expect(loadMoreButton()).toBeNull();
    expect(screen.getByTestId("jobs-list-end").textContent).toContain("end of this list");
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3]);
  });

  it("drops duplicates within a page and across pages", async () => {
    h.transport = async ({ page: p }) =>
      p === 1
        ? page([...jobs(range(1, 25))], true)
        : page([fixtureJob(20), fixtureJob(26), fixtureJob(26), fixtureJob(27), fixtureJob(3)], false);
    await mount();
    await act(async () => io.enter());
    await flush();
    expect(uniqueTitles()).toEqual(range(1, 27).map((i) => `Fixture Analyst ${i}`));
    // One card per job: each title is rendered once per breakpoint tree, never twice for a duplicate id.
    const perJob = titles().filter((t) => t === "Fixture Analyst 1").length;
    for (const id of [3, 20, 26]) expect(titles().filter((t) => t === `Fixture Analyst ${id}`).length).toBe(perJob);
  });

  it("keeps one request in flight however often the sentinel fires, and applies the response once", async () => {
    const slow = deferred<any>();
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : slow.promise);
    await mount();
    for (let k = 0; k < 6; k++) await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    expect(screen.getByRole("status").textContent).toBe("Loading Positions...");
    expect(loadMoreButton()).toBeNull();
    await act(async () => slow.resolve(page(jobs(range(26, 30)), false)));
    await flush();
    expect(uniqueTitles()).toHaveLength(30);
    expect(pagesRequested()).toEqual([1, 2]);
  });

  it("error pauses auto-load; the accessible Retry button loads the page; no remaining count is shown", async () => {
    let failNext = true;
    h.transport = async ({ page: p }) => {
      if (p === 1) return page(jobs(range(1, 25)), true, 500);
      if (failNext) {
        failNext = false;
        return { jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null, isDegraded: true, error: "degraded" };
      }
      return page(jobs(range(26, 50)), true, 500);
    };
    await mount();
    await act(async () => io.enter());
    await flush();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load more jobs.");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("min-h-[44px]");
    // Auto-load is paused while in error: the sentinel firing again requests nothing.
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);

    fireEvent.click(retry);
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 2]);
    expect(uniqueTitles()).toHaveLength(50);
    // Successful retry resumes normal scroll loading without a button.
    expect(loadMoreButton()).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+ jobs? remaining/i);
  });

  it("an empty (or all-duplicate) page with hasNextPage true does not chain-load the database in the background", async () => {
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(p === 2 ? [] : jobs(range(1, 25)), true));
    await mount();
    await act(async () => io.enter());
    await flush();
    // The list did not grow; the observer must not keep firing page after page on its own.
    for (let k = 0; k < 5; k++) {
      await act(async () => io.enter());
      await flush();
    }
    expect(pagesRequested().length).toBeLessThanOrEqual(3);
    // The manual button stays available so the user can still ask for more.
    expect(loadMoreButton()).not.toBeNull();
  });

  it("an initial empty continuation chunk auto-chains to the first real page (regression: initial filtered-region dead end)", async () => {
    // The first pool/continuation chunks can legitimately contain zero eligible jobs
    // (filtered regions). The feed must keep loading on its own: no sentinel, no manual
    // button press, and no false empty state.
    h.transport = async ({ page: p }: any) => {
      if (p === 1) return { jobs: [], totalCount: 0, hasNextPage: true, nextCursor: "k:chunk-1", continuation: true };
      return page(jobs(range(1, 25)), false, 25, "k:chunk-2");
    };
    await mount();
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    expect(uniqueTitles()).toHaveLength(25);
    expect(uniqueTitles()[0]).toBe("Fixture Analyst 1");
  });

  it("multiple advancing empty continuation chunks chain until jobs arrive (regression: advancing-scan pause)", async () => {
    h.transport = async ({ page: p }: any) => {
      if (p <= 3) return { jobs: [], totalCount: 0, hasNextPage: true, nextCursor: `k:chunk-${p}`, continuation: true };
      if (p === 4) return page(jobs(range(1, 25)), true, 100, "k:chunk-4");
      return page(jobs(range(26, 50)), false, 100, "k:chunk-5");
    };
    await mount();
    await flush();
    // No observer entry needed: the chain runs from the initial response to the first
    // non-empty chunk, and the sentinel then continues the stream.
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5]);
    expect(uniqueTitles()).toHaveLength(50);
  });

  it("empty continuation chunks chain until genuine stream exhaustion, then stop", async () => {
    h.transport = async ({ page: p }: any) => {
      if (p <= 3) return { jobs: [], totalCount: 0, hasNextPage: true, nextCursor: `k:chunk-${p}`, continuation: true };
      // Exhaustion: server reports the end of the anchored stream.
      return { jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null, continuation: true };
    };
    await mount();
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3, 4]);
    for (let k = 0; k < 3; k++) {
      await act(async () => io.enter());
      await flush();
    }
    // The stream ended: no background refetching, and the true empty state can render.
    expect(pagesRequested()).toEqual([1, 2, 3, 4]);
  });

  it("a cycling continuation cursor (A then B then A) pauses auto-load immediately", async () => {
    h.transport = async ({ page: p }: any) => {
      if (p === 1) return page(jobs(range(1, 25)), true, 100, "k:A");
      if (p === 2) return { jobs: [], totalCount: 0, hasNextPage: true, nextCursor: "k:B", continuation: true };
      return { jobs: [], totalCount: 0, hasNextPage: true, nextCursor: "k:A", continuation: true };
    };
    await mount();
    await act(async () => io.enter());
    await flush();
    // k:B advanced onto an unseen cursor so the chain continued; the response cycling
    // back to the already-served k:A is non-advancing and pauses instead of spinning.
    expect(pagesRequested()).toEqual([1, 2, 3]);
    for (let k = 0; k < 4; k++) {
      await act(async () => io.enter());
      await flush();
    }
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(loadMoreButton()).not.toBeNull();
  });

  it("a non-advancing continuation cursor pauses auto-load immediately", async () => {
    h.transport = async ({ page: p }: any) => {
      if (p === 1) return page(jobs(range(1, 25)), true, 25);
      return { jobs: [], totalCount: 0, hasNextPage: true, nextCursor: "k:same-cursor", continuation: true };
    };
    await mount();
    for (let k = 0; k < 6; k++) {
      await act(async () => io.enter());
      await flush();
    }
    // One chunk advances onto the new cursor; the next response repeats it, so the loader
    // pauses instead of requesting the same position forever.
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(loadMoreButton()).not.toBeNull();
  });

  it("a slow page that returns after a filter change is never applied", async () => {
    const slow = deferred<any>();
    h.transport = async ({ page: p, search }) => {
      if (p === 1) return search ? page(jobs(range(201, 203)), false) : page(jobs(range(1, 25)), true);
      return slow.promise;
    };
    const view = await mount();
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    const oldPageSignal = h.calls[1].signal as AbortSignal;
    expect(oldPageSignal.aborted).toBe(false);
    // Rapid filter change via the URL-driven back/forward path (same handler the filter sheet feeds).
    window.history.pushState(null, "", "/jobs?search=fixture");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    // Search uses a real debounce. Microtask flushing alone does not establish that
    // the new query has started and cancelled the old next-page request.
    await waitFor(() => {
      expect(h.calls.some((call) => call.page === 1 && call.search === "fixture")).toBe(true);
      expect(oldPageSignal.aborted).toBe(true);
      expect(uniqueTitles()).toEqual(["Fixture Analyst 201", "Fixture Analyst 202", "Fixture Analyst 203"]);
    });
    await act(async () => slow.resolve(page(jobs(range(26, 50)), false)));
    await flush();
    expect(uniqueTitles()).toEqual(["Fixture Analyst 201", "Fixture Analyst 202", "Fixture Analyst 203"]);
    view.unmount();
  });

  it("unmount mid-request aborts it and applies nothing afterwards", async () => {
    const slow = deferred<any>();
    let signal: AbortSignal | undefined;
    h.transport = async ({ page: p, signal: s }) => {
      if (p === 1) return page(jobs(range(1, 25)), true);
      signal = s;
      return slow.promise;
    };
    const view = await mount();
    await act(async () => io.enter());
    await flush();
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    expect(io.live).toBe(0);
    await act(async () => slow.resolve(page(jobs(range(26, 50)), false)));
  });

  it("Saved tab is isolated: no sentinel, no next-page request; back to Recommended restores the loaded list", async () => {
    h.user = { id: "fx-user", email: "fixture@example.invalid" };
    h.isPro = true;
    h.apps = [];
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 40)), false));
    await mount();
    await act(async () => io.enter());
    await flush();
    expect(uniqueTitles()).toHaveLength(40);
    const before = pagesRequested().length;

    const savedTab = screen.getAllByRole("button", { name: /^Saved/ })[0] ?? screen.getAllByRole("tab", { name: /^Saved/ })[0];
    fireEvent.click(savedTab);
    await flush();
    expect(screen.queryByTestId("jobs-load-more-sentinel")).toBeNull();
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested().slice(before).every((p) => p === 1)).toBe(true);
  });

  it("opening a job and going Back keeps every loaded page without refetching page 1", async () => {
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 50)), true));
    await mount();
    await act(async () => io.enter());
    await flush();
    expect(uniqueTitles()).toHaveLength(50);
    const requests = pagesRequested().length;

    fireEvent.click(screen.getAllByRole("heading", { level: 2, name: "Fixture Analyst 40" })[0]);
    await flush();
    // The detail really opened (its id is synced to the URL) before we go Back.
    expect(window.location.search).toContain("id=fx-40");
    window.history.pushState(null, "", "/jobs");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: { scrollPos: 1234 } })));
    await flush();
    expect(uniqueTitles()).toHaveLength(50);
    expect(pagesRequested().length).toBe(requests);
  });

  it("a late callback from a replaced observer never repeats a loaded page or asks past the end", async () => {
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 30)), false));
    await mount();
    // Keep the observer that is live before page 2 loads; the browser may still deliver its queued entry later.
    const stale = io.instances.filter((i) => !i.disconnected);
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    await act(async () => {
      for (const inst of stale) inst.cb(inst.els.map((target) => ({ isIntersecting: true, target }) as any), {} as IntersectionObserver);
    });
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    expect(uniqueTitles()).toHaveLength(30);
  });

  it("append/recreated observers cannot chain pages without fresh user input", async () => {
    h.transport = async ({ page: p }) => page(jobs(range((p - 1) * 25 + 1, p * 25)), true);
    await mount();
    await act(async () => io.enter());
    await flush();
    expect(uniqueTitles()).toHaveLength(50);
    for (let k = 0; k < 12; k++) {
      await act(async () => {
        window.dispatchEvent(new Event("scroll")); // browser anchoring is not input
        io.enter(false);
      });
      await flush();
    }
    expect(pagesRequested()).toEqual([1, 2]);
    expect(uniqueTitles()).toHaveLength(50);
    await act(async () => io.enter()); // a new downward gesture allows the next page
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(uniqueTitles()).toHaveLength(75);
  });

  it("For You has no count, defaults to match and honors explicit Most recent on every page", async () => {
    h.transport = async ({ page: p }) => p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 50)), false);
    await mount();
    expect(h.calls.at(-1)?.sortBy).toBe("match");
    expect(screen.getAllByRole("button", { name: "For You" }).length).toBeGreaterThan(0);
    const sortButtons = screen.getAllByRole("button", { name: /Sort by Recommended:/ });
    fireEvent.click(sortButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: "Most recent" }));
    await flush();
    expect(h.calls.at(-1)?.sortBy).toBe("newest");
    await act(async () => io.enter());
    await flush();
    expect(h.calls.at(-1)?.page).toBe(2);
    expect(h.calls.at(-1)?.sortBy).toBe("newest");
  });

  it("desktop also auto-loads from the sentinel", async () => {
    h.desktop = true;
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 50)), false));
    await mount();
    expect(io.live).toBe(1);
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    expect(uniqueTitles()).toHaveLength(50);
  });
});
