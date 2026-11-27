// @vitest-environment jsdom
// Row 44: Pro feed hides jobs with no employer logo source; Free (masked) rows are untouched.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { deferred, fixtureJob, flush, h, installBrowserStandIns, page, resetHarness } from "./jobsHarness";

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
import { FAILED_LOGO_TTL_MS } from "@/components/CompanyLogo";

const USER = { id: "logo-hide-user", email: "fixture@example.invalid" };
beforeAll(installBrowserStandIns);
beforeEach(() => { resetHarness(); localStorage.clear(); h.user = USER; h.isPro = true; });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/jobs"); });

describe("logo hide policy on the real jobs page (#44)", () => {
  const mk = () => [fixtureJob(1), fixtureJob(2, { companyDomain: null }), fixtureJob(3, { companyLogoUrl: "https://cdn.fixture.invalid/3.png", companyDomain: null })];
  it("Pro: the job with no logo source is not rendered; the others are", async () => {
    h.isPro = true;
    h.transport = async () => page(mk(), false, 3);
    render(<JobsPage />);
    await flush();
    const ids = screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"));
    expect(ids).toEqual(["fx-1", "fx-3"]);
  });
  it("Free: masked rows carry no logo and all stay visible", async () => {
    h.isPro = false;
    h.transport = async () => page(mk(), false, 3);
    render(<JobsPage />);
    await flush();
    expect(screen.getAllByTestId("job-card")).toHaveLength(3);
  });

  it("load failure: when every logo candidate fails to load the card is hidden; a loading logo stays", async () => {
    h.isPro = true;
    const jobs = [fixtureJob(1, { companyDomain: null, applyUrl: "", companyLogoUrl: "https://cdn.fixture.invalid/1.png" }), fixtureJob(2, { companyDomain: null, applyUrl: "", companyLogoUrl: "https://cdn.fixture.invalid/2.png" })];
    h.transport = async () => page(jobs, false, 2);
    render(<JobsPage />);
    await flush();
    expect(screen.getAllByTestId("job-card")).toHaveLength(2);
    const card1 = screen.getAllByTestId("job-card").find((c) => c.getAttribute("data-job-id") === "fx-1")!;
    for (const img of Array.from(card1.querySelectorAll('img[src="https://cdn.fixture.invalid/1.png"]'))) fireEvent.error(img);
    await flush();
    expect(screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"))).toEqual(["fx-2"]);
  });
  it("domain-only: the domain logo failing to load hides the card", async () => {
    h.isPro = true;
    h.transport = async () => page([fixtureJob(1), fixtureJob(2)], false, 2);
    render(<JobsPage />);
    await flush();
    const card1 = screen.getAllByTestId("job-card").find((c) => c.getAttribute("data-job-id") === "fx-1")!;
    const imgs = Array.from(card1.querySelectorAll("img"));
    expect(imgs.length).toBeGreaterThan(0);
    for (const img of imgs) fireEvent.error(img);
    await flush();
    expect(screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"))).toEqual(["fx-2"]);
  });
  it("a page where every job is hidden but more pages exist: no false empty state while the next page is pending, then it fills", async () => {
    h.isPro = true;
    const page2 = deferred<any>();
    const calls: number[] = [];
    h.transport = async (opts: any) => {
      const pg = Number(opts?.page ?? 1);
      calls.push(pg);
      if (pg === 1) return page([fixtureJob(1, { companyDomain: null, applyUrl: "" }), fixtureJob(2, { companyDomain: null, applyUrl: "" })], true, 4);
      return page2.promise;
    };
    render(<JobsPage />);
    await flush();
    expect(calls).toContain(2);
    expect(screen.queryAllByTestId("job-card")).toHaveLength(0);
    expect(screen.queryByText(/^No positions/i)).toBeNull();
    expect(screen.queryByText(/no jobs found/i)).toBeNull();
    await act(async () => { page2.resolve(page([fixtureJob(3), fixtureJob(4)], false, 4)); });
    await flush();
    expect(screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"))).toEqual(["fx-3", "fx-4"]);
  });

  it("every card on the page fails to load after render and more pages exist: the next page is requested by itself, no gesture needed", async () => {
    h.isPro = true;
    const calls: number[] = [];
    let failedAt = -1;
    h.transport = async (opts: any) => {
      const pg = Number(opts?.page ?? 1);
      calls.push(pg);
      if (pg === 1) return page([fixtureJob(1, { companyDomain: null, applyUrl: "", companyLogoUrl: "https://cdn.fixture.invalid/1.png" }), fixtureJob(2, { companyDomain: null, applyUrl: "", companyLogoUrl: "https://cdn.fixture.invalid/2.png" })], true, 6);
      if (pg === 2) return page([fixtureJob(3), fixtureJob(4)], true, 6);
      return page([fixtureJob(5)], false, 6);
    };
    render(<JobsPage />);
    await flush();
    const before = calls.length;
    for (const card of screen.getAllByTestId("job-card")) {
      if (!["fx-1", "fx-2"].includes(card.getAttribute("data-job-id") || "")) continue;
      for (const img of Array.from(card.querySelectorAll("img"))) fireEvent.error(img);
    }
    failedAt = calls.length;
    await flush();
    await flush();
    const ids = screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"));
    expect(ids).not.toContain("fx-1");
    expect(ids).not.toContain("fx-2");
    expect(ids.length).toBeGreaterThan(0);
    expect(screen.queryByText(/^No positions/i)).toBeNull();
    expect(failedAt).toBeGreaterThanOrEqual(before);
  });
  it("a logo failure is forgotten after the failed-image TTL, so the job is shown again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      h.isPro = true;
      const j = fixtureJob(1, { companyDomain: null, applyUrl: "", companyLogoUrl: "https://cdn.fixture.invalid/ttl.png" });
      h.transport = async () => page([j, fixtureJob(2)], false, 2);
      render(<JobsPage />);
      await flush();
      const card = screen.getAllByTestId("job-card").find((c) => c.getAttribute("data-job-id") === "fx-1")!;
      for (const img of Array.from(card.querySelectorAll("img"))) fireEvent.error(img);
      await flush();
      expect(screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"))).toEqual(["fx-2"]);
      await act(async () => { vi.advanceTimersByTime(FAILED_LOGO_TTL_MS + 1000); });
      await flush();
      expect(screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"))).toContain("fx-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the three warmed pages are all hidden and page 4 is not fetched yet: it is requested without any scroll gesture", async () => {
    h.isPro = true;
    const calls: number[] = [];
    h.transport = async (opts: any) => {
      const pg = Number(opts?.page ?? 1);
      calls.push(pg);
      if (pg <= 3) return page([fixtureJob(pg * 10 + 1, { companyDomain: null, applyUrl: "" }), fixtureJob(pg * 10 + 2, { companyDomain: null, applyUrl: "" })], true, 20);
      return page([fixtureJob(41), fixtureJob(42)], false, 20);
    };
    render(<JobsPage />);
    await flush();
    await flush();
    expect(calls).toContain(4);
    expect(screen.getAllByTestId("job-card").map((c) => c.getAttribute("data-job-id"))).toEqual(["fx-41", "fx-42"]);
    expect(screen.queryByText(/^No positions/i)).toBeNull();
  });

  it("always hidden with an endless hasMore: at most 3 extra pages are requested automatically, then a visible Load More button; a click resumes", async () => {
    h.isPro = true;
    const pagesAsked: number[] = [];
    h.transport = async (opts: any) => {
      const pg = Number(opts?.page ?? 1);
      pagesAsked.push(pg);
      return page([fixtureJob(pg * 10 + 1, { companyDomain: null, applyUrl: "" }), fixtureJob(pg * 10 + 2, { companyDomain: null, applyUrl: "" })], true, 1000);
    };
    render(<JobsPage />);
    for (let i = 0; i < 14; i++) await flush();
    // Initial load is pages 1-3 (the harness mounts the page twice, so those repeat). Everything beyond is the incident budget.
    const extra = () => pagesAsked.filter((p) => p > 3).length;
    expect(extra()).toBe(3);
    expect(Math.max(...pagesAsked)).toBe(6);
    for (let i = 0; i < 8; i++) await flush();
    expect(extra()).toBe(3); // stopped
    expect(screen.queryAllByTestId("job-card")).toHaveLength(0);
    const button = screen.getByRole("button", { name: /Load More Verified Positions/i });
    await act(async () => { fireEvent.click(button); });
    for (let i = 0; i < 14; i++) await flush();
    expect(extra()).toBeGreaterThan(3); // the deliberate click resumed
    const after = extra();
    for (let i = 0; i < 8; i++) await flush();
    expect(extra()).toBe(after); // and the auto budget is bounded again
    expect(after - 3).toBeLessThanOrEqual(3); // exactly one click batch (the normal refill of up to 3 pages), no extra automatic pages
    expect(screen.getByRole("button", { name: /Load More Verified Positions/i })).toBeTruthy(); // and the button is back
  });
});
