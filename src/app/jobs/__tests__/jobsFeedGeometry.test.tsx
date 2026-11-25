// @vitest-environment jsdom
// /jobs look-ahead with a geometry-driven IntersectionObserver: like a browser, observers deliver an initial
// callback on observe() and new callbacks whenever layout (appends, re-ranking, scroll) changes an element's
// intersection. Later FIXTURE pages are newer, so the Recommended comparator ranks them ABOVE cards already
// shown. Background appends, re-ranking, observer recreation and anchoring must never count as reader
// progress, and the card the reader is looking at must not move.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { GetJobsResult, LiveJob } from "@/lib/jobs/service";
import { deferred, fixtureJob, flush, h, installBrowserStandIns, range, resetHarness } from "./jobsHarness";

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

// ---- geometry: cards stack in DOM order below a fixed header area; the viewport scrolls over them ----
const LIST_TOP = 300;
const CARD = 200;
const VIEWPORT = 800;
const geo = { y: 0 };
const cards = () => Array.from(document.querySelectorAll<HTMLElement>('[data-testid="job-card"]'));
// Card positions, cached for the duration of one delivery pass (layout does not change inside it).
let layoutCache: Map<Element, number> | null = null;
function layout(): Map<Element, number> {
  if (layoutCache) return layoutCache;
  const map = new Map<Element, number>();
  cards().forEach((c, i) => map.set(c, i));
  return map;
}
function docTop(el: Element): number | null {
  const map = layout();
  const i = map.get(el);
  if (i !== undefined) return LIST_TOP + i * CARD;
  if ((el as HTMLElement).dataset?.testid === "jobs-load-more-sentinel") return LIST_TOP + map.size * CARD;
  return null;
}
function rectOf(el: Element): DOMRect {
  const top = docTop(el);
  const t = top === null ? -100000 : top - geo.y;
  const height = top === null ? 0 : (el as HTMLElement).dataset?.testid === "job-card" ? CARD : 0;
  return { top: t, bottom: t + height, left: 0, right: 390, width: 390, height, x: 0, y: t, toJSON() {} } as DOMRect;
}

type Obs = { cb: IntersectionObserverCallback; margin: number; els: Map<Element, boolean | undefined>; dead: boolean };
const observers: Obs[] = [];
function intersects(el: Element, margin: number) {
  const r = rectOf(el);
  if (docTop(el) === null) return false;
  return r.bottom >= -margin && r.top <= VIEWPORT + margin && (r.height > 0 || (r.top >= -margin && r.top <= VIEWPORT + margin));
}
/** Delivers entries whose intersection changed since the last delivery (the first delivery is the initial one). */
function deliver() {
  layoutCache = layout();
  try {
    deliverPass();
  } finally {
    layoutCache = null;
  }
}
function deliverPass() {
  for (const o of observers) {
    if (o.dead) continue;
    const changed: IntersectionObserverEntry[] = [];
    for (const [el, prev] of Array.from(o.els)) {
      const now = intersects(el, o.margin);
      if (prev === now) continue;
      o.els.set(el, now);
      changed.push({ target: el, isIntersecting: now, boundingClientRect: rectOf(el), intersectionRatio: now ? 1 : 0 } as unknown as IntersectionObserverEntry);
    }
    if (changed.length) o.cb(changed, {} as IntersectionObserver);
  }
}
let scheduled = false;
function scheduleDeliver() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    deliver();
  }, 0);
}

function installGeometry() {
  class GeoIO {
    o: Obs;
    constructor(cb: IntersectionObserverCallback, opts?: IntersectionObserverInit) {
      const m = /(-?\d+)px/.exec(opts?.rootMargin ?? "");
      this.o = { cb, margin: m ? Number(m[1]) : 0, els: new Map(), dead: false };
      observers.push(this.o);
    }
    observe(el: Element) {
      this.o.els.set(el, undefined);
      scheduleDeliver(); // the browser always reports an initial state after observe()
    }
    unobserve(el: Element) {
      this.o.els.delete(el);
    }
    disconnect() {
      this.o.dead = true;
    }
    takeRecords() {
      return [];
    }
  }
  (globalThis as any).IntersectionObserver = GeoIO;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return rectOf(this);
  };
  Object.defineProperty(window, "innerHeight", { configurable: true, value: VIEWPORT });
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => geo.y });
  Object.defineProperty(window, "pageYOffset", { configurable: true, get: () => geo.y });
  window.scrollBy = ((x: number | ScrollToOptions, y?: number) => {
    geo.y = Math.max(0, geo.y + (typeof x === "object" ? (x.top ?? 0) : (y ?? 0)));
    scheduleDeliver();
  }) as typeof window.scrollBy;
  window.scrollTo = ((x: number | ScrollToOptions, y?: number) => {
    geo.y = Math.max(0, typeof x === "object" ? (x.top ?? geo.y) : (y ?? geo.y));
    scheduleDeliver();
  }) as typeof window.scrollTo;
  // Layout changes (appends, re-ranking, re-renders) re-evaluate intersections, as the browser does each frame.
  new MutationObserver(scheduleDeliver).observe(document.body, { childList: true, subtree: true, attributes: true });
}

/** The reader scrolls by `px` with real input (wheel), then layout settles. */
async function userScroll(px: number) {
  await act(async () => {
    window.dispatchEvent(new WheelEvent("wheel", { deltaY: px }));
    geo.y = Math.max(0, geo.y + px);
    window.dispatchEvent(new Event("scroll"));
    deliver();
  });
  await settle();
}
/** Lets timers, observers and React settle for a while without any reader input. */
async function settle(rounds = 6) {
  for (let k = 0; k < rounds; k++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    await flush(4);
  }
}
const pagesRequested = () => h.calls.map((c) => c.page);
/** The card under the reader's eye line (just below the header area): what the reader is looking at. */
const EYE_LINE = LIST_TOP + 100;
function anchor() {
  const el = cards().find((c) => rectOf(c).top <= EYE_LINE && rectOf(c).bottom > EYE_LINE);
  return el ? { title: el.querySelector("h2")?.textContent?.trim(), top: Math.round(rectOf(el).top) } : null;
}

const NOW = Date.now();
/** Later pages are NEWER, so the Recommended comparator places them above earlier cards. */
const job = (i: number): LiveJob => fixtureJob(i, { postedAt: new Date(NOW - (100000 - i) * 60_000).toISOString(), date: new Date(NOW - (100000 - i) * 60_000).toISOString() });
// Finite (12 pages) so a runaway loop fails fast instead of timing out.
const pageOf = (p: number, hasNextPage = p < 12): GetJobsResult => ({ jobs: range((p - 1) * 25 + 1, p * 25).map(job), totalCount: 1000, hasNextPage, nextCursor: null });

async function mount() {
  window.history.replaceState(null, "", "/jobs");
  const view = render(<JobsPage />);
  await flush();
  await settle();
  return view;
}

beforeAll(() => {
  installBrowserStandIns();
  installGeometry();
});
beforeEach(() => {
  resetHarness();
  observers.length = 0;
  geo.y = 0;
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
});
vi.setConfig({ testTimeout: 180000 });

describe("look-ahead with browser-like observers and re-ranked appends", () => {
  it("a stationary reader at the top warms only pages 1-3 and keeps looking at the same card", async () => {
    const p2 = deferred<GetJobsResult>();
    h.transport = async ({ page: p }) => (p === 2 ? p2.promise : pageOf(p));
    await mount();
    // Page 1 is visible while page 2 is pending.
    expect(pagesRequested()).toEqual([1, 2]);
    expect(cards()).toHaveLength(25);
    const before = anchor();
    expect(before?.title).toBe("Fixture Analyst 25"); // newest of page 1 ranks first
    await act(async () => p2.resolve(pageOf(2)));
    await settle(8);
    expect(cards().length).toBeGreaterThanOrEqual(75);
    expect(pagesRequested()).toEqual([1, 2, 3]);
    // Re-ranked page-2/3 cards were inserted above, but the reader's card did not move.
    expect(anchor()).toEqual(before);
    await settle(8);
    expect(pagesRequested()).toEqual([1, 2, 3]);
  });

  it("a reader paused mid-list keeps the same card and triggers nothing while pages 2-3 arrive above", async () => {
    const p2 = deferred<GetJobsResult>();
    h.transport = async ({ page: p }) => (p === 2 ? p2.promise : pageOf(p));
    await mount();
    await userScroll(CARD * 8); // reading page 1, card 9 at the top
    const before = anchor();
    expect(pagesRequested()).toEqual([1, 2]);
    await act(async () => p2.resolve(pageOf(2)));
    await settle(8);
    expect(pagesRequested()).toEqual([1, 2, 3]);
    expect(anchor()).toEqual(before);
    await settle(8);
    expect(pagesRequested()).toEqual([1, 2, 3]);
  });

  it("a genuine crossing past a rendered page requests 4-6 once, and appends never move the reader's card", async () => {
    h.transport = async ({ page: p }) => pageOf(p);
    await mount();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    // Read through the first rendered page (25 cards), one viewport at a time.
    let crossedAt = -1;
    for (let step = 0; step < 12 && crossedAt < 0; step++) {
      const before = anchor();
      await userScroll(VIEWPORT - CARD);
      if (pagesRequested().length > 3) crossedAt = step;
      else expect(anchor()?.title).not.toBe(before?.title); // normal scrolling moves on
    }
    expect(crossedAt).toBeGreaterThan(0);
    await settle(8);
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
    const held = anchor();
    await settle(8);
    expect(anchor()).toEqual(held);
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("server-ordered pages (appended below the reader)", () => {
  it("reading past one rendered page refills 4-6 once, well before the tail, with no gesture at the tail", async () => {
    h.transport = async ({ page: p }) => ({ jobs: range((p - 1) * 25 + 1, p * 25).map((i) => fixtureJob(i)), totalCount: 1000, hasNextPage: p < 12, nextCursor: null });
    await mount();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    const tailTop = () => LIST_TOP + cards().length * CARD;
    let distanceToTail = Infinity;
    for (let step = 0; step < 40 && pagesRequested().length === 3; step++) {
      await act(async () => {
        geo.y += CARD; // scrollbar drag: no wheel/touch/key gesture, so the tail sentinel cannot fire
        window.dispatchEvent(new Event("scroll"));
        deliver();
      });
      await settle(2);
      distanceToTail = tailTop() - (geo.y + VIEWPORT);
    }
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
    // The refill came from cards seen (just past card 25), two full pages before the tail.
    expect(distanceToTail).toBeGreaterThan(40 * CARD);
    // Card 26 (first of page 2) is on screen; the reader's eye is still around the end of page 1.
    expect(anchor()?.title).toMatch(/^Fixture Analyst 2\d$/);
    const held = anchor();
    await settle(8);
    expect(anchor()).toEqual(held);
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe("anchor correction lifecycle", () => {
  it("cancels the pending animation frames of the anchor correction on unmount", async () => {
    const pending = new Set<number>();
    let nextId = 900000;
    const rafSpy = vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => {
      pending.add(++nextId); // never fires, so the correction's frames are still pending at unmount
      return nextId;
    });
    const cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id: number) => {
      pending.delete(id);
    });
    try {
      const p2 = deferred<GetJobsResult>();
      h.transport = async ({ page: p }) => (p === 2 ? p2.promise : pageOf(p));
      const view = await mount();
      await act(async () => p2.resolve(pageOf(2)));
      await settle(8);
      expect(pending.size).toBeGreaterThan(0); // the re-ranked append scheduled the flag reset
      view.unmount();
      expect(Array.from(pending)).toEqual([]);
    } finally {
      rafSpy.mockRestore();
      cancelSpy.mockRestore();
    }
  });
});

describe("scrollbar jump across a rendered page", () => {
  it("jumping straight to card 26 (no cards seen in between) refills 4-6 once", async () => {
    h.transport = async ({ page: p }) => ({ jobs: range((p - 1) * 25 + 1, p * 25).map((i) => fixtureJob(i)), totalCount: 1000, hasNextPage: p < 12, nextCursor: null });
    await mount();
    expect(pagesRequested()).toEqual([1, 2, 3]);
    await act(async () => {
      window.dispatchEvent(new MouseEvent("mousedown")); // pressing the scrollbar
      geo.y = 25 * CARD; // scrollbar drag straight to card 26
      window.dispatchEvent(new Event("scroll"));
      deliver();
    });
    await settle(8);
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
    await settle(8);
    expect(pagesRequested()).toEqual([1, 2, 3, 4, 5, 6]);
  });
  it("without any reader scrolling, a layout-only position change never counts as a jump", async () => {
    h.transport = async ({ page: p }) => ({ jobs: range((p - 1) * 25 + 1, p * 25).map((i) => fixtureJob(i)), totalCount: 1000, hasNextPage: p < 12, nextCursor: null });
    await mount();
    await settle(10);
    expect(pagesRequested()).toEqual([1, 2, 3]);
  });
});

describe("zero visible jobs: an empty continuation start never hides recovery", () => {
  const empty = (cursor: string | null, hasNextPage = true): GetJobsResult => ({ jobs: [], totalCount: 0, hasNextPage, nextCursor: cursor });
  it.each([
    ["a thrown request", () => Promise.reject(new Error("network down")), "Retry"],
    ["a degraded response", async () => ({ jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null, isDegraded: true, error: "degraded" }) as GetJobsResult, "Retry"],
    ["a stalled cursor", async () => empty("c1"), "Load More Verified Positions"],
  ])("followed by %s shows a usable recovery control", async (_name, after, label) => {
    h.transport = async ({ page: p }) => (p === 1 ? empty("c1") : after());
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: label })).toBeTruthy());
    const before = pagesRequested().length;
    await act(async () => screen.getByRole("button", { name: label }).click());
    await settle();
    expect(pagesRequested().length).toBeGreaterThan(before);
  });
});
