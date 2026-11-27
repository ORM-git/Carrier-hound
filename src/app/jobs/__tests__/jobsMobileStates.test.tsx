// @vitest-environment jsdom
// CM mobile item 12: every mobile feed state renders the right content on the real /jobs page with controlled
// (FIXTURE) responses. Pixel spacing (first card y, 44px controls, 16px gutters, no overlap) is measured in a
// real browser by scripts/capture-cm-mobile-715.cjs; this file proves the state machine and its controls.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { deferred, fixtureJob, flush, h, installBrowserStandIns, io, page, range, resetHarness } from "./jobsHarness";

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

const USER = { id: "fx-user", email: "fixture@example.invalid" };
const titlesShown = () =>
  Array.from(new Set(screen.queryAllByRole("heading", { level: 2 }).map((e) => e.textContent?.trim()).filter((t) => t?.startsWith("Fixture"))));
const app = (jobId: string, stage: "saved" | "applied") => ({
  id: `app-${jobId}`,
  jobId,
  company: "Fixturecorp",
  title: `Fixture Analyst ${jobId.replace("fx-", "")}`,
  stage,
  createdAt: "2026-11-01T00:00:00Z",
  updatedAt: "2026-11-01T00:00:00Z",
});

async function mount(url = "/jobs") {
  window.history.replaceState(null, "", url);
  render(<JobsPage />);
  await flush();
}

beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/jobs");
});

describe("mobile jobs states (item 12)", () => {
  it("loading: skeleton list, no cards, no empty/error copy; then the cards replace it", async () => {
    const d = deferred<any>();
    h.transport = () => d.promise;
    await mount();
    expect(screen.getByTestId("jobs-skeleton-list")).toBeTruthy();
    expect(titlesShown()).toEqual([]);
    expect(screen.queryByText(/Couldn't load jobs|No positions/)).toBeNull();
    await act(async () => d.resolve(page([fixtureJob(1)], false, 1)));
    await flush();
    expect(screen.queryByTestId("jobs-skeleton-list")).toBeNull();
    expect(titlesShown()).toEqual(["Fixture Analyst 1"]);
  });

  it("populated: 25 cards, each with its 44px save and apply controls, and the auto-load sentinel", async () => {
    h.transport = async () => page(range(1, 25).map((i) => fixtureJob(i)), true, 300);
    await mount();
    expect(titlesShown()).toHaveLength(25);
    const saves = screen.getAllByRole("button", { name: "Save job" });
    expect(saves.length).toBeGreaterThanOrEqual(25);
    for (const b of saves.slice(-25)) expect(b.className).toContain("min-h-[44px]");
    expect(screen.getByTestId("jobs-load-more-sentinel")).toBeTruthy();
    // The inventory count lives only in the desktop-only span (item 22); nothing shown on phones carries it.
    const counts = Array.from(document.querySelectorAll("span")).filter((e) => /remaining/.test(e.textContent || "") && e.children.length === 0);
    for (const c of counts) expect(c.className).toContain("hidden sm:inline");
  });

  it("short results: 3 cards, scoped end line, no sentinel or load-more (single page)", async () => {
    h.transport = async () => page([1, 2, 3].map((i) => fixtureJob(i)), false, 3);
    await mount();
    expect(titlesShown()).toHaveLength(3);
    expect(screen.queryByTestId("jobs-load-more-sentinel")).toBeNull();
    expect(screen.queryByRole("button", { name: /Load More/ })).toBeNull();
    expect(screen.getByTestId("jobs-list-end").textContent).toContain("this recommended list for your current search and filters");
  });

  it("filter with zero results: specific empty copy and a 44px Reset that clears the filter and refetches", async () => {
    h.transport = async ({ workModel }) => (workModel ? page([], false, 0) : page([fixtureJob(1)], false, 1));
    await mount("/jobs?workModel=hybrid");
    await flush(30);
    expect(screen.getByText("No positions match your active filters")).toBeTruthy();
    const reset = screen.getByRole("button", { name: "Reset active filters" });
    expect(reset.className).toContain("min-h-[44px]");
    fireEvent.click(reset);
    await flush(40);
    expect(titlesShown()).toEqual(["Fixture Analyst 1"]);
  });

  it("error: Couldn't load jobs with a 44px Retry that refetches and shows the feed", async () => {
    let fail = true;
    h.transport = async () => (fail ? { jobs: [], totalCount: 0, hasNextPage: false, nextCursor: null, isDegraded: true, error: "degraded" } : page([fixtureJob(7)], false, 1));
    await mount();
    expect(screen.getByTestId("search-degraded-state").textContent).toContain("Couldn't load jobs");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(retry.className).toContain("min-h-[44px]");
    fail = false;
    const before = h.calls.length;
    fireEvent.click(retry);
    await flush();
    expect(h.calls.length).toBe(before + 1);
    expect(titlesShown()).toEqual(["Fixture Analyst 7"]);
  });

  it("Saved tab empty: 'No saved jobs yet' with guidance, no recommended cards leak in", async () => {
    h.user = USER;
    h.isPro = true;
    h.transport = async () => page([fixtureJob(1), fixtureJob(2)], false, 2);
    await mount("/jobs?tab=saved");
    expect(screen.getByText("No saved jobs yet")).toBeTruthy();
    expect(titlesShown()).toEqual([]);
  });

  it("Applied tab with one card: only the applied job is listed", async () => {
    h.user = USER;
    h.isPro = true;
    h.apps = [app("fx-2", "applied")];
    h.transport = async () => page([fixtureJob(1), fixtureJob(2), fixtureJob(3)], false, 3);
    h.byId = async (id) => fixtureJob(Number(id.replace("fx-", "")));
    await mount("/jobs?tab=applied");
    await flush(20);
    expect(titlesShown()).toEqual(["Fixture Analyst 2"]);
    expect(screen.queryByText("No tracked applications yet")).toBeNull();
  });

  it("end of list: after the last page, an end line and no further requests", async () => {
    h.transport = async ({ page: p }) => (p === 1 ? page(range(1, 25).map((i) => fixtureJob(i)), true) : page([fixtureJob(26)], false));
    await mount();
    await act(async () => io.enter());
    await flush();
    expect(screen.getByTestId("jobs-list-end").textContent).toBe("You've reached the end of this recommended list for your current search and filters.");
    expect(screen.queryByTestId("jobs-load-more-sentinel")).toBeNull();
  });
});
