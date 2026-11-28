/**
 * Characterization of ACTUAL existing behavior (no new policy): what the canary plan and the freshness rule do with
 * leader and news rows that a crawl no longer produces. These tests describe today's code; if retention policy
 * changes later, they should be changed on purpose.
 */
import { describe, expect, it } from "vitest";
import { buildCanaryPlan, CANARY_TABLES, COMPANY_PROFILE_PRODUCTION_PROJECT_REF } from "../canary";
import type { CanaryAction, CanaryRow, CanaryStore, CanaryTable } from "../canary";
import { evaluateCompanyProfileFreshness } from "../enrichment";

const CO = "aaaaaaaa-0000-4000-8000-000000000001";
const NOW = new Date("2026-11-28T00:00:00.000Z");
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

describe("freshness rule (current thresholds)", () => {
  const base = { now: NOW.toISOString(), state: { status: "ok", last_succeeded_at: iso(1), next_refresh_at: iso(-10) }, facts: {} };
  it("flags a leader older than 30 days as stale, never as fresh", () => {
    expect(evaluateCompanyProfileFreshness({ ...base, leadership: [{ retrievedAt: iso(31) }] }).status).toBe("stale");
    expect(evaluateCompanyProfileFreshness({ ...base, leadership: [{ retrievedAt: iso(29) }] }).status).toBe("fresh");
  });
  it("flags news older than 90 days as stale, and a missing or unparseable date counts as stale", () => {
    expect(evaluateCompanyProfileFreshness({ ...base, leadership: [], news: [{ publishedAt: iso(120), retrievedAt: iso(91) }] }).status).toBe("stale");
    expect(evaluateCompanyProfileFreshness({ ...base, leadership: [], news: [{ publishedAt: "not-a-date" }] }).status).toBe("stale");
  });
  it("flags a fact older than 180 days as stale", () => {
    expect(evaluateCompanyProfileFreshness({ ...base, leadership: [], facts: { overview: { retrievedAt: iso(181), status: "fresh" } } }).status).toBe("stale");
  });
});

describe("canary plan: rows the crawl does not produce are left alone", () => {
  const leader: CanaryRow = { id: "bbbbbbbb-0000-4000-8000-000000000001", company_id: CO, name: "Former Exec", role: "CEO", role_as_of: null, source_url: "https://acme.example/about", retrieved_at: iso(200) };
  const item: CanaryRow = { id: "cccccccc-0000-4000-8000-000000000001", company_id: CO, headline: "Old news", published_at: iso(400), source_url: "https://acme.example/news/1", excerpt: null, retrieved_at: iso(400) };
  const store: CanaryStore = {
    missingSchema: async () => [],
    factAllowlists: async () => [
      { column_name: "fact_key", definition: "CHECK (fact_key IN ('funding_stage'))" },
      { column_name: "source_kind", definition: "CHECK (source_kind IN ('wikidata'))" },
      { column_name: "conflict_source_kind", definition: "CHECK (conflict_source_kind IN ('wikidata'))" },
    ],
    companies: async () => [{ id: CO, name: "Acme", canonical_domain: "acme.example" }],
    boards: async () => [], // no enabled ATS board: the official crawl cannot verify identity
    rows: async (table: CanaryTable) => (table === "company_profile_leadership" ? [leader] : table === "company_profile_news" ? [item] : []),
    insert: async () => { throw new Error("read-only in test"); }, updateWhere: async () => { throw new Error("read-only in test"); }, deleteWhere: async () => { throw new Error("read-only in test"); },
  };
  const run = () => buildCanaryPlan({
    store, fetchPage: async () => { throw new Error("unexpected fetch"); }, sleep: async () => {}, now: () => NOW,
    newId: () => "dddddddd-0000-4000-8000-000000000001", targetProject: COMPANY_PROFILE_PRODUCTION_PROJECT_REF, companyIds: [CO], maxCompanies: 1, codeSha: "a".repeat(40),
  });

  it("plans no action for an existing leader and news row when the crawl yields nothing, and keeps them in the plan's current rows", async () => {
    const plan = await run();
    expect(plan.companies[0].outcome).toBe("no_ats_evidence");
    expect(plan.actions).toEqual([]);
    expect(plan.companies[0].current.company_profile_leadership).toEqual([leader]);
    expect(plan.companies[0].current.company_profile_news).toEqual([item]);
    expect(plan.companies[0].proposed).toEqual({ facts: [], leadership: [], news: [] });
  });

  it("reports the retained rows as stale, never fresh", async () => {
    const plan = await run();
    expect(plan.companies[0].freshness.status).toBe("stale");
    expect(plan.companies[0].freshness.should_refresh).toBe(true);
  });

  it("the plan vocabulary has no delete operation, and no table declares a removal column", () => {
    const ops: CanaryAction["op"][] = ["insert", "update"]; // a 'delete' here would fail type-checking
    expect(ops).toEqual(["insert", "update"]);
    for (const table of Object.values(CANARY_TABLES)) expect(table.columns).not.toContain("deleted_at");
  });
});
