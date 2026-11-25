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
fireEvent.click(within(screen.getByRole("dialog")).getByRole("button",{name:"Apply"}));await flush();
expect(h.router.replace.mock.calls.at(-1)?.[0]).not.toContain("hidden=true");
});
