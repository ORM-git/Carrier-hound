// @vitest-environment jsdom
// The real /jobs page driving the REAL getLiveJobs over a FIXTURE jobs_public (resume path, no network):
// the page's own cursor chain must reach rows past the first 250, restart cleanly on a refused continuation,
// and show an honest end.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  const { table, getSession } = await import("@/lib/jobs/__tests__/fixtures/fakeJobsPublic");
  return {
    createClient: () => ({
      auth: {
        getSession,
        getUser: async () => ({ data: { user: null }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      },
      from: () => table(),
    }),
  };
});

import JobsPage from "@/app/jobs/page";

const shownIds = () => Array.from(new Set(Array.from(document.querySelectorAll("[data-job-id]")).map((el) => el.getAttribute("data-job-id"))));
const scanCalls = () => h.calls.filter((c) => c.sortBy === "match" && c.candidate);
const isScanCursor = (c: unknown) => typeof c === "string" && c.startsWith("cs1.");
const endShown = () => waitFor(() => expect(screen.queryByTestId("jobs-list-end")).not.toBeNull(), { timeout: 30000 });

vi.setConfig({ testTimeout: 90000 });
let getLiveJobs: typeof import("@/lib/jobs/service").getLiveJobs;
beforeAll(async () => {
  installBrowserStandIns();
  ({ getLiveJobs } = await vi.importActual<typeof import("@/lib/jobs/service")>("@/lib/jobs/service"));
});
beforeEach(() => {
  resetHarness();
  F.resetDb();
  localStorage.clear();
  sessionStorage.clear();
  h.transport = (opts) => getLiveJobs(opts);
  h.user = { id: "fixture-user", email: "fixture@example.invalid" };
  h.prefs = F.PREFS;
});
afterEach(cleanup);

async function mount() {
  window.history.replaceState(null, "", "/jobs");
  render(<JobsPage />);
  await flush();
}

describe("For You resume feed continues past the first 250 raw rows on the real page", () => {
  it("251-row counterexample: page 1 shows 25, the chain follows the cs1 cursor to row 251, then the end", async () => {
    F.db.rows = F.rows251();
    await mount();
    await endShown();
    expect(scanCalls().map((c) => [c.page, isScanCursor(c.cursor)])).toEqual([[1, false], [2, true]]);
    const ids = shownIds();
    expect(ids).toHaveLength(26);
    expect(ids).toContain(F.junior(251).id);
  });

  it("a page-2 continuation refused after a session change restarts at page 1: the new top rows are shown, none skipped", async () => {
    F.db.rows = F.rows251();
    // 30 newer eligible rows arrive together with a new sign-in, between page 1 and page 2.
    const fresh = Array.from({ length: 30 }, (_, k) => F.junior(-(k + 1)));
    let flipped = false;
    h.transport = (opts) => {
      if (opts.page === 2 && isScanCursor(opts.cursor) && !flipped) {
        flipped = true;
        F.db.session = { access_token: "t2", user: { id: "viewer-a", last_sign_in_at: "2026-11-26T09:00:00Z" } };
        F.db.rows = [...fresh, ...F.db.rows];
      }
      return getLiveJobs(opts);
    };
    await mount();
    await endShown();
    const calls = scanCalls().map((c) => [c.page, isScanCursor(c.cursor)]);
    expect(calls.slice(0, 3)).toEqual([[1, false], [2, true], [1, false]]); // refused page 2, then a clean restart
    const ids = shownIds();
    for (const r of fresh) expect(ids).toContain(r.id); // page arithmetic would have skipped the new top 25
    expect(ids).toContain(F.junior(251).id);
    expect(ids).toHaveLength(56);
  });

  it("3000 ineligible rows then 1 eligible: empty budget pages pause, Load More reaches row 3001, then the end", async () => {
    F.db.rows = [...Array.from({ length: 3000 }, (_, k) => F.senior(k + 1)), F.junior(3001)];
    await mount();
    const more = await screen.findByRole("button", { name: "Load More Verified Positions" }, { timeout: 30000 });
    expect(scanCalls().map((c) => c.page)).toEqual([1, 2, 3]);
    expect(shownIds()).toEqual([]);
    fireEvent.click(more);
    await endShown();
    expect(shownIds()).toEqual([F.junior(3001).id]);
    expect(scanCalls().map((c) => c.page)).toEqual([1, 2, 3, 4]);
  });
});
