/**
 * Read-only coverage report for a company-profile canary plan (rows 30/31 measurement).
 * Input: a plan JSON already written by scripts/enrich-company-profiles.ts (dry-run). No database, no network,
 * no credentials. Output: counts, ages and empty reasons only. It never prints fact values, headlines,
 * person names or source URLs, so a report can be shared without exporting profile rows.
 *
 *   npx tsx scripts/report-company-profile-coverage.ts --plan ../canary/plan-<DATE>.json --out ../canary/coverage-<DATE>.json
 *
 * Ages use the plan's own created_at (or --now <ISO>) so a report is reproducible. Limits mirror
 * evaluateCompanyProfileFreshness: facts 180 days, leaders 30 days, news 90 days (by retrieved_at).
 * The stale comparison uses the SAME exact fractional age as the runtime rule (never a floored display
 * age), and rows with no usable date are stale by that rule (infinite age): they are counted in
 * stale_by_runtime and shown separately as unknown_age, so the report cannot understate runtime-stale rows.
 */
import fs from "node:fs";
import path from "node:path";

export const FACT_STALE_DAYS = 180;
export const LEADER_STALE_DAYS = 30;
export const NEWS_STALE_DAYS = 90;
const FACT_KEYS = ["overview", "website", "headquarters", "founded_year", "employee_count_range", "linkedin_url", "twitter_url", "funding_stage"] as const;

type Row = Record<string, string | null>;
export interface PlanLike {
  kind?: string; created_at?: string; target_project?: string;
  companies: Array<{
    company_id: string; name?: string; outcome?: string; error?: string | null;
    freshness?: { status?: string; should_refresh?: boolean };
    proposed?: { facts?: Row[]; leadership?: Row[]; news?: Row[] };
    current: { company_profile_facts?: Row[]; company_profile_leadership?: Row[]; company_profile_news?: Row[]; company_profile_refresh_state?: Row[] };
  }>;
}

export interface SectionCoverage { current: number; proposed: number; stale: number; stale_by_runtime: number; oldest_age_days: number | null; unknown_age: number }
export interface CompanyCoverage {
  company_id: string; name: string | null; outcome: string; freshness: string | null; should_refresh: boolean | null; error_present: boolean;
  facts: SectionCoverage & { keys_present: string[]; keys_missing: string[]; conflicts: number };
  leadership: SectionCoverage & { undated_role: number };
  news: SectionCoverage;
}
export interface CoverageReport {
  kind: "company-profile-coverage-report"; read_only: true; writes: 0; database: "not contacted"; network: "not used";
  as_of: string; plan_target_project: string | null; limits_days: { facts: number; leadership: number; news: number };
  totals: { companies: number; with_any_current_row: number; with_facts: number; with_leaders: number; with_news: number; stale_leaders: number; stale_news: number; stale_facts: number; stale_leaders_by_runtime: number; stale_news_by_runtime: number; stale_facts_by_runtime: number; outcomes: Record<string, number> };
  companies: CompanyCoverage[];
  notes: string[];
}

// Exact fractional age, the same quantity evaluateCompanyProfileFreshness compares (`daysOld > limit`).
const ageDaysExact = (iso: string | null | undefined, asOf: number): number | null => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? (asOf - t) / 86_400_000 : null;
};

function section(rows: Row[], proposed: Row[], limit: number, asOf: number, dateOf: (r: Row) => string | null | undefined): SectionCoverage {
  const ages = rows.map((r) => ageDaysExact(dateOf(r), asOf));
  const known = ages.filter((a): a is number => a !== null);
  // Exact comparison, like the runtime: a 30.9-day-old leader IS stale (a floored display age would hide that).
  const stale = known.filter((a) => a > limit).length;
  // The runtime treats a missing/unparseable date as infinitely old, i.e. stale. Keep those rows visible as
  // unknown_age AND count them in stale_by_runtime so the report never understates runtime-stale rows.
  const unknown = ages.length - known.length;
  return { current: rows.length, proposed: proposed.length, stale, stale_by_runtime: stale + unknown, oldest_age_days: known.length ? Math.max(0, Math.floor(Math.max(...known))) : null, unknown_age: unknown };
}

export function buildCoverageReport(plan: PlanLike, nowIso?: string): CoverageReport {
  if (!plan || !Array.isArray(plan.companies)) throw new Error("Not a canary plan: companies[] missing");
  const asOfIso = nowIso || plan.created_at;
  const asOf = asOfIso ? Date.parse(asOfIso) : NaN;
  if (!Number.isFinite(asOf)) throw new Error("No valid as-of time: the plan has no created_at and --now was not given");
  const companies: CompanyCoverage[] = plan.companies.map((c) => {
    const facts = c.current.company_profile_facts || [];
    const leaders = c.current.company_profile_leadership || [];
    const news = c.current.company_profile_news || [];
    const present = FACT_KEYS.filter((k) => facts.some((f) => f.fact_key === k));
    return {
      company_id: c.company_id, name: c.name ?? null, outcome: c.outcome || "unknown", freshness: c.freshness?.status ?? null,
      should_refresh: c.freshness?.should_refresh ?? null, error_present: Boolean(c.error),
      facts: { ...section(facts, c.proposed?.facts || [], FACT_STALE_DAYS, asOf, (r) => r.retrieved_at), keys_present: [...present], keys_missing: FACT_KEYS.filter((k) => !present.includes(k)), conflicts: facts.filter((f) => f.fact_status === "conflict" || f.conflict_value).length },
      leadership: { ...section(leaders, c.proposed?.leadership || [], LEADER_STALE_DAYS, asOf, (r) => r.retrieved_at), undated_role: leaders.filter((r) => !r.role_as_of).length },
      news: section(news, c.proposed?.news || [], NEWS_STALE_DAYS, asOf, (r) => r.retrieved_at || r.published_at),
    };
  });
  const outcomes: Record<string, number> = {};
  for (const c of companies) outcomes[c.outcome] = (outcomes[c.outcome] || 0) + 1;
  return {
    kind: "company-profile-coverage-report", read_only: true, writes: 0, database: "not contacted", network: "not used",
    as_of: new Date(asOf).toISOString(), plan_target_project: plan.target_project ?? null,
    limits_days: { facts: FACT_STALE_DAYS, leadership: LEADER_STALE_DAYS, news: NEWS_STALE_DAYS },
    totals: {
      companies: companies.length,
      with_any_current_row: companies.filter((c) => c.facts.current + c.leadership.current + c.news.current > 0).length,
      with_facts: companies.filter((c) => c.facts.current > 0).length, with_leaders: companies.filter((c) => c.leadership.current > 0).length, with_news: companies.filter((c) => c.news.current > 0).length,
      stale_leaders: companies.reduce((n, c) => n + c.leadership.stale, 0), stale_news: companies.reduce((n, c) => n + c.news.stale, 0), stale_facts: companies.reduce((n, c) => n + c.facts.stale, 0),
      stale_leaders_by_runtime: companies.reduce((n, c) => n + c.leadership.stale_by_runtime, 0), stale_news_by_runtime: companies.reduce((n, c) => n + c.news.stale_by_runtime, 0), stale_facts_by_runtime: companies.reduce((n, c) => n + c.facts.stale_by_runtime, 0),
      outcomes,
    },
    companies,
    notes: [
      "Coverage is for the companies in this plan only. It is not a claim about all companies.",
      "A company with zero rows is unknown, not 'has no leaders or news'.",
      "Ages come from retrieved_at (news falls back to published_at). Stale uses the exact fractional age, like the runtime rule; only displayed ages are floored.",
      "Rows with no usable date are stale by the runtime rule (infinite age): they are counted in stale_by_runtime and shown separately as unknown_age.",
    ],
  };
}

export function renderCoverageSummary(report: CoverageReport): string {
  const lines = [`# Company profile coverage (as of ${report.as_of})`, "", `Companies in plan: ${report.totals.companies}. Read-only; no database, no network, no profile values.`, "",
    "| Company | Outcome | Freshness | Facts (stale/runtime) | Leaders (stale/runtime, oldest d) | News (stale/runtime, oldest d) | Conflicts |", "|---|---|---|---|---|---|---|"];
  for (const c of report.companies) lines.push(`| ${c.company_id} | ${c.outcome} | ${c.freshness ?? "n/a"} | ${c.facts.current} (${c.facts.stale}/${c.facts.stale_by_runtime}) | ${c.leadership.current} (${c.leadership.stale}/${c.leadership.stale_by_runtime}, ${c.leadership.oldest_age_days ?? "n/a"}) | ${c.news.current} (${c.news.stale}/${c.news.stale_by_runtime}, ${c.news.oldest_age_days ?? "n/a"}) | ${c.facts.conflicts} |`);
  return [...lines, "", ...report.notes.map((n) => `- ${n}`), ""].join("\n");
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--plan", "--out", "--now"].includes(argv[i]) || argv[i + 1] === undefined) throw new Error(`Unknown or incomplete flag: ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.plan || !out.out) throw new Error("Need --plan <plan.json> and --out <file>");
  const outPath = path.resolve(out.out);
  if (outPath.startsWith(path.resolve(process.cwd()) + path.sep)) throw new Error("--out must be outside the repository");
  if (fs.existsSync(outPath) || fs.existsSync(`${outPath}.summary.md`)) throw new Error("--out (or its .summary.md) already exists; choose a new path");
  return { plan: path.resolve(out.plan), outPath, now: out.now };
}

if (process.argv[1] && /report-company-profile-coverage\.[cm]?[tj]s$/.test(process.argv[1])) {
  try {
    const { plan, outPath, now } = parseArgs(process.argv.slice(2));
    const report = buildCoverageReport(JSON.parse(fs.readFileSync(plan, "utf8")) as PlanLike, now);
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), { flag: "wx" });
    fs.writeFileSync(`${outPath}.summary.md`, renderCoverageSummary(report), { flag: "wx" });
    console.log(JSON.stringify({ read_only: true, writes: 0, report: outPath, summary: `${outPath}.summary.md`, totals: report.totals }, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
