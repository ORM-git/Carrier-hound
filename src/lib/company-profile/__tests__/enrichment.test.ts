import { describe, expect, it } from "vitest";
import { extractOfficialCompanyPage, isAllowedCompanyProfileWriteTarget, parseEnrichmentOptions, reconcileCompanyFacts } from "../enrichment";
import fixture from "@/../scripts/fixtures/company-profile/official-pages.json";

describe("official company enrichment", () => {
  it("defaults to dry-run and requires an explicit positive bounded cap", () => {
    expect(parseEnrichmentOptions(["--max-rows", "8"])).toEqual({ write: false, cap: 8 });
    expect(parseEnrichmentOptions(["--write", "--max-rows", "10"]).write).toBe(true);
    for (const cap of [undefined, "0", "-1", "1.5", "101"]) {
      expect(() => parseEnrichmentOptions(cap === undefined ? [] : ["--max-rows", cap])).toThrow("--max-rows");
    }
    expect(isAllowedCompanyProfileWriteTarget("https://staging-ref.supabase.co", "staging", "staging-ref")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("https://szakevhxhwpeskidvtfs.supabase.co", "staging", "szakevhxhwpeskidvtfs")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://staging-ref.supabase.co", "production", "staging-ref")).toBe(false);
  });
  it("extracts only verified first-party structured facts, leaders, and dated news", () => {
    const result = extractOfficialCompanyPage({ ...fixture.affirm, retrievedAt: "2026-11-22T10:00:00Z" });
    expect(result.verified).toBe(true);
    expect(result.facts.headquarters?.value).toBe("San Francisco, California, US");
    expect(result.facts.founded_year?.value).toBe("2012");
    expect(result.leadership[0]?.role).toBe("CEO");
    expect(result.news[0]?.publishedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("rejects a namesake org and preserves existing values on empty or conflicting coverage", () => {
    expect(extractOfficialCompanyPage({ ...fixture.namesake, retrievedAt: "2026-11-22T10:00:00Z" }).verified).toBe(false);
    const current = { headquarters: { value: "Toronto", sourceUrl: "https://affirm.com/about", sourceKind: "official_site" as const, retrievedAt: "2026-01-01T00:00:00Z" } };
    expect(reconcileCompanyFacts(current, {}, true)).toEqual(current);
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, value: "Vancouver" } }, true)).toEqual(current);
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, value: "Toronto" } }, false)).toEqual(current);
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, retrievedAt: "2025-01-01T00:00:00Z" } }, true)).toEqual(current);
  });
});
