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

describe("Job Type multi-select on the page", () => {
  it("Full-time + Contract shows both types (old filter hid every card)", async () => {
    await mount("/jobs?type=full-time,%20contract");
    expect(last().jobType).toBe("full-time, contract");
    expect(visible()).toEqual([1, 2, 4, 5]);
  });

  it("single selections and aliases keep their meaning", async () => {
    await mount("/jobs?type=contract");
    expect(visible()).toEqual([2, 5]);
    cleanup();
    await mount("/jobs?type=FULL-TIME");
    expect(visible()).toEqual([1, 4]);
  });
});

describe("Work Model multi-select never forces remoteOnly", () => {
  it("choosing Remote + Hybrid requests both without remoteOnly and shows the remote=false Hybrid jobs", async () => {
    await mount("/jobs");
    await chooseWorkModel(["Remote anywhere", "Hybrid"]);
    expect(last().workModel).toBe("remote, hybrid");
    expect(last().remoteOnly).toBe(false);
    expect(visible()).toEqual([1, 2, 4, 5]);
    expect(new URLSearchParams(h.router.replace.mock.calls.at(-1)?.[0].split("?")[1]).get("remote")).toBeNull();
  });

  it("all work modes includes Onsite", async () => {
    await mount("/jobs");
    await chooseWorkModel(["Remote anywhere", "Hybrid", "Onsite"]);
    expect(last().remoteOnly).toBe(false);
    expect(visible()).toEqual([1, 2, 3, 4, 5]);
  });

  it("Remote alone keeps the strict Remote-only request (intentional selection preserved)", async () => {
    await mount("/jobs");
    await chooseWorkModel(["Remote anywhere"]);
    expect(last().workModel).toBe("remote");
    expect(last().remoteOnly).toBe(true);
  });

  it("a Remote-only link stays Remote-only; a stale remote=true beside Remote + Hybrid is dropped", async () => {
    await mount("/jobs?remote=true");
    expect(last().remoteOnly).toBe(true);
    cleanup();
    h.calls = [];
    await mount("/jobs?workModel=remote,hybrid&remote=true");
    expect(h.calls.every((c) => !c.remoteOnly)).toBe(true);
    expect(last().workModel).toBe("remote,hybrid");
  });

  it("deselecting, Clear and Clear all remove a stale remoteOnly", async () => {
    await mount("/jobs?remote=true");
    expect(last().remoteOnly).toBe(true);
    await chooseWorkModel([]); // deselect everything in the popover
    expect(last().remoteOnly).toBe(false);
    expect(last().workModel).toBe("");

    cleanup();
    await mount("/jobs?remote=true&workModel=remote");
    fireEvent.click(screen.getByRole("button", { name: "Remove work model filter remote" }));
    await flush();
    expect(last().remoteOnly).toBe(false);

    cleanup();
    await mount("/jobs?remote=true&type=contract");
    fireEvent.click(screen.getAllByRole("button", { name: /Clear all/ })[0]);
    await flush();
    expect(last()).toMatchObject({ remoteOnly: false, workModel: "", jobType: "" });
  });

  it("browser back/forward restores each entry without carrying a stale remoteOnly", async () => {
    await mount("/jobs?remote=true");
    expect(last().remoteOnly).toBe(true);
    await act(async () => {
      window.history.pushState(null, "", "/jobs?workModel=remote,hybrid&remote=true");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expect(last()).toMatchObject({ remoteOnly: false, workModel: "remote,hybrid" });
    await act(async () => {
      window.history.pushState(null, "", "/jobs?remote=true");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expect(last()).toMatchObject({ remoteOnly: true, workModel: "" });
    await act(async () => {
      window.history.pushState(null, "", "/jobs");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flush();
    expect(last()).toMatchObject({ remoteOnly: false, workModel: "" });
  });
});
