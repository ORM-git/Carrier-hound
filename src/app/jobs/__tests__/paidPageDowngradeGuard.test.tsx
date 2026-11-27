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
vi.mock("@/components/jobs/JobDetailView", () => ({ default: ({ job, isPro }: any) => <div data-testid="review-detail" data-score={JSON.stringify(job.matchScore)} data-pro={String(isPro)} /> }));
import JobsPage from "@/app/jobs/page";
beforeAll(installBrowserStandIns);
beforeEach(() => { resetHarness(); localStorage.clear(); sessionStorage.clear(); });
afterEach(cleanup);
describe("independent page memo entitlement", () => {
  it.each([false,true])("selected stale score is stripped for Free but retained for Pro: %s", async pro => {
    h.isPro = pro; h.user = { id: "review-user", email: "review@example.invalid" };
    h.transport = async () => page([fixtureJob(1, { matchScore: 87 })], false);
    window.history.replaceState(null, "", "/jobs"); render(<JobsPage />); await flush();
    fireEvent.click(screen.getAllByRole("heading", { name: "Fixture Analyst 1" })[0]); await flush();
    expect(screen.getByTestId("review-detail").getAttribute("data-score")).toBe(pro ? "87" : "null");
  });
  it("same selected detail loses stale cached score after subscription downgrade", async () => {
    h.isPro = true; h.user = { id: "review-user", email: "review@example.invalid" };
    h.transport = async () => page([fixtureJob(1, { matchScore: 87 })], false);
    window.history.replaceState(null, "", "/jobs"); render(<JobsPage />); await flush();
    fireEvent.click(screen.getAllByRole("heading", { name: "Fixture Analyst 1" })[0]); await flush();
    expect(screen.getByTestId("review-detail").getAttribute("data-score")).toBe("87");
    h.isPro = false;
    await act(async () => { window.dispatchEvent(new Event("careermonke_pro_updated")); }); await flush();
    expect(screen.getByTestId("review-detail").getAttribute("data-pro")).toBe("false");
    expect(screen.getByTestId("review-detail").getAttribute("data-score")).toBe("null");
  });

});
