// @vitest-environment jsdom
// Page epoch isolated from the hook token (hook mocked): cancel/close, logout, filter-only Apply. Adapted from an independent review test.
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

let applyPayload: any = {};
vi.mock("@/components/jobs/AllFiltersDrawer", () => ({ default: (p: any) => p.isOpen ? <><button onClick={() => p.onApply({ ...p.filters, ...applyPayload })}>Review Apply</button><button onClick={p.onClose}>Review Cancel</button></> : null }));
const epochCap = vi.hoisted(() => ({refresh: vi.fn(async()=>true)}));
vi.mock("@/lib/jobs/useRequiredYearsCapability",()=>({useRequiredYearsCapability:()=>({ready:true,checking:false,refresh:epochCap.refresh})}));
import JobsPage from "@/app/jobs/page";

const JOBS = [
  fixtureJob(1, { type: "full-time", remote: true, location: "Remote" }),
  fixtureJob(2, { type: "contract", remote: false, location: "Austin, TX (Hybrid)", remoteScope: "hybrid" }),
  fixtureJob(3, { type: "part-time", remote: false, location: "Austin, TX" }),
  fixtureJob(4, { type: "Full_Time", remote: false, location: "Pune", remoteScope: "hybrid" }),
  fixtureJob(5, { type: "contractor", remote: true, location: "Remote - US" }),
];
const last = () => h.calls[h.calls.length - 1];

async function mount(url: string) {
  window.history.replaceState(null, "", url);
  const view = render(<JobsPage />);
  await flush();
  return view;
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
  vi.unstubAllEnvs();
  cleanup();
  window.history.replaceState(null, "", "/jobs");
});


let capReady = true;
beforeEach(() => {
  capReady = true;
  vi.stubEnv("NEXT_PUBLIC_ENFORCE_SAVED_FEED_CONSTRAINTS", "true");
  vi.stubGlobal("fetch", vi.fn(async (u: any) => String(u).includes("/api/jobs/capabilities")
    ? new Response(JSON.stringify({ requiredYearsFilter: capReady }), { status: 200 })
    : new Response("{}", { status: 404 })));
});
const apply = async (payload: any) => {
  applyPayload = payload;
  fireEvent.click(screen.getByRole("button", { name: "Open all filters drawer" }));
  fireEvent.click(screen.getByRole("button", { name: "Review Apply" }));
  await flush();
};


it("isolated page epoch rejects oldtrue after filter-only Apply without hooktoken help",async()=>{
 epochCap.refresh.mockResolvedValue(true);await mount("/jobs");let resolve!:(v:boolean)=>void;
 epochCap.refresh.mockImplementationOnce(()=>new Promise<boolean>(r=>resolve=r));
 await apply({requiredYears:{mode:"range",min:2,max:4},company:"oldcompany"});
 await apply({requiredYears:undefined,company:"newcompany"});
 await act(async()=>resolve(true));await flush();
 expect(last().company).toBe("newcompany");expect(last().requiredYears?.mode??"inherit").toBe("inherit");
});
it("isolated page epoch rejects oldtrue after logout without hooktoken help",async()=>{
 epochCap.refresh.mockResolvedValue(true);h.user={id:"account-a",email:"a@example.invalid"};await mount("/jobs");let resolve!:(v:boolean)=>void;
 epochCap.refresh.mockImplementationOnce(()=>new Promise<boolean>(r=>resolve=r));
 await apply({requiredYears:{mode:"range",min:2,max:4},company:"oldcompany"});
 h.user=null;await act(async()=>window.dispatchEvent(new Event("careermonke_auth_updated")));await flush();
 await act(async()=>resolve(true));await flush();
 expect(last().company??"").not.toBe("oldcompany");expect(last().requiredYears?.mode??"inherit").toBe("inherit");
});

it("isolated cancelled drawer must not commit pending filters after Close",async()=>{
 epochCap.refresh.mockResolvedValue(true);await mount("/jobs");let resolve!:(v:boolean)=>void;
 epochCap.refresh.mockImplementationOnce(()=>new Promise<boolean>(r=>resolve=r));
 await apply({requiredYears:{mode:"range",min:2,max:4},company:"cancelledcompany"});
 fireEvent.click(screen.getByRole("button",{name:"Review Cancel"}));await flush();
 await act(async()=>resolve(true));await flush();
 expect(last().company??"").not.toBe("cancelledcompany");
});

it("reopening the drawer ends the old session: an old pending years Apply does not commit", async () => {
  epochCap.refresh.mockResolvedValue(true);
  await mount("/jobs");
  let resolve!: (v: boolean) => void;
  epochCap.refresh.mockImplementationOnce(() => new Promise<boolean>((r) => { resolve = r; }));
  await apply({ requiredYears: { mode: "range", min: 2, max: 4 }, company: "oldsession" });
  fireEvent.click(screen.getByRole("button", { name: "Review Cancel" })); await flush();
  fireEvent.click(screen.getByRole("button", { name: "Open all filters drawer" })); await flush();
  await act(async () => resolve(true)); await flush();
  expect(last().company ?? "").not.toBe("oldsession");
  expect(last().requiredYears?.mode ?? "inherit").toBe("inherit");
});

it("a rejected (false) or throwing capability refresh applies nothing", async () => {
  await mount("/jobs");
  epochCap.refresh.mockImplementationOnce(async () => false);
  await apply({ requiredYears: { mode: "range", min: 2, max: 4 }, company: "rejectedco" });
  await flush();
  expect(last().company ?? "").not.toBe("rejectedco");
  epochCap.refresh.mockImplementationOnce(async () => { throw new Error("boom"); });
  await apply({ requiredYears: { mode: "any" }, company: "throwco" }).catch(() => {});
  await flush();
  expect(last().company ?? "").not.toBe("throwco");
  expect(last().requiredYears?.mode ?? "inherit").toBe("inherit");
});

it("unmount while an Apply is pending commits nothing and does not throw", async () => {
  epochCap.refresh.mockResolvedValue(true);
  const view = await mount("/jobs");
  let resolve!: (v: boolean) => void;
  epochCap.refresh.mockImplementationOnce(() => new Promise<boolean>((r) => { resolve = r; }));
  await apply({ requiredYears: { mode: "range", min: 2, max: 4 }, company: "unmountco" });
  const n = h.calls.length;
  view.unmount();
  await act(async () => resolve(true)); await flush();
  expect(h.calls.length).toBe(n);
});
