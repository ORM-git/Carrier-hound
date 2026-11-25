// @vitest-environment jsdom
// /jobs feed on the real page (FIXTURE transport + IntersectionObserver): page 1 renders first, pages 2-3
// warm in the background, and crossing a rendered page boundary refills the next three pages inside a
// bounded look-ahead window. Covers order, dedupe, continuation, failure/Retry and stale-response isolation.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GetJobsResult } from "@/lib/jobs/service";
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
const names = (ids: number[]) => ids.map((i) => `Fixture Analyst ${i}`);
const pagesRequested = () => h.calls.map((c) => c.page);
const loadMoreButton = () => screen.queryByRole("button", { name: /Load More Verified Positions|Retry|Loading Positions/ });
/** Full pages of 25 in server order, always reporting more. */
const endless = async ({ page: p }: any) => page(jobs(range((p - 1) * 25 + 1, p * 25)), true);
const cursorPage = (ids: number[], nextCursor: string | null, hasNextPage = true): GetJobsResult => ({ jobs: jobs(ids), totalCount: 500, hasNextPage, nextCursor });

/** Delivers an IntersectionObserver entry only for the matching observed elements, as a real scroll does. */
function fire(match: (el: HTMLElement) => boolean) {
  for (const inst of io.instances) {
    if (inst.disconnected) continue;
    const els = inst.els.filter((el) => match(el as HTMLElement));
    if (els.length) inst.cb(els.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry), {} as IntersectionObserver);
  }
}
/** Waits until no look-ahead request is running (the tail indicator is gone). */
const idle = () => waitFor(() => expect(screen.queryByText("Loading Positions...")).toBeNull(), { timeout: 10000 });
/** The first card of rendered page k scrolls into view; by default waits for the resulting chain to settle. */
const reach = async (k: number, settle = true) => {
  await act(async () => fire((el) => el.dataset.feedPage === String(k)));
  await flush();
  if (settle) await idle();
};
/** Only the tail sentinel enters view (no page boundary), optionally after a downward wheel. */
const tail = async (userInput: boolean) => {
  await act(async () => {
    if (userInput) window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    fire((el) => el.dataset.testid === "jobs-load-more-sentinel");
  });
  await flush();
};
/** Wraps a transport to record the maximum number of simultaneous requests. */
function trackConcurrency(transport: (opts: any) => Promise<GetJobsResult>) {
  const stats = { inFlight: 0, max: 0 };
  h.transport = async (opts) => {
    stats.inFlight++;
    stats.max = Math.max(stats.max, stats.inFlight);
    try {
      return await transport(opts);
    } finally {
      stats.inFlight--;
    }
  };
  return stats;
}

async function mount(url = "/jobs", settle = true) {
  window.history.replaceState(null, "", url);
  const view = render(<JobsPage />);
  await flush();
  if (settle) await idle();
  return view;
}

// Several tests scroll through many rendered pages; give them room on a loaded CI runner.
vi.setConfig({ testTimeout: 30000 });

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

describe("three-page warm-up and bounded look-ahead", () => {
  it("renders page 1 before delayed pages 2 and 3, then warms them one after another in order", async () => {
    const p2 = deferred<GetJobsResult>();
    const p3 = deferred<GetJobsResult>();
    const stats = trackConcurrency(async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : p === 2 ? p2.promise : p3.promise));
    await mount("/jobs", false);
    // Page 1 is on screen and interactive while page 2 is still pending; page 3 waits for page 2.
    expect(uniqueTitles()).toEqual(names(range(1, 25)));
    expect(pagesRequested()).toEqual([1, 2]);
    // Honest, non-blocking tail indicator below the rendered cards.
    expect(screen.getByRole("status").textContent).toBe("Loading Positions...");
    expect(loadMoreButton()).toBeNull();
    await act(async () => p2.resolve(page(jobs(range(26, 50)), true)));
    await flush();
    expect(uniqueTitles()).toEqual(names(range(1, 50)));
    expect(pagesRequested()).toEqual([1, 2, 3]);
    await act(async () => p3.resolve(page(jobs(range(51, 75)), true)));
    await flush();
    expect(uniqueTitles()).toEqual(names(range(1, 75)));
    expect(stats.max).toBe(1);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("a stationary reader downloads exactly three pages, however long it waits", async () => {
    h.transport = endless;
    await mount();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    for (let k = 0; k < 10; k++) {
      await act(async () => window.dispatchEvent(new Event("scroll"))); // anchoring/layout is not a crossing
      await flush();
    }
    expect(pagesRequested()).toEqual([1, 2, 3]);
  });

  it("crossing one rendered page boundary requests the next three pages; repeated events coalesce", async () => {
    const stats = trackConcurrency(endless);
    await mount();
    for (let k = 0; k < 5; k++) await reach(2);
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(uniqueTitles()).toEqual(names(range(1, 150)));
    // Three pages are already buffered past page 3: no request.
    await reach(2);
    await reach(3);
    expect(pagesRequested()).toEqual(range(1, 6));
    // The next real crossing refills again.
    await reach(4);
    expect(pagesRequested()).toEqual(range(1, 9));
    expect(stats.max).toBe(1);
  });

  it("the look-ahead window is capped: never more than five pages beyond the deepest page reached", async () => {
    h.transport = endless;
    await mount();
    let deepest = 1;
    for (const k of [2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await reach(k);
      deepest = k;
      expect(Math.max(...pagesRequested()) - deepest).toBeLessThanOrEqual(5);
      expect(Math.max(...pagesRequested()) - deepest).toBeGreaterThanOrEqual(2); // always supplied ahead
    }
    expect(pagesRequested()).toEqual(range(1, 15));
  });

  it("crossings during a running refill coalesce into one pending refill", async () => {
    const p4 = deferred<GetJobsResult>();
    const stats = trackConcurrency(async (opts) => (opts.page === 4 ? p4.promise : endless(opts)));
    await mount();
    await reach(2, false); // chain 4-6 starts; page 4 is slow
    expect(pagesRequested()).toEqual([1, 2, 3, 4]);
    for (let k = 0; k < 4; k++) await reach(3, false);
    await act(async () => {
      for (let k = 0; k < 6; k++) window.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));
    });
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3, 4]);
    await act(async () => p4.resolve(page(jobs(range(76, 100)), true)));
    await idle();
    // The chain finished 5-6; the pending refill re-checked once and found three pages buffered past page 3.
    expect(pagesRequested()).toEqual(range(1, 6));
    expect(stats.max).toBe(1);
  });

  it.each([
    ["wheel", () => window.dispatchEvent(new WheelEvent("wheel", { deltaY: 120 }))],
    ["keyboard", () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown", bubbles: true }))],
    [
      "touch",
      () => {
        const start = new Event("touchstart");
        (start as any).touches = [{ clientY: 400 }];
        window.dispatchEvent(start);
        const move = new Event("touchmove");
        (move as any).touches = [{ clientY: 250 }];
        window.dispatchEvent(move);
      },
    ],
  ])("continuous %s scrolling stays supplied when responses arrive in time", async (_name, gesture) => {
    h.transport = endless;
    await mount();
    for (let k = 2; k <= 9; k++) {
      await act(async () => gesture());
      await reach(k);
      // The reader is on page k and at least two full pages are already rendered below it.
      expect(uniqueTitles().length).toBeGreaterThanOrEqual((k + 2) * 25);
      expect(loadMoreButton()).toBeNull();
    }
    // Strictly sequential, no page requested twice.
    expect(pagesRequested()).toEqual(range(1, pagesRequested().length));
  });

  it("appending prefetched pages keeps earlier cards in place, in order and clickable, without moving the scroll", async () => {
    h.transport = endless;
    const scrollTo = vi.spyOn(window, "scrollTo");
    await mount();
    const card10 = screen.getAllByRole("heading", { level: 2, name: "Fixture Analyst 10" })[0];
    await reach(2);
    expect(uniqueTitles().slice(0, 75)).toEqual(names(range(1, 75)));
    // Same DOM node: React kept the card, nothing was re-mounted above the reader.
    expect(screen.getAllByRole("heading", { level: 2, name: "Fixture Analyst 10" })[0]).toBe(card10);
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(card10);
    await flush();
    expect(window.location.search).toContain("id=fx-10");
    scrollTo.mockRestore();
  });

  it("drops duplicates within a page and across prefetched pages", async () => {
    h.transport = async ({ page: p }) =>
      p === 1
        ? page([...jobs(range(1, 25))], true)
        : p === 2
          ? page([fixtureJob(20), fixtureJob(26), fixtureJob(26), fixtureJob(27), fixtureJob(3)], true)
          : page([fixtureJob(27), fixtureJob(28)], false);
    await mount();
    expect(uniqueTitles()).toEqual(names(range(1, 28)));
    // One card per job: each title is rendered once per breakpoint tree, never twice for a duplicate id.
    const perJob = titles().filter((t) => t === "Fixture Analyst 1").length;
    for (const id of [3, 20, 26, 27]) expect(titles().filter((t) => t === `Fixture Analyst ${id}`).length).toBe(perJob);
  });

  it("follows real continuation cursors in order and does not stop on an empty continuation page", async () => {
    h.transport = async ({ page: p }) =>
      p === 1 ? cursorPage(range(1, 25), "c1") : p === 2 ? cursorPage([], "c2") : cursorPage(range(26, 30), "c3");
    await mount();
    expect(h.calls.map((c) => [c.page, c.cursor ?? null])).toEqual([
      [1, null],
      [2, "c1"],
      [3, "c2"],
    ]);
    expect(uniqueTitles()).toEqual(names(range(1, 30)));
    expect(loadMoreButton()).toBeNull();
  });

  it.each([
    ["repeats a consumed cursor", "c1"],
    ["drops the cursor while reporting more", null],
  ])("pauses safely when the server %s instead of looping", async (_name, badCursor) => {
    h.transport = async ({ page: p }) => (p === 1 ? cursorPage(range(1, 25), "c1") : cursorPage(range(26, 30), badCursor));
    await mount();
    expect(pagesRequested()).toEqual([1, 2]);
    expect(uniqueTitles()).toEqual(names(range(1, 30)));
    expect(loadMoreButton()?.textContent).toBe("Load More Verified Positions");
    await reach(2);
    await tail(true);
    expect(pagesRequested()).toEqual([1, 2]);
  });

  it("a whole chain of duplicate-only pages pauses; Load More is one bounded refill", async () => {
    h.transport = async () => page(jobs(range(1, 25)), true);
    await mount();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(uniqueTitles()).toHaveLength(25);
    await tail(true);
    expect(pagesRequested()).toEqual([1, 2, 3]);
    fireEvent.click(loadMoreButton()!);
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("stops at the true end: end message, no sentinel, and nothing more is requested", async () => {
    h.transport = async ({ page: p }) =>
      p === 1 ? page(jobs(range(1, 25)), true) : p === 2 ? page(jobs(range(26, 50)), true) : page(jobs(range(51, 60)), false);
    await mount();
    expect(uniqueTitles()).toEqual(names(range(1, 60)));
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(screen.queryByTestId("jobs-load-more-sentinel")).toBeNull();
    expect(loadMoreButton()).toBeNull();
    expect(screen.getByTestId("jobs-list-end").textContent).toContain("end of this list");
    await act(async () => io.enter());
    await flush();
    expect(pagesRequested()).toEqual([1, 2, 3]);
  });

  it.each([
    ["throws", () => Promise.reject(new Error("network down"))],
    ["is degraded", async () => ({ jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null, isDegraded: true, error: "degraded" }) as GetJobsResult],
  ])("a background page that %s keeps loaded cards, never advances past its cursor, and Retry resumes there", async (_name, failure) => {
    let failNext = true;
    h.transport = async ({ page: p }) => {
      if (p === 1) return cursorPage(range(1, 25), "c1");
      if (p === 2 && failNext) {
        failNext = false;
        return failure();
      }
      return p === 2 ? cursorPage(range(26, 50), "c2") : cursorPage(range(51, 75), "c3");
    };
    await mount();
    expect(screen.getByRole("alert").textContent).toContain("Couldn't load more jobs.");
    expect(uniqueTitles()).toEqual(names(range(1, 25)));
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("min-h-[44px]");
    // Paused: crossings, the tail and time do not retry on their own.
    await tail(true);
    await act(async () => io.enter());
    await flush(20);
    expect(pagesRequested()).toEqual([1, 2]);
    fireEvent.click(retry);
    await flush();
    // Same continuation as the failed request, then the unfinished warm-up continues to page 3.
    expect(h.calls.map((c) => [c.page, c.cursor ?? null])).toEqual([
      [1, null],
      [2, "c1"],
      [2, "c1"],
      [3, "c2"],
    ]);
    expect(uniqueTitles()).toEqual(names(range(1, 75)));
    expect(loadMoreButton()).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d+ jobs? remaining/i);
  });

  it("a failure discards a refill asked for during the failing request", async () => {
    const p2 = deferred<GetJobsResult>();
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : p === 2 ? p2.promise : endless({ page: p }));
    await mount("/jobs", false);
    await tail(true); // reader at the tail while page 2 is in flight
    await act(async () => p2.reject(new Error("network down")));
    await flush(20);
    expect(pagesRequested()).toEqual([1, 2]);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("the tail sentinel without fresh input (anchoring, recreated observers) never extends the window", async () => {
    h.transport = endless;
    await mount();
    for (let k = 0; k < 12; k++) {
      await act(async () => window.dispatchEvent(new Event("scroll")));
      await tail(false);
    }
    expect(pagesRequested()).toEqual([1, 2, 3]);
    await tail(true); // a real downward gesture at the tail asks for the next three
    expect(pagesRequested()).toEqual(range(1, 6));
  });
});

describe("reset and isolation", () => {
  it("a filter change during warm-up aborts it, discards the late page and warms the new query only", async () => {
    const slow = deferred<GetJobsResult>();
    h.transport = async ({ page: p, search }) => {
      if (search) return page(jobs(range(200 + (p - 1) * 3 + 1, 200 + p * 3)), true);
      return p === 1 ? page(jobs(range(1, 25)), true) : slow.promise;
    };
    const view = await mount("/jobs", false);
    expect(pagesRequested()).toEqual([1, 2]);
    const oldSignal = h.calls[1].signal as AbortSignal;
    window.history.pushState(null, "", "/jobs?search=fixture");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => {
      expect(oldSignal.aborted).toBe(true);
      expect(h.calls.filter((c) => c.search === "fixture").map((c) => c.page)).toEqual([1, 2, 3]);
    });
    await act(async () => slow.resolve(page(jobs(range(26, 50)), true)));
    await flush();
    expect(uniqueTitles()).toEqual(names(range(201, 209)));
    // The old query never continued to page 3.
    expect(h.calls.filter((c) => !c.search).map((c) => c.page)).toEqual([1, 2]);
    view.unmount();
  });

  it("StrictMode's dev remount requests page 1 again instead of showing the aborted one as an error", async () => {
    h.transport = endless;
    window.history.replaceState(null, "", "/jobs");
    render(
      <React.StrictMode>
        <JobsPage />
      </React.StrictMode>
    );
    await flush();
    await idle();
    expect(uniqueTitles()).toEqual(names(range(1, 75)));
    expect(screen.queryByText("Couldn't load jobs")).toBeNull();
    // The aborted first mount's page 1 is not followed by a second warm-up of the same pages.
    expect(pagesRequested().filter((p) => p > 1)).toEqual([2, 3]);
  });

  it("a query change aborts an in-flight page 1 of the old query", async () => {
    const slow = deferred<GetJobsResult>();
    h.transport = async ({ search }) => (search ? page(jobs(range(201, 203)), false) : slow.promise);
    await mount();
    const oldFirstPage = h.calls[0].signal as AbortSignal | undefined;
    expect(oldFirstPage?.aborted).toBe(false);
    window.history.pushState(null, "", "/jobs?search=fixture");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate")));
    await waitFor(() => expect(uniqueTitles()).toEqual(names(range(201, 203))));
    expect(oldFirstPage?.aborted).toBe(true);
    await act(async () => slow.resolve(page(jobs(range(1, 25)), true)));
    await flush();
    expect(uniqueTitles()).toEqual(names(range(201, 203)));
  });

  it("a signed-in reader's preferences arrive with the account: page 1 is requested once for them, not twice", async () => {
    h.user = { id: "fx-user", email: "fixture@example.invalid" };
    h.isPro = true;
    const prefs = { roles: ["Fixture Analyst"], categories: [], employmentTypes: [], locations: [], updatedAt: "2026-01-01T00:00:00.000Z" };
    const prefsReply = deferred<typeof prefs>();
    h.prefs = prefsReply.promise; // preferences are a separate, slower network read
    h.transport = async ({ page: p }) => page(jobs(range((p - 1) * 25 + 1, p * 25)), p < 3);
    await mount();
    await act(async () => prefsReply.resolve(prefs));
    await flush();
    const proFirstPages = h.calls.filter((c) => c.isPro && c.page === 1);
    expect(proFirstPages).toHaveLength(1);
    expect(proFirstPages[0].preferences).toEqual(prefs);
  });

  it("unmount mid-chain aborts the request and nothing is requested or applied afterwards", async () => {
    const slow = deferred<GetJobsResult>();
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : slow.promise);
    const view = await mount("/jobs", false);
    const signal = h.calls[1].signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
    expect(io.live).toBe(0);
    await act(async () => slow.resolve(page(jobs(range(26, 50)), true)));
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
  });

  it("losing Pro (tier change or sign-out) resets the chain; no Pro page is applied to the free feed", async () => {
    h.user = { id: "fx-user", email: "fixture@example.invalid" };
    h.isPro = true;
    const slow = deferred<GetJobsResult>();
    h.transport = async ({ page: p, isPro }) => {
      if (!isPro) return page(jobs(range(301, 325)).map((j) => ({ ...j })), p === 1);
      return p === 1 ? page(jobs(range(1, 25)), true) : slow.promise;
    };
    await mount("/jobs", false);
    await waitFor(() => expect(h.calls.some((c) => c.isPro && c.page === 2)).toBe(true));
    const proSignal = h.calls.find((c) => c.isPro && c.page === 2)!.signal as AbortSignal;
    const before = h.calls.length;
    h.isPro = false;
    await act(async () => window.dispatchEvent(new Event("careermonke_pro_updated")));
    await waitFor(() => expect(h.calls.slice(before).some((c) => !c.isPro && c.page === 1)).toBe(true));
    expect(proSignal.aborted).toBe(true);
    await act(async () => slow.resolve(page(jobs(range(26, 50)), true)));
    await flush();
    expect(uniqueTitles().some((t) => /Fixture Analyst (2[6-9]|[34]\d|50)$/.test(t!))).toBe(false);
    // Every request after the change is a free-tier request, starting again from page 1.
    const after = h.calls.slice(before);
    expect(after.every((c) => !c.isPro)).toBe(true);
    expect(after[0].page).toBe(1);
  });

  it("Saved tab is isolated: no sentinel, no next-page request; back to Recommended restores the loaded list", async () => {
    h.user = { id: "fx-user", email: "fixture@example.invalid" };
    h.isPro = true;
    h.apps = [];
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 40)), false));
    await mount();
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

  it("opening a job and going Back keeps every loaded page without refetching", async () => {
    h.transport = endless;
    await mount();
    expect(uniqueTitles()).toHaveLength(75);
    const requests = pagesRequested().length;

    fireEvent.click(screen.getAllByRole("heading", { level: 2, name: "Fixture Analyst 40" })[0]);
    await flush();
    expect(window.location.search).toContain("id=fx-40");
    window.history.pushState(null, "", "/jobs");
    await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state: { scrollPos: 1234 } })));
    await flush();
    expect(uniqueTitles()).toHaveLength(75);
    expect(pagesRequested().length).toBe(requests);
  });

  it("a late callback from a replaced observer never repeats a loaded page or asks past the end", async () => {
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 30)), false));
    const stale = io.instances.filter((i) => !i.disconnected);
    await mount();
    expect(pagesRequested()).toEqual([1, 2]);
    await act(async () => {
      for (const inst of [...stale, ...io.instances]) inst.cb(inst.els.map((target) => ({ isIntersecting: true, target }) as any), {} as IntersectionObserver);
    });
    await flush();
    expect(pagesRequested()).toEqual([1, 2]);
    expect(uniqueTitles()).toHaveLength(30);
  });

  it("For You has no count, defaults to match and honors explicit Most recent on every page", async () => {
    h.transport = async ({ page: p }) => (p === 1 ? page(jobs(range(1, 25)), true) : page(jobs(range(26, 50)), false));
    await mount();
    expect(h.calls[0]?.sortBy).toBe("match");
    expect(screen.getAllByRole("button", { name: "For You" }).length).toBeGreaterThan(0);
    const sortButtons = screen.getAllByRole("button", { name: /Sort by Recommended:/ });
    fireEvent.click(sortButtons[0]);
    fireEvent.click(screen.getByRole("button", { name: "Most recent" }));
    await flush();
    const newest = h.calls.filter((c) => c.sortBy === "newest");
    expect(newest.map((c) => c.page)).toEqual([1, 2]);
  });

  it("desktop warms and refills the same way", async () => {
    h.desktop = true;
    h.transport = endless;
    await mount();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    await reach(2);
    expect(pagesRequested()).toEqual(range(1, 6));
  });
});
