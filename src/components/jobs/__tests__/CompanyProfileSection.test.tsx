// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import JobDetailView from "../JobDetailView";
import type { LiveJob } from "@/lib/jobs/service";

vi.mock("@/components/CookieNotice", () => ({ useCookieNoticeHeight: () => 0 }));
vi.mock("@/components/CompanyLogo", () => ({ default: () => <div aria-hidden="true" /> }));
vi.mock("@/components/jobs/JobAiToolsPanel", () => ({ default: () => null }));

const baseJob = (): LiveJob => ({
  id: "job-current", title: "Product Engineer", company: "Acme Corp", companyId: "company-1", company_id: "company-1",
  location: "Remote US", date: "1d ago", salary: "", category: "engineering", remote: true, country: "US", type: "Full-time",
  directSource: true, applyUrl: "https://jobs.example/apply", description: "Job description long enough to render.",
  companyProfile: {
    companyId: "company-1",
    facts: { overview: { value: "Acme builds software for teams.", sourceUrl: "https://acme.example/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" }, website: { value: "https://acme.example/a/very/long/company/path", sourceUrl: "https://acme.example/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" }, headquarters: { value: "Boston, US", sourceUrl: "https://acme.example/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" } },
    leadership: [{ id: "leader-1", name: "Alex Example", role: "CEO", roleAsOf: null, sourceUrl: "https://acme.example/team", retrievedAt: "2026-11-22T00:00:00Z" }],
    news: [{ id: "news-1", headline: "Acme announces a product", publishedAt: "2026-11-20T00:00:00Z", sourceUrl: "https://acme.example/news", excerpt: null }],
    jobs: { status: "ready", jobs: [{ id: "job-other", title: "Design Engineer", company: "Acme Corp", location: "Boston, US", postedAt: null }] },
    freshness: "fresh",
  },
});

function renderDetail(job = baseJob(), onSelectJob = vi.fn()) {
  return render(<JobDetailView job={job} candidate={null} user={null} isPro isSaved={false} onSave={() => {}} onApply={() => {}} onBack={() => {}} onSelectJob={onSelectJob} />);
}

afterEach(() => cleanup());

describe("Company section", () => {
  it("fills headed description bullets immediately above Company without changing source text", () => {
    const description = "About the team\nWe build software.\nResponsibilities\n- Build tools.\nQualifications\n- Go experience.\nBenefits\n- Paid leave.";
    const { container } = renderDetail({ ...baseJob(), description });
    const headings = Array.from(container.querySelectorAll("h2")).map(el => el.textContent);
    expect(headings.indexOf("Responsibilities")).toBeLessThan(headings.indexOf("Qualifications"));
    expect(headings.indexOf("Benefits") + 1).toBe(headings.indexOf("Company"));
    expect(screen.getByText("Build tools.")).toBeTruthy();
    expect(screen.getByText("Paid leave.")).toBeTruthy();
    expect(container.querySelector(".whitespace-pre-wrap")?.textContent).toBe(description);
  });

  it("prefers an explicit source section and keeps unstructured prose only in description", () => {
    const job = { ...baseJob(), responsibilities: ["Explicit source duty"], description: "Responsibilities\n- Derived duty" };
    renderDetail(job);
    expect(screen.getByText("Explicit source duty")).toBeTruthy();
    expect(screen.queryByText("Derived duty")).toBeNull();
    cleanup();
    renderDetail({ ...baseJob(), description: "Benefits include paid leave, but this is plain prose." });
    expect(screen.queryByRole("heading", { name: "Benefits" })).toBeNull();
  });

  it("renders sourced facts, leadership, dated news, and company-scoped jobs", () => {
    renderDetail();
    expect(screen.getByText("Acme builds software for teams.")).toBeTruthy();
    expect(screen.getAllByText("Boston, US")).toHaveLength(2);
    const website = screen.getByRole("link", { name: "acme.example" });
    expect(website.getAttribute("href")).toBe("https://acme.example/a/very/long/company/path");
    expect(website.className).toContain("break-words");
    expect(website.className).not.toContain("break-all");
    expect(screen.getByText(/Alex Example/)).toBeTruthy();
    expect(screen.getByText("Acme announces a product")).toBeTruthy();
    // The job's own location is labelled as such inside the Company card; HQ only comes from the sourced fact.
    expect(document.getElementById("company-section")!.textContent).toContain("Job location: Remote US");
    expect(screen.getByText("Headquarters")).toBeTruthy();
    expect(screen.getByText("Design Engineer")).toBeTruthy();
  });

  it("distinguishes an empty company-job result from unavailable data and selects its job id", () => {
    const onSelect = vi.fn();
    renderDetail(baseJob(), onSelect);
    fireEvent.click(screen.getByText("Design Engineer"));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "job-other", companyId: "company-1", applyUrl: "" }));
    cleanup();
    renderDetail({ ...baseJob(), companyProfile: { ...baseJob().companyProfile!, jobs: { status: "ready", jobs: [] } } });
    expect(screen.getByText("No other open jobs found.")).toBeTruthy();
    cleanup();
    renderDetail({ ...baseJob(), companyProfile: { ...baseJob().companyProfile!, jobs: { status: "error", jobs: [] } } });
    expect(screen.getByText("Company jobs could not be loaded.")).toBeTruthy();
  });

  it("shows stale and conflicting profile freshness without replacing the verified value", () => {
    const job = baseJob();
    job.companyProfile!.freshness = "conflict";
    job.companyProfile!.facts.headquarters!.status = "conflict";
    job.companyProfile!.facts.headquarters!.conflict = { value: "Toronto, Canada", sourceUrl: "https://acme.example/locations", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" };
    renderDetail(job);
    expect(screen.getByText(/conflicting sources/)).toBeTruthy();
    expect(screen.getAllByText("Boston, US")).toHaveLength(2);
    expect(screen.getByRole("link", { name: /Conflicting report/ })).toBeTruthy();
    cleanup();
    renderDetail({ ...baseJob(), companyProfile: { ...baseJob().companyProfile!, freshness: "stale" } });
    expect(screen.getByText(/may be out of date/)).toBeTruthy();
    expect(screen.queryByText(/not available yet/)).toBeNull();
  });

  it("says details are not available yet for a never-enriched company", () => {
    renderDetail({ ...baseJob(), companyProfile: { companyId: "company-1", facts: {}, leadership: [], news: [], jobs: { status: "ready", jobs: [] }, freshness: "stale" } });
    expect(screen.getByText("Company details are not available yet.")).toBeTruthy();
    expect(screen.queryByText(/may be out of date/)).toBeNull();
  });

  it("hides the floating back-to-top button on phones only while the Company tab is open", () => {
    const { container } = renderDetail();
    expect(container.querySelector("style")).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: "Company" })[0]);
    expect(container.querySelector("style")?.textContent).toContain('@media (max-width: 767px) { button[aria-label="Back to top"] { display: none; } }');
    fireEvent.click(screen.getAllByRole("button", { name: "Overview" })[0]);
    expect(container.querySelector("style")).toBeNull();
  });

  it("scrolls the Company heading below the measured sticky header", async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false }) });
    const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.id === "company-section" ? 450 : 56;
      const bottom = this.getAttribute("aria-label") === "Job header" ? 212 : top + 100;
      return { x: 0, y: top, top, bottom, left: 0, right: 400, width: 400, height: bottom - top, toJSON: () => ({}) } as DOMRect;
    });
    renderDetail();
    screen.getByRole("region", { name: "Job header" }).setAttribute("style", "top: 56px");
    fireEvent.click(screen.getAllByRole("button", { name: "Company" })[0]);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 226, behavior: "smooth" }));
    rectSpy.mockRestore();
  });
});
