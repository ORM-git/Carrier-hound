/** Human-readable companion to a canary plan. The JSON plan and its digest stay the reviewed artifact. */
import type { CanaryCompanyPlan, CanaryPlan, CanaryRow, CanaryTable } from "./canary";

const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

const OUTCOME: Record<CanaryCompanyPlan["outcome"], string> = {
  cache_hit: "Skipped: the stored profile is fresh, so nothing was fetched and nothing will be written.",
  no_ats_evidence: "Skipped: no enabled ATS board, so nothing was fetched and nothing will be written.",
  robots_disallowed: "Stopped: robots.txt disallows the homepage. Only robots.txt was fetched; nothing will be written.",
  off_domain_redirect: "Stopped: the homepage redirected to a different site, which is not treated as this company's official source. Nothing extracted or written.",
  not_ats_linked: "Stopped: the homepage does not link to the company's enabled ATS board, so identity is unproven. Nothing extracted or written.",
  not_verified: "Stopped: no first-party Organization data matching this company. Nothing extracted or written.",
  fetch_failed: "Stopped: a source fetch failed (see error). Stored values are kept; nothing will be written.",
  verified: "Verified first-party source. Proposed rows below.",
};
const EMPTY_SECTION = {
  facts: "No first-party Organization facts on the fetched pages.",
  leadership: "No affiliated schema.org Person with an executive job title on a fetched about/leadership/team page.",
  news: "No dated first-party NewsArticle/Article on a fetched news/press/blog page.",
};

function companySection(plan: CanaryPlan, company: CanaryCompanyPlan): string[] {
  const sources = plan.sources.filter((s) => s.company_id === company.company_id);
  const actions = plan.actions.filter((a) => a.company_id === company.company_id);
  const count = (table: CanaryTable, op: "insert" | "update") => actions.filter((a) => a.table === table && a.op === op).length;
  const empty = (section: keyof typeof EMPTY_SECTION) => (company.outcome === "verified" ? EMPTY_SECTION[section] : "Not extracted (see outcome).");
  const facts = company.proposed.facts;
  const leaders = company.proposed.leadership;
  const news = company.proposed.news;
  const row = (r: CanaryRow, keys: string[]) => `| ${keys.map((k) => cell(r[k])).join(" | ")} |`;
  return [
    `## ${cell(company.name)}`,
    "",
    `- Company UUID: \`${company.company_id}\``,
    `- Canonical domain: ${cell(company.canonical_domain)}`,
    `- Enabled ATS boards: ${company.ats_boards.length ? company.ats_boards.map((b) => `${cell(b.ats_type)}:${cell(b.slug)} (\`${b.id}\`)`).join(", ") : "none"}`,
    `- Freshness before: ${company.freshness.status}${company.freshness.should_refresh ? " (refresh due)" : ""}`,
    `- Outcome: **${company.outcome}**. ${OUTCOME[company.outcome]}${company.error ? ` Error (redacted): \`${cell(company.error)}\`` : ""}`,
    ...(company.wikidata ? [`- Wikidata: **${company.wikidata.outcome}**${company.wikidata.entity_id ? ` (https://www.wikidata.org/wiki/${company.wikidata.entity_id}; identity = official website P856 equals the stored domain; fills only keys no official source covers)` : company.wikidata.outcome === "ambiguous" ? " (more than one entity claims this domain; nothing used)" : company.wikidata.outcome === "no_match" ? " (no entity whose official website is this domain; nothing used)" : ""}${company.wikidata.error ? ` Error (redacted): \`${cell(company.wikidata.error)}\`` : ""}`] : []),
    `- Current rows: ${company.current.company_profile_facts.length} facts, ${company.current.company_profile_leadership.length} leaders, ${company.current.company_profile_news.length} news, ${company.current.company_profile_refresh_state.length} refresh state`,
    "",
    `### Sources fetched (${sources.length})`,
    "",
    ...(sources.length ? ["| Kind | Requested | Final URL | Status | Fetched at | Bytes | sha256 |", "|---|---|---|---|---|---|---|", ...sources.map((s) => `| ${s.kind} | ${cell(s.requested_url)} | ${cell(s.final_url)} | ${s.status} | ${s.fetched_at} | ${s.bytes} | \`${s.sha256}\` |`)] : ["None."]),
    "",
    `### Facts after the canary (${facts.length})`,
    "",
    ...(facts.length ? ["| Fact | Value | Source | Retrieved | Observed | Status | Conflicting report |", "|---|---|---|---|---|---|---|", ...facts.map((f) => `${row(f, ["fact_key", "fact_value", "source_url", "retrieved_at", "observed_at", "fact_status"]).slice(0, -2)} | ${f.conflict_value ? cell(`${f.conflict_value} (${f.conflict_source_url})`) : "—"} |`)] : [empty("facts")]),
    "",
    `### Leadership after the canary (${leaders.length})`,
    "",
    ...(leaders.length ? ["| Name | Role | Role as of | Source | Retrieved |", "|---|---|---|---|---|", ...leaders.map((l) => `| ${cell(l.name)} | ${cell(l.role)} | ${l.role_as_of ?? "undated (shown without a date, never as current)"} | ${cell(l.source_url)} | ${l.retrieved_at} |`)] : [empty("leadership")]),
    "",
    `### News after the canary (${news.length})`,
    "",
    ...(news.length ? ["| Headline | Published (from the page) | Source | Retrieved |", "|---|---|---|---|", ...news.map((n) => row(n, ["headline", "published_at", "source_url", "retrieved_at"]))] : [empty("news")]),
    "",
    `### Database actions for this company (${actions.length})`,
    "",
    ...(actions.length ? ["| Table | Inserts | Updates |", "|---|---|---|", ...(Object.keys(plan.summary.by_table) as CanaryTable[]).map((t) => `| ${t} | ${count(t, "insert")} | ${count(t, "update")} |`)] : ["None."]),
    "",
  ];
}

export function renderCanaryPlanSummary(plan: CanaryPlan): string {
  return [
    "# Company-profile canary plan: review summary",
    "",
    "Read this alongside the JSON plan; the JSON and its digest are what the write checks. **A digest proves which plan this is, not that the owner approved it.**",
    "",
    `- Plan digest: \`${plan.plan_digest}\``,
    `- Target project: \`${plan.target_project}\` · schema \`${plan.schema_version}\` · reviewed code SHA \`${plan.code_sha}\``,
    `- Created ${plan.created_at} · expires ${plan.expires_at} (after that, generate and review a new plan)`,
    `- Companies (${plan.company_ids.length} of max ${plan.max_companies}): ${plan.company_ids.map((id) => `\`${id}\``).join(", ")}`,
    `- Actions: ${plan.actions.length} (${plan.summary.inserts} inserts, ${plan.summary.updates} updates) across ${plan.summary.planned_companies} companies. By table: ${Object.entries(plan.summary.by_table).map(([t, n]) => `${t} ${n}`).join(", ")}`,
    "- **Not atomic.** Each action is one compare-and-set statement, journaled before it runs. A stopped write leaves earlier steps applied; use `--resume` or `--rollback` with the same plan, digest and journal.",
    "- Rollback restores or removes only rows that still hold the canary's values. Rows someone else changed since are left alone and reported as `skipped_drifted`.",
    "- The write fails closed on a changed plan, expiry, another target, code SHA or schema, changed current rows, or any changed source (final URL, status or sha256).",
    "",
    ...plan.companies.flatMap((company) => companySection(plan, company)),
  ].join("\n");
}
