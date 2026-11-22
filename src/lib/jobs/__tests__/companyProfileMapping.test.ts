import { describe, expect, it } from "vitest";
import { mapCompanyProfilePayload } from "../service";

describe("Pro company profile mapping", () => {
  it("carries the same typed profile through batch and direct payload shapes", () => {
    const payload = { companyId: "canonical-123", facts: { overview: { value: "Official overview", sourceUrl: "https://example.com/about", sourceKind: "official_site", retrievedAt: "2026-11-22T00:00:00Z" } }, leadership: [], news: [], jobs: { status: "ready", jobs: [{ id: "job-2", title: "Designer", company: "Example", location: "Remote", postedAt: null }] } };
    expect(mapCompanyProfilePayload(payload, "canonical-123")).toEqual(mapCompanyProfilePayload({ ...payload }, "canonical-123"));
  });

  it("does not attach a profile without canonical identity", () => {
    expect(mapCompanyProfilePayload({ facts: {}, leadership: [], news: [] })).toBeNull();
  });
});
