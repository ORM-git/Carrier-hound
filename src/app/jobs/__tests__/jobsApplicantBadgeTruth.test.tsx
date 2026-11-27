// @vitest-environment jsdom
// Real jobs page with fixture data boundaries. Existing unknown-count fallback remains unchanged.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
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

import JobsPage from "@/app/jobs/page";

const USER = { id: "applicant-truth-user", email: "fixture@example.invalid" };
beforeAll(installBrowserStandIns);
beforeEach(() => { resetHarness(); localStorage.clear(); h.user = USER; h.isPro = true; });
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/jobs"); });

describe("Early applicant badge consumes the boolean eligibility result", () => {
  it.each([
    { hours: 2, count: 1000, visible: false },
    { hours: 2, count: 25, visible: true },
    { hours: 8, count: undefined, visible: false },
    { hours: 2, count: undefined, visible: true },
  ])("$hours h / $count applicants => badge $visible", async ({hours, count, visible}) => {
    const job = { ...fixtureJob(1), postedAt: new Date(Date.now() - hours * 3600e3).toISOString(), applicantCount: count };
    h.transport = async () => page([job], false, 1);
    window.history.replaceState(null, "", "/jobs");
    render(<JobsPage />);
    await flush();
    expect(screen.getAllByTestId("job-card")).toHaveLength(1);
    expect(screen.queryAllByText("Early applicant").length > 0).toBe(visible);
  });
});
