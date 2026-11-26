// @vitest-environment jsdom
// The real /jobs page driving the REAL getLiveJobs over a FIXTURE jobs_public (resume path, no network):
// the page's own cursor chain must reach the eligible row 251 and then show an honest end.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { flush, h, installBrowserStandIns, resetHarness } from "./jobsHarness";
import * as F from "@/lib/jobs/__tests__/fixtures/fakeJobsPublic";

vi.mock("@/lib/jobs/service", async () => (await import("./jobsHarness")).jobsServiceMock());
vi.mock("@/lib/auth/session", async () => (await import("./jobsHarness")).sessionMock());
vi.mock("@/lib/billing/subscription", async () => (await import("./jobsHarness")).billingMock());
vi.mock("@/lib/tracker/storage", async () => (await import("./jobsHarness")).trackerMock());
vi.mock("next/navigation", async () => (await import("./jobsHarness")).navigationMock());
vi.mock("@/lib/analytics/funnel", async () => (await import("./jobsHarness")).funnelMock());
vi.mock("react-toastify", () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("@/lib/resume/storage", async () => {
  const actual = await vi.importActual<typeof import("@/lib/resume/storage")>("@/lib/resume/storage");
  const { CANDIDATE } = await import("@/lib/jobs/__tests__/fixtures/fakeJobsPublic");
  return { ...actual, getCandidateProfile: async () => ({ ...CANDIDATE, confirmedAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z" }) };
});
vi.mock("@/lib/supabase/client", async () => {
  const { table } = await import("@/lib/jobs/__tests__/fixtures/fakeJobsPublic");
  return {
    createClient: () => ({
      auth: {
        getSession: async () => ({ data: { session: null }, error: null }),
        getUser: async () => ({ data: { user: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      from: () => table(),
    }),
  };
});

import JobsPage from "@/app/jobs/page";

const shownIds = () => Array.from(new Set(Array.from(document.querySelectorAll("[data-job-id]")).map((el) => el.getAttribute("data-job-id"))));

vi.setConfig({ testTimeout: 60000 });
beforeAll(installBrowserStandIns);
beforeEach(async () => {
  resetHarness();
  F.resetDb();
  localStorage.clear();
  sessionStorage.clear();
  const { getLiveJobs } = await vi.importActual<typeof import("@/lib/jobs/service")>("@/lib/jobs/service");
  h.transport = (opts) => getLiveJobs(opts);
  h.user = { id: "fixture-user", email: "fixture@example.invalid" };
  h.prefs = F.PREFS;
});
afterEach(cleanup);

describe("For You resume feed continues past the first 250 raw rows on the real page", () => {
  it("251-row counterexample: page 1 shows 25, the chain follows the cs1 cursor to row 251, then the end", async () => {
    F.db.rows = F.rows251();
    window.history.replaceState(null, "", "/jobs");
    render(<JobsPage />);
    await flush();
    await waitFor(() => expect(screen.queryByTestId("jobs-list-end")).not.toBeNull(), { timeout: 20000 });
    const recommended = h.calls.filter((c) => c.sortBy === "match" && c.candidate);
    expect(recommended.map((c) => [c.page, typeof c.cursor === "string" && c.cursor.startsWith("cs1.")])).toEqual([[1, false], [2, true]]);
    const ids = shownIds();
    expect(ids).toHaveLength(26);
    expect(ids).toContain(F.junior(251).id);
  });
});
