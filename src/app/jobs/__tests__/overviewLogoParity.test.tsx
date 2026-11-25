// @vitest-environment jsdom
// Listing -> Overview company logo parity: the Overview uses the same CompanyLogo inputs (logo, domain) as the card,
// detail hydration that omits them keeps the SAME job's permitted values, a different job never inherits them,
// direct loads use the detail's own fields, broken images fall back safely, and locked viewers get the silhouette.
// FIXTURE identities only (.invalid domains); nothing is guessed from names.
import React from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { fixtureJob, flush, h, installBrowserStandIns, page, resetHarness } from "./jobsHarness";
import type { LiveJob } from "@/lib/jobs/service";

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
import { keepSameJobLogoIdentity } from "@/lib/jobs/service";

const avatar = (domain: string) => `https://unavatar.io/${domain}?fallback=false`;
const overviewRow = () => screen.getByTestId("overview-logo-row");
const overviewImgSrc = () => within(overviewRow()).queryByRole("img")?.getAttribute("src") ?? null;
// Detail fetched for the same job, but (like the old Pro detail mapping) without logo / domain.
const bareDetail = (j: LiveJob): LiveJob => ({ ...j, description: "FIXTURE full description long enough to not refetch the record.", logoUrl: null, logo_url: null, companyDomain: undefined });

beforeAll(() => installBrowserStandIns());
beforeEach(() => { resetHarness(); localStorage.clear(); window.history.replaceState(null, "", "/jobs"); });
afterEach(() => cleanup());

async function mount(url = "/jobs") {
  window.history.replaceState(null, "", url);
  render(<JobsPage />);
  await flush();
}
const pro = () => { h.user = { id: "fx-pro", email: "pro@example.invalid" }; h.isPro = true; };

describe("keepSameJobLogoIdentity", () => {
  const listing = fixtureJob(1, { logoUrl: "https://cdn.same.invalid/l.png", logo_url: "https://cdn.same.invalid/l.png", companyDomain: "same.invalid" });
  it("fills only missing logo/domain for the same job id", () => {
    const out = keepSameJobLogoIdentity({ ...listing, logoUrl: null, logo_url: null, companyDomain: null }, listing);
    expect([out.logoUrl, out.logo_url, out.companyDomain]).toEqual(["https://cdn.same.invalid/l.png", "https://cdn.same.invalid/l.png", "same.invalid"]);
    const own = keepSameJobLogoIdentity({ ...listing, logoUrl: "https://cdn.own.invalid/x.png", companyDomain: "own.invalid" }, listing);
    expect([own.logoUrl, own.companyDomain]).toEqual(["https://cdn.own.invalid/x.png", "own.invalid"]);
  });
  it("never carries identity to a different job, a failed unlock, or invents one", () => {
    const other = fixtureJob(2, { logoUrl: null, companyDomain: null });
    expect(keepSameJobLogoIdentity(other, listing)).toBe(other);
    const failed = { ...listing, logoUrl: null, companyDomain: null, proUnlockError: { status: 403, message: "x" } };
    expect(keepSameJobLogoIdentity(failed, listing).companyDomain).toBeNull();
    const plain = fixtureJob(3, { logoUrl: null, companyDomain: null });
    expect(keepSameJobLogoIdentity(plain, { ...plain }).companyDomain).toBeNull();
  });
});

describe("Pro: listing card and Overview show the same logo", () => {
  it("same job: detail without logo/domain keeps the card's domain logo (the Mozilla case)", async () => {
    pro();
    const a = fixtureJob(1, { title: "Fixture Parity Role", logoUrl: null, companyDomain: "parity-a.invalid", applyUrl: "https://boards.greenhouse.io/fx/jobs/1" });
    h.transport = async () => page([a], false, 1);
    h.byId = async (id) => (id === a.id ? bareDetail(a) : null);
    await mount();
    const cardSrcs = Array.from(document.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(cardSrcs).toContain(avatar("parity-a.invalid"));
    fireEvent.click(screen.getAllByText("Fixture Parity Role")[0]);
    await flush();
    expect(overviewImgSrc()).toBe(avatar("parity-a.invalid"));
  });

  it("different job: never inherits the previous job's logo or domain", async () => {
    pro();
    const a = fixtureJob(1, { title: "Fixture Iso A", logoUrl: null, companyDomain: "iso-a.invalid" });
    const b = fixtureJob(2, { title: "Fixture Iso B", logoUrl: null, companyDomain: null, applyUrl: "https://jobs.lever.co/fx/2" });
    h.transport = async () => page([a, b], false, 2);
    h.byId = async (id) => (id === a.id ? bareDetail(a) : id === b.id ? bareDetail(b) : null);
    await mount();
    fireEvent.click(screen.getAllByText("Fixture Iso A")[0]);
    await flush();
    expect(overviewImgSrc()).toBe(avatar("iso-a.invalid"));
    fireEvent.click(screen.getAllByLabelText(/back/i)[0]);
    await flush();
    fireEvent.click(screen.getAllByText("Fixture Iso B")[0]);
    await flush();
    expect(overviewImgSrc()).toBeNull(); // letter tile: B has no logo, no domain and an ATS apply URL
    expect(overviewRow().innerHTML).not.toContain("iso-a.invalid");
  });

  it("direct link / reload: uses the detail's own logo fields", async () => {
    pro();
    h.transport = async () => page([], false, 0);
    h.byId = async (id) => (id === "fx-9" ? fixtureJob(9, { title: "Fixture Direct Role", logoUrl: null, companyDomain: "direct.invalid" }) : null);
    await mount("/jobs?id=fx-9");
    expect(overviewImgSrc()).toBe(avatar("direct.invalid"));
  });

  it("broken stored logo falls back to the domain logo, then a letter tile; never a broken image", async () => {
    pro();
    const logo = "https://cdn.broken-parity.invalid/logo.png";
    const a = fixtureJob(1, { title: "Fixture Broken Role", logoUrl: logo, logo_url: logo, companyDomain: "broken-parity.invalid" });
    h.transport = async () => page([a], false, 1);
    h.byId = async () => bareDetail(a);
    await mount();
    fireEvent.click(screen.getAllByText("Fixture Broken Role")[0]);
    await flush();
    expect(overviewImgSrc()).toBe(logo);
    await act(async () => fireEvent.error(within(overviewRow()).getByRole("img")));
    expect(overviewImgSrc()).toBe(avatar("broken-parity.invalid"));
    await act(async () => fireEvent.error(within(overviewRow()).getByRole("img")));
    expect(overviewImgSrc()).toBeNull();
    expect(overviewRow().textContent).toContain("F"); // letter tile from the employer name
  });
});

describe("locked viewers", () => {
  it("Free: Overview shows the neutral silhouette, no image, no domain", async () => {
    h.user = { id: "fx-free", email: "free@example.invalid" };
    h.isPro = false;
    const a = fixtureJob(1, { title: "Fixture Locked Parity", logoUrl: null, companyDomain: null });
    h.transport = async () => page([a], false, 1);
    h.byId = async () => bareDetail(a);
    await mount();
    fireEvent.click(screen.getAllByText("Fixture Locked Parity")[0]);
    await flush();
    expect(within(overviewRow()).getByTestId("company-logo-locked")).toBeTruthy();
    expect(within(overviewRow()).queryByRole("img")).toBeNull();
  });
});
