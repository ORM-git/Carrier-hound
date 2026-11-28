/**
 * Regression tests for scripts/report-company-profile-coverage.ts stale accounting (rows 30/31 measurement tool).
 * The stale comparison must use the SAME exact fractional age as the runtime rule
 * (evaluateCompanyProfileFreshness), and rows with no usable date must be counted in stale_by_runtime
 * (the runtime treats them as infinitely old), so the report can never understate runtime-stale rows.
 */
import { describe, expect, it } from "vitest";
import { buildCoverageReport, FACT_STALE_DAYS, LEADER_STALE_DAYS, NEWS_STALE_DAYS, type PlanLike } from "../../../scripts/report-company-profile-coverage";
import { evaluateCompanyProfileFreshness } from "../company-profile/enrichment";

const CO = "aaaaaaaa-0000-4000-8000-000000000001";
const ASOF = "2026-11-28T00:00:00.000Z";
const asOfMs = Date.parse(ASOF);
const iso = (daysAgo: number) => new Date(asOfMs - daysAgo * 86_400_000).toISOString();

const planWith = (current: { facts?: any[]; leadership?: any[]; news?: any[] }): PlanLike => ({
  kind: "company-profile-canary-plan",
  created_at: ASOF,
  target_project: "unit-test",
  companies: [
    {
      company_id: CO,
      name: "Acme",
      outcome: "cache_hit",
      current: {
        company_profile_facts: current.facts || [],
        company_profile_leadership: current.leadership || [],
        company_profile_news: current.news || [],
      },
    },
  ],
});

// Runtime-rule cross-check fixture: a valid refresh state that is NOT due, so only the row under test can stale it.
const baseFresh = { now: ASOF, state: { status: "ok", last_succeeded_at: iso(1), next_refresh_at: iso(-10) }, facts: {} };

describe("coverage report stale comparison matches the runtime rule exactly", () => {
  it("a 30.9-day-old leader is stale (exact age), with the displayed age floored to 30", () => {
    const report = buildCoverageReport(planWith({ leadership: [{ retrieved_at: iso(30.9) }] }));
    const leaders = report.companies[0].leadership;
    expect(leaders.stale).toBe(1);
    expect(leaders.stale_by_runtime).toBe(1);
    expect(leaders.oldest_age_days).toBe(30); // display-only rounding
    expect(evaluateCompanyProfileFreshness({ ...baseFresh, leadership: [{ retrievedAt: iso(30.9) }] }).status).toBe("stale");
  });

  it("a 29.1-day-old leader is not stale anywhere", () => {
    const report = buildCoverageReport(planWith({ leadership: [{ retrieved_at: iso(29.1) }] }));
    expect(report.companies[0].leadership.stale).toBe(0);
    expect(report.companies[0].leadership.stale_by_runtime).toBe(0);
    expect(evaluateCompanyProfileFreshness({ ...baseFresh, leadership: [{ retrievedAt: iso(29.1) }] }).status).toBe("fresh");
  });

  it("a leader with a missing retrieved_at is unknown_age AND stale_by_runtime, like the runtime's infinite age", () => {
    const report = buildCoverageReport(planWith({ leadership: [{ retrieved_at: null }] }));
    const leaders = report.companies[0].leadership;
    expect(leaders.stale).toBe(0); // no dated evidence of staleness
    expect(leaders.unknown_age).toBe(1);
    expect(leaders.stale_by_runtime).toBe(1); // runtime treats it as stale; the report must not understate
    expect(evaluateCompanyProfileFreshness({ ...baseFresh, leadership: [{ retrievedAt: undefined as any }] }).status).toBe("stale");
  });

  it("news with an invalid retrieved_at AND invalid published_at is unknown_age and stale_by_runtime", () => {
    const report = buildCoverageReport(planWith({ news: [{ retrieved_at: "not-a-date", published_at: "also-not-a-date" }] }));
    const news = report.companies[0].news;
    expect(news.stale).toBe(0);
    expect(news.unknown_age).toBe(1);
    expect(news.stale_by_runtime).toBe(1);
    expect(evaluateCompanyProfileFreshness({ ...baseFresh, leadership: [], news: [{ publishedAt: "also-not-a-date", retrievedAt: "not-a-date" }] }).status).toBe("stale");
  });

  it("news falls back to published_at only when retrieved_at is ABSENT, matching the runtime's || semantics", () => {
    // Absent retrieved_at: published_at is used, compared exactly at the 90-day limit.
    const stale = buildCoverageReport(planWith({ news: [{ retrieved_at: null, published_at: iso(90.5) }] }));
    expect(stale.companies[0].news.stale).toBe(1);
    expect(stale.companies[0].news.unknown_age).toBe(0);
    const fresh = buildCoverageReport(planWith({ news: [{ retrieved_at: null, published_at: iso(89.5) }] }));
    expect(fresh.companies[0].news.stale).toBe(0);
    expect(fresh.companies[0].news.stale_by_runtime).toBe(0);
    // Present-but-invalid retrieved_at wins the || (truthy string), exactly like the runtime: infinitely old.
    const invalid = buildCoverageReport(planWith({ news: [{ retrieved_at: "not-a-date", published_at: iso(89.5) }] }));
    expect(invalid.companies[0].news.stale).toBe(0);
    expect(invalid.companies[0].news.unknown_age).toBe(1);
    expect(invalid.companies[0].news.stale_by_runtime).toBe(1);
    expect(evaluateCompanyProfileFreshness({ ...baseFresh, leadership: [], news: [{ publishedAt: iso(89.5), retrievedAt: "not-a-date" }] }).status).toBe("stale");
  });

  it("facts compare exactly at the 180-day limit", () => {
    const stale = buildCoverageReport(planWith({ facts: [{ fact_key: "overview", retrieved_at: iso(180.5), fact_status: "fresh" }] }));
    expect(stale.companies[0].facts.stale).toBe(1);
    const fresh = buildCoverageReport(planWith({ facts: [{ fact_key: "overview", retrieved_at: iso(179.5), fact_status: "fresh" }] }));
    expect(fresh.companies[0].facts.stale).toBe(0);
    expect(fresh.companies[0].facts.stale_by_runtime).toBe(0);
  });

  it("totals carry the runtime-aligned stale figures alongside the dated-only ones", () => {
    const report = buildCoverageReport(
      planWith({
        leadership: [{ retrieved_at: null }], // undated: runtime-stale only
        news: [{ retrieved_at: iso(200) }], // dated stale
      })
    );
    expect(report.totals.stale_leaders).toBe(0);
    expect(report.totals.stale_leaders_by_runtime).toBe(1);
    expect(report.totals.stale_news).toBe(1);
    expect(report.totals.stale_news_by_runtime).toBe(1);
  });

  it("exported limits still mirror the runtime rule", () => {
    expect([FACT_STALE_DAYS, LEADER_STALE_DAYS, NEWS_STALE_DAYS]).toEqual([180, 30, 90]);
  });
});
