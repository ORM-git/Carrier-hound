// @vitest-environment jsdom
// Hidden Jobs is removed from phones only. FIXTURE responses on the real /jobs page.
// Phones: no Hidden Jobs switch/chip/count, and a stale ?hidden=true can't trap the feed in hidden-only mode.
// Desktop: unchanged. The ordinary per-card Hide action keeps working and the saved hidden IDs are untouched.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

const USER = { id: "fx-user", email: "fixture@example.invalid" };
const KEY = `cm_hidden_jobs_${USER.id}`;
const titles = () =>
  Array.from(new Set(screen.queryAllByRole("heading", { level: 2 }).map((e) => e.textContent?.trim()).filter((t) => t?.startsWith("Fixture"))));
const lastUrl = () => window.location.pathname + window.location.search;

async function mount(url: string) {
  window.history.replaceState(null, "", url);
  render(<JobsPage />);
  await flush();
}

beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness();
  localStorage.clear();
  h.user = USER;
  h.isPro = true;
  // The router writes the URL, so the assertions see the page's final URL, not just the last call.
  h.router.replace.mockImplementation((u: string) => window.history.replaceState(null, "", u));
  const jobs = [fixtureJob(1), fixtureJob(2), fixtureJob(3)];
  h.transport = async () => page(jobs, false, 3);
  localStorage.setItem(KEY, JSON.stringify([jobs[0].id]));
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/jobs");
});

describe("phone: Hidden Jobs removed", () => {
  it("a stale ?hidden=true does not trap the phone in a hidden-only feed and is dropped from the URL", async () => {
    await mount("/jobs?hidden=true");
    const shown = titles();
    expect(shown.length).toBe(2); // the normal feed minus the hidden job, not the hidden-only list
    expect(screen.queryByText("No hidden positions")).toBeNull();
    expect(lastUrl()).not.toContain("hidden=true");
    // the saved hidden IDs are untouched
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(1);
  });

  it("the mobile filter sheet has no Hidden Jobs switch, chip or count", async () => {
    await mount("/jobs");
    fireEvent.click(screen.getByRole("button", { name: "Open filter settings" }));
    await flush();
    expect(screen.queryByRole("switch", { name: /Hidden Positions/i })).toBeNull();
    expect(screen.queryByText(/View Hidden Positions|jobs currently hidden|No jobs hidden yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: /hidden jobs filter/i })).toBeNull();
    // Applying the sheet never turns hidden-only mode on
    fireEvent.click(within(screen.getByRole("dialog", { name: "Filter positions" })).getByRole("button", { name: "Apply" }));
    await flush();
    expect(lastUrl()).not.toContain("hidden=true");
  });

  it("the ordinary per-card Hide action still hides a job and records its ID", async () => {
    await mount("/jobs");
    const before = titles().length;
    fireEvent.click(screen.getAllByRole("button", { name: "Hide position" })[0]);
    await flush();
    expect(titles().length).toBe(before - 1);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(2);
  });
});

describe("desktop: Hidden Jobs unchanged", () => {
  beforeEach(() => {
    h.desktop = true;
  });

  it("?hidden=true still shows the hidden-only list and the toggle stays", async () => {
    await mount("/jobs?hidden=true");
    expect(titles()).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Toggle Hidden Jobs" })).toBeTruthy();
    expect(lastUrl()).toContain("hidden=true");
  });
});
