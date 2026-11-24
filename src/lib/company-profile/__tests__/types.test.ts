import { describe, expect, it } from "vitest";
import { isEligibleCompanyJob, sanitizeCompanyProfile } from "../types";

describe("sanitizeCompanyProfile", () => {
  it("keeps only sourced facts and strips unsafe text and links", () => {
    const result = sanitizeCompanyProfile({
      companyId: "canonical-id",
      facts: {
        overview: { value: "<script>alert(1)</script>Official overview", sourceUrl: "https://example.com/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" },
        website: { value: "javascript:alert(1)", sourceUrl: "https://example.com/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" },
        headquarters: { value: "Boston", sourceUrl: "https://example.com/about", sourceKind: "official_site", retrievedAt: "invalid" },
      },
      leadership: [], news: [], jobs: { status: "unknown", jobs: [] },
    });
    expect(result?.facts.overview?.value).not.toContain("<script>");
    expect(result?.facts.website).toBeUndefined();
    expect(result?.facts.headquarters).toBeUndefined();
  });

  it("rejects missing provenance and limits related rows", () => {
    const result = sanitizeCompanyProfile({ companyId: "c", facts: { overview: { value: "unverified" } }, leadership: [], news: [], jobs: { status: "ready", jobs: Array.from({ length: 7 }, (_, id) => ({ id: String(id), title: "T", company: "C", location: "Remote" })) } });
    expect(result?.facts).toEqual({});
    expect(result?.jobs.jobs).toHaveLength(5);
  });
});

describe("canonical company job identity", () => {
  const eligible = { id: "job-2", company_id: "company-1", status: "active", is_active: true };
  it("rejects current, inactive, affiliate and namesake rows", () => {
    expect(isEligibleCompanyJob(eligible, "company-1", "job-1")).toBe(true);
    expect(isEligibleCompanyJob(eligible, "company-1", "job-2")).toBe(false);
    expect(isEligibleCompanyJob({ ...eligible, company_id: "affiliate" }, "company-1", "job-1")).toBe(false);
    expect(isEligibleCompanyJob({ ...eligible, company_id: null }, "company-1", "job-1")).toBe(false);
    expect(isEligibleCompanyJob({ ...eligible, status: "expired" }, "company-1", "job-1")).toBe(false);
    expect(isEligibleCompanyJob({ ...eligible, is_active: false }, "company-1", "job-1")).toBe(false);
  });
});
