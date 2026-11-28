// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  publicResult: null as null | (() => Promise<any>),
  resolve: null as null | ((value: { isPro: boolean }) => void),
  query: vi.fn(), unlock: vi.fn(), params: new URLSearchParams(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), useSearchParams: () => h.params }));
vi.mock("@/lib/billing/subscription", () => ({
  getProAccessStatus: () => new Promise(resolve => { h.resolve = resolve; }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({
  auth: { getUser: async () => ({ data: { user: { id: "fixture" } } }),
    getSession: async () => ({ data: { session: { access_token: "fixture-only" } } }) },
  from: () => {
    const q: any = new Proxy({}, { get: (_t, key) => key === "then"
      ? (resolve: any) => { h.query(); return (h.publicResult ? h.publicResult() : Promise.resolve({ data: [{ id: "fixture-job", title: "Fixture role", company: "Masked", location: "Bangalore", apply_url: "#", verified: true }], count: 1, error: null })).then(resolve); }
      : () => q });
    return q;
  },
}) }));
vi.mock("@/components/CompanyLogo", () => ({ default: () => null }));
vi.mock("@/components/PaywallModal", () => ({ default: () => null }));
vi.mock("@/components/matcher/MatchScoreBadge", () => ({ default: () => null }));
vi.mock("@/components/RadarFlatMap", () => ({ default: () => null }));
vi.mock("@/lib/tracker/storage", () => ({ quickTrackJob: vi.fn() }));
vi.mock("react-toastify", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("three", async importOriginal => {
  const real = await importOriginal<typeof import("three")>();
  return { ...real, WebGLRenderer: class {
    domElement = document.createElement("canvas");
    capabilities = { getMaxAnisotropy: () => 1 };
    setPixelRatio() {} setSize() {} render() {} dispose() {} forceContextLoss() {}
  } };
});
vi.mock("three/examples/jsm/controls/OrbitControls.js", () => ({ OrbitControls: class {
  target = { set() {}, copy() {} }; addEventListener() {} update() {} dispose() {}
} }));
import Radar from "../JobRadarGlobe";
const city = { id: "bangalore", name: "Bangalore", countryCode: "IN", region: "asia_pac", coordinates: [77.59, 12.97], totalCount: 1, verifiedCount: 1, topCompanies: ["Fixture"] };
beforeEach(() => {
  h.publicResult = null; h.resolve = null; h.params = new URLSearchParams(); h.query.mockReset(); h.unlock.mockReset();
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn() })));
  const context2d: any = new Proxy({}, { get: (_t, key) => (key === "createRadialGradient" || key === "createLinearGradient") ? () => ({ addColorStop() {} }) : key === "getImageData" ? () => ({ data: new Uint8ClampedArray(4) }) : () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((type: string) => type === "2d" ? context2d : null) as any);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/jobs/pro") { h.unlock(); return { ok: true, json: async () => ({ jobs: [{ id: "fixture-job", company: "Unlocked fixture", apply_url: "https://example.invalid/apply" }] }) }; }
    return { ok: true, json: async () => ({ header: { totalActive: 1, totalVerified: 1, dataAsOf: "2026-11-28T00:00:00Z" }, countries: {}, cities: [city, { ...city, id: "delhi", name: "Delhi" }], totalJobs: 1, worldwideRemote: { totalCount: 0, verifiedCount: 0 } }) };
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function selectCity() {
  render(<Radar />);
  fireEvent.click(screen.getByRole("button", { name: /List$/ }));
  fireEvent.click(await screen.findByRole("button", { name: /Bangalore.*IN/ }));
  await waitFor(() => expect(h.query).toHaveBeenCalledTimes(1));
}
describe("Radar selected-city entitlement refresh", () => {
  it("refetches an already selected city when async Pro status settles, without changing a filter", async () => {
    await selectCity();
    expect(h.unlock).not.toHaveBeenCalled();
    await act(async () => h.resolve!({ isPro: true }));
    await waitFor(() => expect(h.unlock).toHaveBeenCalledTimes(1));
    expect(h.query).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("link", { name: /Direct Apply/ })).toHaveAttribute("href", "https://example.invalid/apply");
  });
  it("uses settled Pro status for the first city selection", async () => {
    render(<Radar />);
    await act(async () => h.resolve!({ isPro: true }));
    fireEvent.click(screen.getByRole("button", { name: /List$/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Bangalore.*IN/ }));
    await waitFor(() => expect(h.unlock).toHaveBeenCalledTimes(1));
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it("refetches masked public cards when status changes back to Free", async () => {
    await selectCity();
    await act(async () => h.resolve!({ isPro: true }));
    await screen.findByRole("link", { name: /Direct Apply/ });
    await act(async () => window.dispatchEvent(new Event("careermonke_pro_updated")));
    await act(async () => h.resolve!({ isPro: false }));
    await waitFor(() => expect(h.query).toHaveBeenCalledTimes(3));
    expect(h.unlock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("link", { name: /Direct Apply/ })).toBeNull();
    expect(screen.queryByText("Unlocked fixture")).toBeNull();
  });
  it("does not unlock or repeat the public query when async status confirms Free", async () => {
    await selectCity();
    await act(async () => h.resolve!({ isPro: false }));
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.unlock).not.toHaveBeenCalled();
    expect(screen.queryByRole("link", { name: /Direct Apply/ })).toBeNull();
  });
});

it("independent: late Pro unlock cannot repopulate full company after downgrade",async()=>{
 await selectCity();let release!:(v:any)=>void;const realFetch=globalThis.fetch;
 vi.stubGlobal("fetch",vi.fn((u:any,...args:any[])=>u==="/api/jobs/pro"?new Promise(r=>{h.unlock();release=r}):(realFetch as any)(u,...args)));
 await act(async()=>h.resolve!({isPro:true}));await waitFor(()=>expect(h.unlock).toHaveBeenCalledTimes(1));
 await act(async()=>window.dispatchEvent(new Event("careermonke_pro_updated")));
 await act(async()=>h.resolve!({isPro:false}));await waitFor(()=>expect(h.query).toHaveBeenCalledTimes(3));
 await act(async()=>release({ok:true,json:async()=>({jobs:[{id:"fixture-job",company:"Late unlocked company",salary_text:"Private salary",apply_url:"https://example.invalid/private"}]})}));
 expect(screen.queryByText("Late unlocked company")).toBeNull();
 expect(document.body.textContent).not.toContain("Private salary");
});

it("ignores an old public city response after a newer city selection", async () => {
  let release!: (v: any) => void;
  h.publicResult = () => new Promise(resolve => { release = resolve; });
  await selectCity();
  const oldRelease = release;
  h.publicResult = async () => ({ data: [{ id: "new-row", title: "Current city role", company: "Masked", location: "Bangalore" }], count: 1, error: null });
  fireEvent.click(screen.getByRole("button", { name: /Delhi.*IN/ }));
  await screen.findByText("Current city role");
  await act(async () => oldRelease({ data: [{ id: "old-row", title: "Obsolete city role" }], count: 20, error: null }));
  expect(screen.queryByText("Obsolete city role")).toBeNull();
  expect(screen.getByText("Current city role")).toBeTruthy();
});
it("discards a pending public query on drawer close", async () => {
  let release!: (v: any) => void;
  h.publicResult = () => new Promise(resolve => { release = resolve; });
  await selectCity();
  fireEvent.click(screen.getByRole("button", { name: /Close.*drawer/i }));
  await act(async () => release({ data: [{ id: "old-row", title: "Closed drawer role" }], count: 1, error: null }));
  expect(screen.queryByText("Closed drawer role")).toBeNull();
});

it("clears unlocked rows immediately while a downgrade public reload is pending", async () => {
  await selectCity();
  await act(async () => h.resolve!({ isPro: true }));
  await screen.findByText("Unlocked fixture");
  h.publicResult = () => new Promise(() => {});
  await act(async () => window.dispatchEvent(new Event("careermonke_pro_updated")));
  await act(async () => h.resolve!({ isPro: false }));
  expect(screen.queryByText("Unlocked fixture")).toBeNull();
  expect(screen.queryByRole("link", { name: /Direct Apply/ })).toBeNull();
});
it("does not append a pending old page after selecting a new city", async () => {
  h.publicResult = async () => ({ data: [{ id: "first", title: "First city page one" }], count: 20, error: null });
  await selectCity();
  let release!: (v: any) => void;
  h.publicResult = () => new Promise(resolve => { release = resolve; });
  fireEvent.click(await screen.findByRole("button", { name: /Load More/ }));
  await waitFor(() => expect(h.query).toHaveBeenCalledTimes(2));
  h.publicResult = async () => ({ data: [{ id: "current", title: "New city current row" }], count: 1, error: null });
  fireEvent.click(screen.getByRole("button", { name: /Delhi.*IN/ }));
  await screen.findByText("New city current row");
  await act(async () => release({ data: [{ id: "old-page", title: "Old city appended page" }], count: 20, error: null }));
  expect(screen.queryByText("Old city appended page")).toBeNull();
  expect(screen.queryByText("First city page one")).toBeNull();
});
it("aborts the unlock transport on close and ignores a late response anyway", async () => {
  await selectCity();
  let release!: (v: any) => void;
  let signal!: AbortSignal;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn((url: any, init: any) => url === "/api/jobs/pro"
    ? new Promise(resolve => { signal = init.signal; h.unlock(); release = resolve; }) : realFetch(url, init)));
  await act(async () => h.resolve!({ isPro: true }));
  await waitFor(() => expect(h.unlock).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: /Close.*drawer/i }));
  expect(signal.aborted).toBe(true);
  await act(async () => release({ ok: true, json: async () => ({ jobs: [{ id: "fixture-job", company: "Closed private company" }] }) }));
  expect(screen.queryByText("Closed private company")).toBeNull();
});

it("ignores old unlock JSON resolved after downgrade", async () => {
  await selectCity();
  let release!: (v: any) => void;
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", vi.fn(async (url: any, init: any) => url === "/api/jobs/pro"
    ? { ok: true, json: () => new Promise(resolve => { release = resolve; }) } : realFetch(url, init)));
  await act(async () => h.resolve!({ isPro: true }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  await act(async () => window.dispatchEvent(new Event("careermonke_pro_updated")));
  await act(async () => h.resolve!({ isPro: false }));
  await act(async () => release({ jobs: [{ id: "fixture-job", company: "Late private JSON" }] }));
  expect(screen.queryByText("Late private JSON")).toBeNull();
});
it("discards old filter response after Verified Only changes", async () => {
  let release!: (v: any) => void;
  h.publicResult = () => new Promise(resolve => { release = resolve; });
  await selectCity();
  const oldRelease = release;
  h.publicResult = async () => ({ data: [{ id: "verified", title: "Current verified role" }], count: 1, error: null });
  fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
  fireEvent.click(screen.getByRole("button", { name: /Verified Only/ }));
  await screen.findByText("Current verified role");
  await act(async () => oldRelease({ data: [{ id: "old", title: "Obsolete unfiltered role" }], count: 20, error: null }));
  expect(screen.queryByText("Obsolete unfiltered role")).toBeNull();
});
