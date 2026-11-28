// @vitest-environment jsdom
// REAL All Filters drawer inside the real /jobs page (FIXTURE transport, not live): required-years capability, refresh on open,
// Saved range / Any / range modes reaching the request.
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

const JOBS = [fixtureJob(1, { type: "full-time", remote: true, location: "Remote" }), fixtureJob(2, { type: "contract", remote: false, location: "Austin, TX" })];
const last = () => h.calls[h.calls.length - 1];
let caps: boolean[] = [];
let capCalls = 0;
let hold: Promise<void> | null = null;

async function mount() {
  window.history.replaceState(null, "", "/jobs");
  const view = render(<JobsPage />);
  await flush();
  return view;
}
const openDrawer = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Open all filters drawer" }));
  await flush();
  return screen.getByRole("dialog", { name: "All Filters" });
};
beforeAll(installBrowserStandIns);
beforeEach(() => {
  resetHarness();
  h.desktop = true;
  localStorage.clear();
  sessionStorage.clear();
  h.transport = async () => page(JOBS, false, JOBS.length);
  capCalls = 0;
  hold = null;
  caps = [true];
  vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
  vi.stubGlobal("fetch", vi.fn(async (u: any) => {
    if (!String(u).includes("/api/jobs/capabilities")) return new Response("{}", { status: 404 });
    const v = caps[Math.min(capCalls++, caps.length - 1)];
    if (hold) await hold;
    return new Response(JSON.stringify({ requiredYearsFilter: v }), { status: 200 });
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  window.history.replaceState(null, "", "/jobs");
});

describe("required years in the real drawer on the real page", () => {
  it("ready: choosing a range and Confirm reaches the request; Any and Saved range are distinct requests", async () => {
    await mount();
    let d = await openDrawer();
    fireEvent.click(within(d).getByLabelText("Set a range"));
    fireEvent.change(within(d).getByLabelText("Min years"), { target: { value: "1" } });
    fireEvent.change(within(d).getByLabelText("Max years"), { target: { value: "4" } });
    fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
    await flush();
    expect(last().requiredYears).toEqual({ mode: "range", min: 1, max: 4 });
    expect(last().page).toBe(1);
    d = await openDrawer();
    fireEvent.click(within(d).getByLabelText("Any"));
    fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
    await flush();
    expect(last().requiredYears).toEqual({ mode: "any" });
    d = await openDrawer();
    fireEvent.click(within(d).getByLabelText("Saved range"));
    fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
    await flush();
    expect(last().requiredYears?.mode ?? "inherit").toBe("inherit");
  });

  it("capability false: control is disabled with a reason and a Confirm sends no years", async () => {
    caps = [false];
    await mount();
    const d = await openDrawer();
    expect(within(d).getByText(/not available right now/)).toBeTruthy();
    expect(within(d).queryByLabelText("Min years")).toBeNull();
    fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
    await flush();
    expect(last().requiredYears?.mode ?? "inherit").toBe("inherit");
  });

  it("readiness is refreshed on every open: a later failure revokes a previously true state", async () => {
    caps = [true, false];
    await mount();
    expect(capCalls).toBe(1);
    const d = await openDrawer();
    expect(capCalls).toBe(2);
    expect(within(d).getByText(/not available right now/)).toBeTruthy();
    expect(within(d).queryByRole("radiogroup", { name: "Required years mode" })).toBeNull();
  });

  it("while the recheck is in flight the control is disabled (no choice rides stale readiness)", async () => {
    caps = [true, true];
    await mount();
    let release!: () => void;
    hold = new Promise<void>((r) => { release = r; });
    fireEvent.click(screen.getByRole("button", { name: "Open all filters drawer" }));
    await flush();
    const d = screen.getByRole("dialog", { name: "All Filters" });
    expect(within(d).getByText(/Checking whether required years can be used/)).toBeTruthy();
    expect(within(d).queryByRole("radiogroup", { name: "Required years mode" })).toBeNull();
    await act(async () => { release(); await Promise.resolve(); });
    await flush();
    expect(within(d).getByRole("radiogroup", { name: "Required years mode" })).toBeTruthy();
  });

  describe("async Confirm commit races (old answer must not commit)", () => {
    let pending: Array<(v: boolean) => void> = [];
    const manual = () => {
      pending = [];
      vi.stubGlobal("fetch", vi.fn(async (u: any) => {
        if (!String(u).includes("/api/jobs/capabilities")) return new Response("{}", { status: 404 });
        const v = await new Promise<boolean>((res) => { pending.push(res); });
        return new Response(JSON.stringify({ requiredYearsFilter: v }), { status: 200 });
      }));
    };
    const settle = async (idx: number, v: boolean) => { await act(async () => { pending[idx]!(v); await Promise.resolve(); }); await flush(); };
    const confirmRange = async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open all filters drawer" }));
      await flush();
      const d = screen.getByRole("dialog", { name: "All Filters" });
      return d;
    };
    const chooseRangeAndConfirm = async (d: HTMLElement) => {
      fireEvent.click(within(d).getByLabelText("Set a range"));
      fireEvent.change(within(d).getByLabelText("Min years"), { target: { value: "1" } });
      fireEvent.change(within(d).getByLabelText("Max years"), { target: { value: "4" } });
      fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
      await flush();
    };
    const yearsMode = () => h.calls.map((c) => c.requiredYears?.mode ?? "inherit");

    it("a pending Confirm is dropped when the tab changes before the answer arrives", async () => {
      manual();
      window.history.replaceState(null, "", "/jobs");
      render(<JobsPage />);
      await flush();
      await settle(0, true);
      await confirmRange();
      await settle(1, true);
      const d = screen.getByRole("dialog", { name: "All Filters" });
      await chooseRangeAndConfirm(d);
      fireEvent.click(screen.getAllByRole("button", { name: /^Saved/ })[0]!);
      await flush();
      await settle(2, true);
      fireEvent.click(screen.getAllByRole("button", { name: /^For You/ })[0]!);
      await flush();
      expect(yearsMode().includes("range")).toBe(false);
    });

    it("logout/login (auth event) while a years Confirm is pending drops it", async () => {
      manual();
      window.history.replaceState(null, "", "/jobs");
      render(<JobsPage />);
      await flush();
      await settle(0, true);
      await confirmRange();
      await settle(1, true);
      const d = screen.getByRole("dialog", { name: "All Filters" });
      await chooseRangeAndConfirm(d); // pending #2
      await act(async () => { window.dispatchEvent(new Event("careermonke_auth_updated")); });
      await flush();
      await settle(2, true); // old answer
      if (pending[3]) await settle(3, true); // the refresh the auth event started
      expect(yearsMode().includes("range")).toBe(false);
    });

    it("a second Confirm click while the years check is pending does not start another check or apply twice", async () => {
      manual();
      window.history.replaceState(null, "", "/jobs");
      render(<JobsPage />);
      await flush();
      await settle(0, true);
      await confirmRange();
      await settle(1, true);
      const d = screen.getByRole("dialog", { name: "All Filters" });
      await chooseRangeAndConfirm(d);
      fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
      await flush();
      expect(pending.length).toBe(3); // mount, open recheck, ONE apply check
      await settle(2, true);
      expect(yearsMode().filter((m) => m === "range").length).toBeGreaterThan(0);
      expect(screen.queryByRole("dialog", { name: "All Filters" })).toBeNull();
    });

    it("a rejected years Apply keeps the drawer open, applies nothing (not even other filters), and shows the unavailable state", async () => {
      manual();
      window.history.replaceState(null, "", "/jobs");
      render(<JobsPage />);
      await flush();
      await settle(0, true);
      await confirmRange();
      await settle(1, true);
      const d = screen.getByRole("dialog", { name: "All Filters" });
      const before = h.calls.length;
      await chooseRangeAndConfirm(d); // check #2 pending
      await settle(2, false); // rejected
      const still = screen.getByRole("dialog", { name: "All Filters" });
      expect(within(still).getByText(/not available right now/)).toBeTruthy();
      expect(yearsMode().includes("range")).toBe(false);
      expect(h.calls.length).toBe(before);
    });

    it("a second Confirm click while the years check is pending does not start another check or apply twice", async () => {
      manual();
      window.history.replaceState(null, "", "/jobs");
      render(<JobsPage />);
      await flush();
      await settle(0, true);
      await confirmRange();
      await settle(1, true);
      const d = screen.getByRole("dialog", { name: "All Filters" });
      await chooseRangeAndConfirm(d);
      fireEvent.click(within(d).getByRole("button", { name: "Confirm" }));
      await flush();
      expect(pending.length).toBe(3); // mount, open recheck, ONE apply check
      await settle(2, true);
      expect(yearsMode().filter((m) => m === "range").length).toBeGreaterThan(0);
      expect(screen.queryByRole("dialog", { name: "All Filters" })).toBeNull();
    });

    it("no residual timers after a fast success or a rejection (deadline timers are cleared)", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let answer = true;
        vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ requiredYearsFilter: answer }), { status: 200 })));
        window.history.replaceState(null, "", "/jobs");
        const view = render(<JobsPage />);
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        const afterSuccess = vi.getTimerCount();
        answer = false;
        window.dispatchEvent(new Event("careermonke_auth_updated"));
        await act(async () => { await vi.advanceTimersByTimeAsync(10); });
        const afterReject = vi.getTimerCount();
        expect(afterReject).toBeLessThanOrEqual(afterSuccess);
        view.unmount();
        // after unmount the hook's own timers (interval, deadline) are gone; only unrelated app timers may remain
        const { YEARS_CAPABILITY_FETCH_DEADLINE_MS } = await import("@/lib/jobs/useRequiredYearsCapability");
        const before = vi.getTimerCount();
        await act(async () => { await vi.advanceTimersByTimeAsync(YEARS_CAPABILITY_FETCH_DEADLINE_MS + 100); });
        expect(vi.getTimerCount()).toBeLessThanOrEqual(before);
      } finally { vi.useRealTimers(); }
    });

    it("a capability request that never answers is aborted at the deadline and fails closed", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let aborted = false;
        vi.stubGlobal("fetch", vi.fn((_u: any, init?: any) => new Promise<Response>((_res, rej) => {
          init?.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); });
        })));
        const { YEARS_CAPABILITY_FETCH_DEADLINE_MS } = await import("@/lib/jobs/useRequiredYearsCapability");
        window.history.replaceState(null, "", "/jobs");
        render(<JobsPage />);
        await act(async () => { await vi.advanceTimersByTimeAsync(YEARS_CAPABILITY_FETCH_DEADLINE_MS + 50); });
        expect(aborted).toBe(true);
        expect(h.calls.every((c) => (c.requiredYears?.mode ?? "inherit") === "inherit")).toBe(true);
      } finally { vi.useRealTimers(); }
    });
  });
});
