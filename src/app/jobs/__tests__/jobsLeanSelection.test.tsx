// @vitest-environment jsdom
// Real /jobs page, lean Pro list rows: Forward/popstate must hydrate a lean row, and a slow detail for an earlier
// history step must never land on a later one. Fixture transport only; each case mounts a fresh page.
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
vi.mock("@/components/jobs/JobDetailView", () => ({
  default: ({ job }: any) => <section data-testid="detail-dom" data-id={job.id} data-lean={String(Boolean(job.lean))}><h2>{job.title}</h2><p data-testid="detail-desc">{job.description}</p></section>,
}));
import JobsPage from "@/app/jobs/page";

const lean = (i: number) => fixtureJob(i, { description: "", lean: true, experienceBuckets: ["3-5 Years"] } as any);
const full = (i: number) => fixtureJob(i, { description: `FULL-DESCRIPTION-${i} ` + "x".repeat(80) });
const detailId = () => document.querySelector('[data-testid="detail-dom"]')?.getAttribute("data-id") ?? null;
const detailDesc = () => document.querySelector('[data-testid="detail-desc"]')?.textContent ?? null;
const urlId = () => new URLSearchParams(window.location.search).get("id");

/** Per-id pending detail requests, in call order. */
let pending: Record<string, ReturnType<typeof deferred<any>>[]> = {};
let byIdCalls: string[] = [];

beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness(); localStorage.clear(); sessionStorage.clear(); pending = {}; byIdCalls = [];
  h.isPro = true; h.desktop = true;
  h.transport = async () => page([lean(1), lean(2)], false);
  h.byId = (id: string) => { byIdCalls.push(id); const d = deferred<any>(); (pending[id] ||= []).push(d); return d.promise; };
});
afterEach(() => { cleanup(); window.history.replaceState(null, "", "/jobs"); });

async function mount() {
  window.history.replaceState(null, "", "/jobs"); render(<JobsPage />); await flush();
  await waitFor(() => expect(document.querySelector('[data-testid="job-card"]')).toBeTruthy());
}
async function pop(url: string, state: any) {
  window.history.replaceState(state, "", url);
  await act(async () => window.dispatchEvent(new PopStateEvent("popstate", { state })));
  await flush();
}
const resolve = async (id: string, job: any, index = 0) => { await act(async () => pending[id][index].resolve(job)); await flush(); };
/** Open A by a real card click and let its detail load, so the history entry for A exists. */
async function openAndLoad(i: number) {
  fireEvent.click(screen.getAllByRole("heading", { name: `Fixture Analyst ${i}` })[0]);
  await flush();
  await resolve(`fx-${i}`, full(i), pending[`fx-${i}`].length - 1);
  expect(detailId()).toBe(`fx-${i}`);
  expect(urlId()).toBe(`fx-${i}`);
}

describe("lean row selection through real history navigation", () => {
  it("Forward onto a lean row loads the full record: one request, then the full description shows", async () => {
    await mount(); await openAndLoad(1);
    await pop("/jobs", null);
    expect(detailId()).toBeNull();
    byIdCalls = [];
    await pop("/jobs?id=fx-1", { jobId: "fx-1" });
    expect(byIdCalls).toEqual(["fx-1"]);
    expect(detailId()).toBeNull(); // a lean row is not shown as a detail while loading
    await resolve("fx-1", full(1), pending["fx-1"].length - 1);
    expect(detailId()).toBe("fx-1");
    expect(detailDesc()).toContain("FULL-DESCRIPTION-1");
    expect(document.querySelector('[data-testid="detail-dom"]')?.getAttribute("data-lean")).toBe("false");
  });

  it("slow Forward A, then Back: the list stays and the late A never lands", async () => {
    await mount(); await openAndLoad(1);
    await pop("/jobs", null);
    byIdCalls = [];
    await pop("/jobs?id=fx-1", { jobId: "fx-1" });
    expect(byIdCalls).toEqual(["fx-1"]); // exactly one pending A before Back
    await pop("/jobs", null);
    expect(urlId()).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Fixture Analyst 2" }).length).toBeGreaterThan(0); // list visible
    await resolve("fx-1", full(1), pending["fx-1"].length - 1);
    expect(detailId()).toBeNull();
    expect(urlId()).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Fixture Analyst 2" }).length).toBeGreaterThan(0);
  });

  it("slow Forward A, Back, real click on B: B stays B whichever detail resolves last", async () => {
    await mount(); await openAndLoad(1);
    await pop("/jobs", null);
    await pop("/jobs?id=fx-1", { jobId: "fx-1" });
    await pop("/jobs", null);
    fireEvent.click(screen.getAllByRole("heading", { name: "Fixture Analyst 2" })[0]);
    await flush();
    expect(urlId()).toBe("fx-2");
    await resolve("fx-2", full(2), pending["fx-2"].length - 1);
    await resolve("fx-1", full(1), pending["fx-1"].length - 1); // stale A resolves after B
    expect(detailId()).toBe("fx-2");
    expect(detailDesc()).toContain("FULL-DESCRIPTION-2");
    expect(urlId()).toBe("fx-2");
  });
});
