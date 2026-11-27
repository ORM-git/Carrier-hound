// @vitest-environment jsdom
// Real page transitions with fixture transport, deterministic browser scroll, and a detail DOM marker.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("@/components/jobs/JobDetailView", () => ({ default: ({ job, onBack, onSelectJob }: any) => <section data-testid="detail-dom" data-id={job.id}><h2>{job.title}</h2><button onClick={onBack}>Fixture Back</button><button onClick={() => onSelectJob(fixtureJob(2))}>Fixture Similar</button></section> }));
import JobsPage from "@/app/jobs/page";
let y = 0;
let calls: { top: number; detail: string | null }[] = [];
beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness(); localStorage.clear(); sessionStorage.clear(); y = 0; calls = [];
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => y });
  window.scrollTo = ((x: number | ScrollToOptions, top?: number) => {
    y = typeof x === "object" ? x.top ?? y : top ?? 0;
    calls.push({ top: y, detail: document.querySelector('[data-testid="detail-dom"]')?.getAttribute("data-id") ?? null });
  }) as typeof window.scrollTo;
  h.transport = async () => page([fixtureJob(1), fixtureJob(2)], false);
});
afterEach(cleanup);
async function mount(url = "/jobs") {
  window.history.replaceState(null, "", url); render(<JobsPage />); await flush();
}
async function open() {
  await waitFor(() => expect(document.querySelector('[data-testid="job-card"]')).toBeTruthy());
  y = 1100;
  fireEvent.click(screen.getAllByRole("heading", { name: "Fixture Analyst 1" })[0]);
  await flush();
  expect(y).toBe(0);
  expect(calls.some(c => c.top === 0 && c.detail === "fx-1")).toBe(true);
}
async function pop(url: string, state: any) {
  window.history.replaceState(state, "", url);
  await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state })));
  await flush();
  await act(async () => await new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
}
describe("detail entry scroll belongs to the committed detail identity", () => {
  it.each([false, true])("opens at top after DOM swap and UI Back restores list offset, desktop=%s", async desktop => {
    h.desktop = desktop; await mount(); await open();
    expect(window.history.state.scrollPos).toBe(1100);
    y = 400; fireEvent.click(screen.getByRole("button", { name: "Fixture Back" }));
    await flush(); await act(async () => await new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(y).toBe(1100); expect(window.location.search).not.toContain("id=");
  });
  it("browser Back restores list position; Forward re-enters detail at top", async () => {
    await mount(); await open();
    await pop("/jobs", null); expect(y).toBe(1100);
    await pop("/jobs?id=fx-1", { jobId: "fx-1", scrollPos: 1100 }); expect(y).toBe(0);
    expect(screen.getByTestId("detail-dom").getAttribute("data-id")).toBe("fx-1");
  });
  it("direct-link async resolution resets at committed detail, Back defaults to list top", async () => {
    const result = deferred<any>(); h.byId = () => result.promise;
    y = 1100; await mount("/jobs?id=fx-9");
    await act(async () => result.resolve(fixtureJob(9))); await flush();
    expect(y).toBe(0); expect(calls.some(c => c.top === 0 && c.detail === "fx-9")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Fixture Back" }));
    await flush(); await act(async () => await new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    expect(y).toBe(0);
  });
  it("same-job enrichment keeps reader scroll, another detail identity resets", async () => {
    const result = deferred<any>(); h.byId = () => result.promise;
    await mount(); await open(); y = 350; const before = calls.length;
    await act(async () => result.resolve(fixtureJob(1, { description: "Full description repeated. ".repeat(10) })));
    await flush(); expect(y).toBe(350); expect(calls.length).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: "Fixture Similar" })); await flush();
    expect(y).toBe(0); expect(calls.some(c => c.top === 0 && c.detail === "fx-2")).toBe(true);
  });
});
