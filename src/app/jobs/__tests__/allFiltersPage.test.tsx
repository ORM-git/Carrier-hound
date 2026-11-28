// @vitest-environment jsdom
// Multi-select Job Type / Work Model on the real /jobs page (FIXTURE transport): the request the page makes
// (remoteOnly must only accompany a Remote-only selection) and the cards it shows after its secondary filter.
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

import JobsPage from "@/app/jobs/page";

// Card types as the API emits them (raw job_type; internship -> "Internship").
const JOBS = [
  fixtureJob(1, { type: "full-time", remote: true, location: "Remote" }),
  fixtureJob(2, { type: "contract", remote: false, location: "Austin, TX (Hybrid)", remoteScope: "hybrid" }),
  fixtureJob(3, { type: "part-time", remote: false, location: "Austin, TX" }),
  fixtureJob(4, { type: "Full_Time", remote: false, location: "Pune", remoteScope: "hybrid" }),
  fixtureJob(5, { type: "contractor", remote: true, location: "Remote - US" }),
];
const visible = () =>
  Array.from(new Set(screen.queryAllByRole("heading", { level: 2 }).map((el) => el.textContent?.trim()).filter((t) => t?.startsWith("Fixture Analyst"))))
    .map((t) => Number(t!.replace("Fixture Analyst ", "")))
    .sort();
const last = () => h.calls[h.calls.length - 1];

async function mount(url: string) {
  window.history.replaceState(null, "", url);
  const view = render(<JobsPage />);
  await flush();
  return view;
}
async function chooseWorkModel(labels: string[]) {
  fireEvent.click(screen.getByRole("button", { name: /^Work model filter:/ }));
  const dialog = screen.getByRole("dialog", { name: "Filter by Work Model" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Clear" }));
  for (const l of labels) fireEvent.click(within(dialog).getByLabelText(l));
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm" }));
  await flush();
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
  cleanup();
  window.history.replaceState(null, "", "/jobs");
});

describe("independent AllFilters page integration", () => {
  it("draft does not request before Confirm, Escape cancels, Confirm updates real page transport and reset clears", async () => {
    await mount("/jobs");
    const before=h.calls.length;
    fireEvent.click(screen.getByRole("button", {name:"Open all filters drawer"}));
    let dialog=screen.getByRole("dialog", {name:"All Filters"});
    fireEvent.change(within(dialog).getByLabelText("Company"), {target:{value:"example"}});
    await flush();
    expect(h.calls.length).toBe(before);
    fireEvent.keyDown(document,{key:"Escape"});
    expect(screen.queryByRole("dialog",{name:"All Filters"})).toBeNull();
    expect(h.calls.length).toBe(before);
    fireEvent.click(screen.getByRole("button", {name:"Open all filters drawer"}));
    dialog=screen.getByRole("dialog", {name:"All Filters"});
    expect(within(dialog).getByLabelText("Company")).toHaveValue("");
    fireEvent.change(within(dialog).getByLabelText("Company"), {target:{value:"example"}});
    fireEvent.click(within(dialog).getByRole("button",{name:"Confirm"}));
    await flush();
    expect(last().company).toBe("example");
    fireEvent.click(screen.getByRole("button", {name:"Open all filters drawer"}));
    dialog=screen.getByRole("dialog", {name:"All Filters"});
    fireEvent.click(within(dialog).getByRole("button",{name:"Reset All"}));
    fireEvent.click(within(dialog).getByRole("button",{name:"Confirm"}));
    await flush();
    expect(last().company).toBe("");
  });
});
