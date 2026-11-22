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
    expect(isAllowedCompanyProfileWriteTarget("https://Staging-Ref.Supabase.Co.", "staging", "staging-ref")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("http://127.0.0.1:54321", "local", "local")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("http://[::1]:54321", "local", "local")).toBe(true);
    expect(isAllowedCompanyProfileWriteTarget("https://remote.example", "local", "local")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://szakevhxhwpeskidvtfs.supabase.co.", "local", "local")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://SZakevhxhwpeskidvtfs.SUPABASE.CO.", "staging", "szakevhxhwpeskidvtfs")).toBe(false);
    expect(isAllowedCompanyProfileWriteTarget("https://staging-ref.supabase.co", "production", "staging-ref")).toBe(false);
  });
  it("extracts only verified first-party structured facts, leaders, and dated news", () => {
    const result = extractOfficialCompanyPage({ ...fixture.affirm, retrievedAt: "2026-11-22T10:00:00Z", atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }] });
    expect(result.verified).toBe(true);
    expect(result.facts.headquarters?.value).toBe("San Francisco, California, US");
    expect(result.facts.founded_year?.value).toBe("2012");
    expect(result.leadership[0]?.role).toBe("CEO");
    expect(result.facts.linkedin_url?.value).toBe("https://www.linkedin.com/company/affirm");
    expect(result.facts.twitter_url?.value).toBe("https://x.com/affirm");
    expect(result.news[0]?.publishedAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("extracts affiliated leaders and dated news from an ATS-linked about subpage", async () => {
    const loaded = await import("../enrichment");
    const extractSubpage = (loaded as typeof loaded & { extractOfficialCompanySubpage?: (input: any) => ReturnType<typeof extractOfficialCompanyPage> }).extractOfficialCompanySubpage;
    expect(typeof extractSubpage).toBe("function");
    if (!extractSubpage) return;
    const result = extractSubpage({ ...fixture.affirmSubpage, atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }], retrievedAt: "2026-11-22T10:00:00Z" });
    expect(result.verified).toBe(true);
    expect(result.leadership).toEqual([expect.objectContaining({ name: "Max Levchin", role: "CEO" })]);
    expect(result.news).toEqual([expect.objectContaining({ headline: "Company update" })]);
  });

  it("rejects unlinked ATS boards, leaders affiliated with another company, and personal profile links", () => {
    const unrelatedBoard = { ...fixture.affirm, atsBoards: [{ ats_type: "greenhouse", slug: "unrelated", careers_url: "https://boards.greenhouse.io/unrelated" }] };
    expect(extractOfficialCompanyPage(unrelatedBoard).verified).toBe(false);

    const wrongAffiliation = {
      ...fixture.affirm,
      atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }],
      html: fixture.affirm.html.replace('"@id":"https://affirm.com/#organization","name":"Affirm"}', '"@id":"https://affirm.com/#organization","name":"Affirm"}').replace('"worksFor":{"@id":"https://affirm.com/#organization","name":"Affirm"}', '"worksFor":{"@id":"https://customer.com/#organization","name":"Customer"}'),
    };
    expect(extractOfficialCompanyPage(wrongAffiliation).leadership).toEqual([]);

    const personalSocial = {
      ...fixture.affirm,
      atsBoards: [{ ats_type: "greenhouse", slug: "affirm", careers_url: "https://boards.greenhouse.io/affirm" }],
      html: fixture.affirm.html.replace('"https://www.linkedin.com/company/affirm","https://x.com/affirm"', '"https://www.linkedin.com/in/customer-person","https://x.com/employee-handle"').replace('https://www.linkedin.com/company/affirm', 'https://www.linkedin.com/in/customer-person'),
    };
    const personalResult = extractOfficialCompanyPage(personalSocial);
    expect(personalResult.facts.linkedin_url).toBeUndefined();
    expect(personalResult.facts.twitter_url).toBeUndefined();
  });

  it("rejects a namesake org and preserves existing values on empty or conflicting coverage", () => {
    expect(extractOfficialCompanyPage({ ...fixture.namesake, retrievedAt: "2026-11-22T10:00:00Z" }).verified).toBe(false);
    const current = { headquarters: { value: "Toronto", sourceUrl: "https://affirm.com/about", sourceKind: "official_site" as const, retrievedAt: "2026-01-01T00:00:00Z" } };
    expect(reconcileCompanyFacts(current, {}, true)).toEqual(current);
    const conflict = reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, value: "Vancouver", retrievedAt: "2026-11-22T10:00:00Z" } }, true);
    expect(conflict.headquarters?.value).toBe("Toronto");
    expect((conflict.headquarters as any)?.status).toBe("conflict");
    expect((conflict.headquarters as any)?.conflict?.value).toBe("Vancouver");
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, value: "Toronto" } }, false)).toEqual(current);
    expect(reconcileCompanyFacts(current, { headquarters: { ...current.headquarters, retrievedAt: "2025-01-01T00:00:00Z" } }, true)).toEqual(current);
    const newer = reconcileCompanyFacts({ headquarters: { ...current.headquarters, observedAt: "2020-01-01T00:00:00Z" } }, { headquarters: { ...current.headquarters, value: "Vancouver", retrievedAt: "2026-11-22T10:00:00Z", observedAt: "2026-11-20T00:00:00Z" } }, true);
    expect(newer.headquarters?.value).toBe("Vancouver");
    expect((newer.headquarters as any)?.status).toBe("fresh");
  });

  it("honors robots wildcards and every user-agent in a group", async () => {
    const loaded = await import("../enrichment");
    const robotsAllows = (loaded as typeof loaded & { robotsAllows?: (robots: string, path: string) => boolean }).robotsAllows;
    expect(typeof robotsAllows).toBe("function");
    if (!robotsAllows) return;
    expect(robotsAllows("User-agent: *\nDisallow: /news/*", "/news/private")).toBe(false);
    expect(robotsAllows("User-agent: *\nUser-agent: OtherBot\nDisallow: /", "/")).toBe(false);
    expect(robotsAllows("User-agent: *\nDisallow: /news/*\nAllow: /news/public$", "/news/public")).toBe(true);
  });

  it("keeps a resumable cursor before the company that stopped the batch", async () => {
    const loaded = await import("../enrichment");
    const processCompanyBatch = (loaded as typeof loaded & { processCompanyBatch?: (...args: any[]) => Promise<any> }).processCompanyBatch;
    expect(typeof processCompanyBatch).toBe("function");
    if (!processCompanyBatch) return;
    const attempted: string[] = [];
    const progress = await processCompanyBatch(
      [{ id: "company-a" }, { id: "company-b" }, { id: "company-c" }],
      null,
      async (company: { id: string }) => {
        attempted.push(company.id);
        if (company.id === "company-a") throw new Error("HTTP 403 forbidden");
      },
    );
    expect(attempted).toEqual(["company-a"]);
    expect(progress.nextAfterId).toBeNull();
    expect(progress.error?.companyId).toBe("company-a");
  });

  it("caches fresh profiles but rechecks stale facts, leaders, news, and conflict records", async () => {
    const loaded = await import("../enrichment");
    const evaluate = (loaded as typeof loaded & { evaluateCompanyProfileFreshness?: (input: any) => any }).evaluateCompanyProfileFreshness;
    expect(typeof evaluate).toBe("function");
    if (!evaluate) return;
    const now = "2026-11-22T00:00:00.000Z";
    const fresh = evaluate({
      now,
      state: { status: "fresh", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" },
      facts: { overview: { value: "Acme", retrievedAt: "2026-11-21T00:00:00.000Z" } },
      leadership: [{ retrievedAt: "2026-11-21T00:00:00.000Z" }],
    });
    expect(fresh).toMatchObject({ status: "fresh", shouldRefresh: false });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-11-22T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { overview: { value: "Partial but valid profile", retrievedAt: "2026-11-22T00:00:00.000Z" } }, leadership: [] })).toMatchObject({ status: "fresh", shouldRefresh: false });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { overview: { value: "old", retrievedAt: "2026-01-01T00:00:00.000Z" } }, leadership: [{ retrievedAt: "2026-11-21T00:00:00.000Z" }] })).toMatchObject({ status: "stale", shouldRefresh: true });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-10-01T00:00:00.000Z", next_refresh_at: "2026-10-08T00:00:00.000Z" }, facts: {}, leadership: [{ retrievedAt: "2026-10-01T00:00:00.000Z" }] })).toMatchObject({ status: "stale", shouldRefresh: true });
    expect(evaluate({ now, state: { status: "fresh", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { overview: { retrievedAt: "2026-11-21T00:00:00.000Z" } }, leadership: [{ retrievedAt: "2026-11-21T00:00:00.000Z" }], news: [{ publishedAt: "2026-11-20T00:00:00.000Z", retrievedAt: "2026-01-01T00:00:00.000Z" }] })).toMatchObject({ status: "stale", shouldRefresh: true });
    expect(evaluate({ now, state: { status: "conflict", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-29T00:00:00.000Z" }, facts: { headquarters: { value: "Toronto", retrievedAt: "2026-11-21T00:00:00.000Z", status: "conflict" } }, leadership: [] })).toMatchObject({ status: "conflict", shouldRefresh: false });
    expect(evaluate({ now, state: { status: "stale", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-23T00:00:00.000Z", last_error: "HTTP 503" }, facts: { overview: { value: "old", retrievedAt: "2026-01-01T00:00:00.000Z" } }, leadership: [] })).toMatchObject({ status: "stale", shouldRefresh: false });
    expect(evaluate({ now: "2026-11-24T00:00:00.000Z", state: { status: "stale", last_succeeded_at: "2026-11-21T00:00:00.000Z", next_refresh_at: "2026-11-23T00:00:00.000Z", last_error: "HTTP 503" }, facts: { overview: { value: "old", retrievedAt: "2026-01-01T00:00:00.000Z" } }, leadership: [] })).toMatchObject({ status: "stale", shouldRefresh: true });
  });
});
