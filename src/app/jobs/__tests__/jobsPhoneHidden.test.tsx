// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
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


let phone=false;let listeners:Array<()=>void>=[];
beforeAll(installBrowserStandIns);
beforeEach(()=>{resetHarness();localStorage.clear();phone=false;listeners=[];
window.matchMedia=((q:string)=>({get matches(){const m=/max-width:\s*639/.test(q);return m?phone:q.includes("min-width")?!phone:false;},media:q,addEventListener:(_e:string,f:()=>void)=>listeners.push(f),removeEventListener:()=>{},addListener:()=>{},removeListener:()=>{}})) as any;
h.transport=async()=>page([fixtureJob(1)],false,1);
});
afterEach(()=>{cleanup();window.history.replaceState(null,"","/jobs");});
it("real Jobs page hides an already-open desktop drawer on phone resize and restores it on desktop",async()=>{
window.history.replaceState(null,"","/jobs?hidden=true");render(<JobsPage/>);await flush();
fireEvent.click(screen.getByRole("button",{name:"Open all filters drawer"}));await flush();
expect(screen.getByLabelText("View Hidden Positions toggle")).toBeTruthy();
await act(async()=>{phone=true;listeners.forEach(f=>f());});await flush();
expect(screen.queryByLabelText("View Hidden Positions toggle")).toBeNull();
expect(screen.queryByText("Viewing Hidden Jobs")).toBeNull();
await act(async()=>{phone=false;listeners.forEach(f=>f());});await flush();
expect(screen.getByLabelText("View Hidden Positions toggle")).toBeTruthy();
});
it("real phone Jobs URL hidden=true opens ordinary sheet without hidden controls and Apply clears URL state",async()=>{
phone=true;window.history.replaceState(null,"","/jobs?hidden=true");render(<JobsPage/>);await flush();
fireEvent.click(screen.getByRole("button",{name:"Open filter settings"}));await flush();
expect(screen.queryByLabelText("View Hidden Positions")).toBeNull();
fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Update"}));await flush();
expect(h.router.replace.mock.calls.at(-1)?.[0]).not.toContain("hidden=true");
});

it("real phone Update sends multi-facet browse options and resets pagination; discard sends nothing", async () => {
  phone = true;
  window.history.replaceState(null, "", "/jobs");
  render(<JobsPage />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Open filter settings" }));
  await flush();
  let dialog = within(screen.getByRole("dialog"));
  const before = h.calls.length;
  fireEvent.click(dialog.getByRole("button", { name: /Basic Job Criteria/ }));
  fireEvent.click(dialog.getByLabelText("Contract"));
  fireEvent.click(dialog.getByLabelText("Remote"));
  fireEvent.click(dialog.getByLabelText("Hybrid"));
  fireEvent.click(dialog.getByLabelText("Entry Level"));
  fireEvent.click(dialog.getByLabelText("Past week"));
  await flush();
  expect(h.calls).toHaveLength(before);
  fireEvent.click(dialog.getByRole("button", { name: "Update" }));
  await flush();
  expect(h.calls.length).toBeGreaterThan(before);
  expect(h.calls.at(-1)).toMatchObject({
    jobType: "contract",
    workModel: "remote, hybrid",
    remoteOnly: false,
    level: "entry",
    datePosted: "7d",
    page: 1,
  });
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open filter settings" }));
  await flush();
  dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: /Basic Job Criteria/ }));
  fireEvent.click(dialog.getByLabelText("Full-time"));
  const beforeDiscard = h.calls.length;
  fireEvent.click(dialog.getByLabelText("Close filter settings"));
  await flush();
  expect(h.calls.length).toBe(beforeDiscard);
});

const SIGNED_IN = { id: "u-1", email: "u@example.com" };
const PREFS = { roles: ["Business Analyst"], employmentTypes: ["full-time"], updatedAt: "2026-11-01T00:00:00Z" };

it("signed-in phone: no Preferences box or sheet; Filters is the single entry into the filter flow", async () => {
  phone = true;
  h.user = SIGNED_IN;
  h.isPro = true;
  h.prefs = PREFS;
  render(<JobsPage />);
  await flush(10);
  expect(screen.queryByText("Recommended uses your saved preferences")).toBeNull();
  expect(screen.queryByRole("button", { name: /^Preferences/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Open filter settings" }));
  await flush();
  const dialogs = screen.getAllByRole("dialog");
  expect(dialogs).toHaveLength(1);
  expect(dialogs[0].getAttribute("aria-label")).toBe("Filter positions");
});

it("signed-in desktop keeps the Preferences box and sheet; a phone resize removes them", async () => {
  h.user = SIGNED_IN;
  h.isPro = true;
  h.prefs = PREFS;
  render(<JobsPage />);
  await flush(10);
  expect(screen.getByText("Recommended uses your saved preferences")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /^Preferences/ }));
  await flush();
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => { phone = true; listeners.forEach((f) => f()); });
  await flush();
  expect(screen.queryByText("Recommended uses your saved preferences")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("phone: the Active chips strip is removed below md; filters, the Filters badge and sort stay", async () => {
  phone = true;
  render(<JobsPage />);
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Open filter settings" }));
  await flush();
  const dialog = within(screen.getByRole("dialog"));
  fireEvent.click(dialog.getByRole("button", { name: /Basic Job Criteria/ }));
  fireEvent.click(dialog.getByLabelText("Contract"));
  fireEvent.click(dialog.getByLabelText("Past week"));
  fireEvent.click(dialog.getByRole("button", { name: "Update" }));
  await flush();
  const strip = screen.getByTestId("active-filters-strip");
  expect(strip.className.split(/\s+/)).toEqual(expect.arrayContaining(["hidden", "md:flex"]));
  expect(h.calls.at(-1)).toMatchObject({ jobType: "contract", datePosted: "7d", sortBy: "match" });
  expect(within(screen.getByTestId("mobile-reference-filters")).getByText("2")).toBeTruthy();
});
