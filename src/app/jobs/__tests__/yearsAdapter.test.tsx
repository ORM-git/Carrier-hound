// @vitest-environment jsdom
// Years / list-filter adapter on the real /jobs page (FIXTURE transport, not live): refetch from page 1, capability gate,
// URL round trip, tab scope.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fixtureJob, flush, h, installBrowserStandIns, page, resetHarness } from "./jobsHarness";

vi.mock("@/lib/jobs/service", async () => (await import("./jobsHarness")).jobsServiceMock());
vi.mock("@/lib/auth/session", async () => (await import("./jobsHarness")).sessionMock());
vi.mock("@/lib/billing/subscription", async () => (await import("./jobsHarness")).billingMock());
vi.mock("@/lib/tracker/storage", async () => (await import("./jobsHarness")).trackerMock());
vi.mock("@/lib/resume/storage", async () => (await import("./jobsHarness")).resumeStorageMock());
vi.mock("next/navigation", async () => (await import("./jobsHarness")).navigationMock());
vi.mock("@/lib/analytics/funnel", async () => (await import("./jobsHarness")).funnelMock());
vi.mock("@/lib/supabase/client", async () => (await import("./jobsHarness")).supabaseClientMock());
vi.mock("react-toastify", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));

let applyPayload: any = {};
vi.mock("@/components/jobs/AllFiltersDrawer", () => ({ default: (p: any) => p.isOpen ? <button onClick={() => p.onApply({ ...p.filters, ...applyPayload })}>Review Apply</button> : null }));
import JobsPage from "@/app/jobs/page";

const JOBS = [
  fixtureJob(1, { type: "full-time", remote: true, location: "Remote" }),
  fixtureJob(2, { type: "contract", remote: false, location: "Austin, TX (Hybrid)", remoteScope: "hybrid" }),
  fixtureJob(3, { type: "part-time", remote: false, location: "Austin, TX" }),
  fixtureJob(4, { type: "Full_Time", remote: false, location: "Pune", remoteScope: "hybrid" }),
  fixtureJob(5, { type: "contractor", remote: true, location: "Remote - US" }),
];
const last = () => h.calls[h.calls.length - 1];

async function mount(url: string) {
  window.history.replaceState(null, "", url);
  const view = render(<JobsPage />);
  await flush();
  return view;
}
beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness();
  h.desktop = true;
  localStorage.clear();
  sessionStorage.clear();
  h.transport = async () => page(JOBS, false, JOBS.length);
});
afterEach(() => {
  vi.unstubAllEnvs();
  cleanup();
  window.history.replaceState(null, "", "/jobs");
});


let capReady = true;
beforeEach(() => {
  capReady = true;
  vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
  vi.stubGlobal("fetch", vi.fn(async (u: any) => String(u).includes("/api/jobs/capabilities")
    ? new Response(JSON.stringify({ requiredYearsFilter: capReady }), { status: 200 })
    : new Response("{}", { status: 404 })));
});
const apply = async (payload: any) => {
  applyPayload = payload;
  fireEvent.click(screen.getByRole("button", { name: "Open all filters drawer" }));
  fireEvent.click(screen.getByRole("button", { name: "Review Apply" }));
  await flush();
};

describe("years and list filters adapter on the page", () => {
  it("a years-only Confirm refetches page 1 with the range and no old cursor", async () => {
    await mount("/jobs");
    const before = h.calls.length;
    await apply({ requiredYears: { mode: "range", min: 2, max: 4 } });
    expect(h.calls.length).toBeGreaterThan(before);
    expect(last().requiredYears).toEqual({ mode: "range", min: 2, max: 4 });
    expect(last().cursor ?? null).toBeNull();
    expect(last().page).toBe(1);
  });
  it("explicit Any and inherit are distinct requests", async () => {
    await mount("/jobs");
    await apply({ requiredYears: { mode: "any" } });
    expect(last().requiredYears).toEqual({ mode: "any" });
    await apply({ requiredYears: { mode: "inherit" } });
    expect(last().requiredYears).toEqual({ mode: "inherit" });
  });
  it("a list-only change (excluded titles) refetches too", async () => {
    await mount("/jobs");
    const before = h.calls.length;
    await apply({ excludedTitles: ["Intern"] });
    expect(h.calls.length).toBeGreaterThan(before);
    expect(last().excludedTitles).toEqual(["Intern"]);
  });
  it("server not ready: years are never sent", async () => {
    capReady = false;
    await mount("/jobs");
    await apply({ requiredYears: { mode: "range", min: 2, max: 4 } });
    expect(h.calls.every((c) => !c.requiredYears || c.requiredYears.mode === "inherit")).toBe(true);
  });
  it("URL years= is read on load, sent, and written back", async () => {
    await mount("/jobs?years=2-5");
    expect(last().requiredYears).toEqual({ mode: "range", min: 2, max: 5 });
    // sync keeps the same URL (no replace that drops years)
    expect(h.router.replace.mock.calls.every((c: any[]) => String(c[0]).includes("years=2-5"))).toBe(true);
    await apply({ requiredYears: { mode: "any" } });
    expect(h.router.replace.mock.calls.some((c: any[]) => String(c[0]).includes("years=any"))).toBe(true);
  });
  it("URL years=any is explicit Any; junk is inherit", async () => {
    await mount("/jobs?years=any");
    expect(last().requiredYears).toEqual({ mode: "any" });
    cleanup();
    await mount("/jobs?years=abc");
    expect(last().requiredYears).toEqual({ mode: "inherit" });
  });

  it("this bundle's own gate off: a server-true capability is not enough, nothing is sent", async () => {
    vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "false");
    await mount("/jobs");
    await apply({ requiredYears: { mode: "range", min: 2, max: 4 } });
    expect(h.calls.every((c) => !c.requiredYears || c.requiredYears.mode === "inherit")).toBe(true);
  });
  it("a years change aborts the old first-page request and the new one starts at page 1 with no cursor", async () => {
    await mount("/jobs");
    const prior = last();
    let release: (v: any) => void = () => {};
    h.transport = (o: any) => new Promise((res) => { release = res; void o; });
    await apply({ requiredYears: { mode: "range", min: 1, max: 2 } });
    const inflight = last();
    await apply({ requiredYears: { mode: "range", min: 3, max: 6 } });
    expect(inflight.signal?.aborted).toBe(true);
    expect(last().requiredYears).toEqual({ mode: "range", min: 3, max: 6 });
    expect(last().page).toBe(1);
    expect(last().cursor ?? null).toBeNull();
    expect(prior).toBeTruthy();
    release(page(JOBS, false, JOBS.length));
  });
  it("a failed readiness refresh at Confirm blocks the years choice (fail closed)", async () => {
    await mount("/jobs");
    capReady = false;
    await apply({ requiredYears: { mode: "range", min: 2, max: 4 } });
    expect(h.calls.every((c) => !c.requiredYears || c.requiredYears.mode === "inherit")).toBe(true);
  });
  it("saved tab never carries an explicit range", async () => {
    await mount("/jobs?years=2-5&tab=saved");
    expect(h.calls.every((c) => !c.requiredYears || c.requiredYears.mode === "inherit")).toBe(true);
  });
  it("popstate restores range, any and open upper bound, and a bad value is inherit", async () => {
    await mount("/jobs");
    const go = async (qs: string) => { window.history.replaceState(null, "", "/jobs" + qs); await act(async () => { window.dispatchEvent(new PopStateEvent("popstate")); }); await flush(); };
    await go("?years=2-");
    expect(last().requiredYears).toEqual({ mode: "range", min: 2, max: null });
    await go("?years=any");
    expect(last().requiredYears).toEqual({ mode: "any" });
    await go("?years=3-4");
    expect(last().requiredYears).toEqual({ mode: "range", min: 3, max: 4 });
    await go("?years=zzz");
    expect(last().requiredYears).toEqual({ mode: "inherit" });
  });
});
