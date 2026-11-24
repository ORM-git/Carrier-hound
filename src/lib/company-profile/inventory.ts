/**
 * Read-only company inventory and candidate planner for the Company-tab enrichment canary.
 * It reads companies, ATS boards, active-job counts and existing profile rows, and suggests candidates.
 * It never fetches a company page (no fetcher is accepted) and its store has no write methods.
 * Suggestions are not permission: the owner chooses at most 3 UUIDs and passes them to the canary by hand.
 */
import type { CanaryRow, CanaryTable } from "./canary";
import { CANARY_TABLES, MAX_OFFICIAL_SUBPAGES, canonicalTimestamp, normalizeCanaryRow, redactCanaryText } from "./canary";
import { evaluateCompanyProfileFreshness } from "./enrichment";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;
export const INVENTORY_MAX_LIMIT = 1000;
export const INVENTORY_MAX_SHORTLIST = 25;
const PROFILE_TABLES = Object.keys(CANARY_TABLES) as CanaryTable[];

export interface InventoryCompany { id: string; name: string; canonical_domain: string | null }
export interface InventoryBoard { id: string; company_id: string; enabled: boolean; ats_type: string | null; slug: string | null; careers_url: string | null }
/**
 * Reads only. Each method is called once per page of companies and must return COMPLETE results or throw;
 * a store may need several requests to do that (the Supabase adapter pages every read; see inventoryStore.ts).
 */
export interface InventoryStore {
  /** Companies with id > afterId (all companies when null), ordered by id ascending: exactly min(limit, remaining). */
  companiesAfter(afterId: string | null, limit: number): Promise<InventoryCompany[]>;
  /**
   * Every company, anywhere in the table, whose stored canonical_domain contains one of these identities
   * case-insensitively (a superset is fine). The planner normalizes each value with domainIdentity() and counts exact matches.
   */
  domainCandidates(identities: string[]): Promise<Array<{ id: string; canonical_domain: string | null }>>;
  /** Every ATS board, enabled or not, for these companies. */
  boards(companyIds: string[]): Promise<InventoryBoard[]>;
  /** Active jobs (status 'active' and is_active) per company id. */
  activeJobCounts(companyIds: string[]): Promise<Record<string, number>>;
  /** Raw rows of a profile table for these companies; normalized per company so one bad row is one company error. */
  rows(table: CanaryTable, companyIds: string[]): Promise<Record<string, unknown>[]>;
}

export type InventoryCategory =
  | "missing_domain" | "ambiguous_identity" | "no_enabled_ats" | "fresh_cache_hit" | "refresh_not_due"
  | "stale" | "conflict" | "never_enriched" | "missing_facts" | "missing_leadership" | "missing_news" | "error";
/** Categories that hold a company back from the shortlist. The rest only describe it. */
const HOLD_CATEGORIES: InventoryCategory[] = ["missing_domain", "ambiguous_identity", "no_enabled_ats", "fresh_cache_hit", "refresh_not_due", "error"];

export const INVENTORY_DEFINITIONS: Record<InventoryCategory | "scanned" | "eligible", string> = {
  scanned: "Companies read in this window (cursor order by UUID).",
  eligible: "Scanned companies with none of the hold categories: a usable, unique domain, at least one enabled ATS board, and a refresh that is due.",
  missing_domain: "No canonical domain, or one that is not a plain hostname. Review queue: never inferred from the company name.",
  ambiguous_identity: "Another company row holds the same canonical domain (www. ignored). Review queue.",
  no_enabled_ats: "No enabled ATS board. The crawl requires ATS evidence, so it would stop with no_ats_evidence. Disabled boards are counted separately.",
  fresh_cache_hit: "Profile is fresh and its refresh is not due: the canary would skip it (cache_hit).",
  refresh_not_due: "Stale or conflicted, but a recent failed attempt is still cooling down (next_refresh_at in the future).",
  stale: "Freshness evaluates to stale, including never enriched. Overlaps with the missing_* categories.",
  conflict: "At least one fact or the refresh state is in conflict.",
  never_enriched: "No refresh-state row and no profile rows at all.",
  missing_facts: "Zero fact rows. An empty section is coverage, not a failure.",
  missing_leadership: "Zero leadership rows. An empty section is coverage, not a failure.",
  missing_news: "Zero news rows. An empty section is coverage, not a failure.",
  error: "This company's stored rows could not be read or validated. Not a crawl failure: inventory never crawls.",
};

export const INVENTORY_SCOPE = "Counts, holds and the shortlist cover only the companies scanned in this window. Domain ownership is checked against every company in the table; ATS boards, active jobs and profile rows are read in full for the scanned companies. Separate windows are not merged into one ranking.";

export const INVENTORY_RANKING = [
  "1. More active jobs first: those are the job pages Pro users open.",
  "2. More missing sections first (facts, leadership and news each count as one).",
  "3. Never enriched first, then oldest last successful refresh.",
  "4. Company UUID ascending, as a stable tie-break.",
];

export interface InventoryRecord {
  company_id: string; name: string; canonical_domain: string | null;
  active_jobs: number;
  ats: { enabled: number; disabled: number; boards: Array<{ id: string; ats_type: string | null; slug: string | null; careers_url: string | null }> };
  coverage: { facts: number; fact_keys: string[]; leadership: number; news: number; refresh_status: string | null; last_succeeded_at: string | null; next_refresh_at: string | null; last_error: string | null };
  freshness: "fresh" | "stale" | "conflict" | null;
  categories: InventoryCategory[];
  eligible: boolean;
  error: string | null;
}
export interface ShortlistEntry {
  rank: number; company_id: string; name: string; canonical_domain: string;
  active_jobs: number; ats_evidence: InventoryRecord["ats"]["boards"]; coverage: InventoryRecord["coverage"]; freshness: InventoryRecord["freshness"];
  reasons: string[];
  proposed_source_urls: string[];
  estimated_requests: { minimum: number; maximum: number; maximum_with_retries: number };
}
export interface CompanyInventoryReport {
  kind: "company-profile-candidate-inventory"; format: 1;
  read_only: true; writes: 0; crawled: false; authorizes_canary: false;
  generated_at: string; code_sha: string | null; target: string;
  window: { after_id: string | null; limit: number; scanned: number; next_cursor: string | null; scope: string };
  definitions: typeof INVENTORY_DEFINITIONS; ranking: string[];
  counts: { companies: Record<InventoryCategory | "scanned" | "eligible", number>; rows: Record<CanaryTable, number> };
  shortlist: ShortlistEntry[];
  review_queue: Array<{ company_id: string; name: string; canonical_domain: string | null; active_jobs: number; reasons: InventoryCategory[] }>;
  holds: Array<{ company_id: string; name: string; reasons: InventoryCategory[] }>;
  companies: InventoryRecord[];
}

export interface InventoryOptions { limit: number; afterId: string | null; shortlist: number; out: string }

/** Owner-run CLI flags. Any write, production-canary or company-selection flag is refused. */
export function parseInventoryOptions(argv: string[]): InventoryOptions {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!["--limit", "--after-id", "--shortlist", "--out"].includes(arg)) throw new Error(`Inventory is read-only and does not accept ${arg.startsWith("--") ? arg : "positional arguments"}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    if (values.has(arg)) throw new Error(`${arg} given twice`);
    values.set(arg, value);
    i++;
  }
  const limit = Number(values.get("--limit"));
  if (!Number.isInteger(limit) || limit < 1 || limit > INVENTORY_MAX_LIMIT) throw new Error(`--limit must be an integer from 1 to ${INVENTORY_MAX_LIMIT}`);
  const afterId = values.get("--after-id")?.toLowerCase() ?? null;
  if (afterId !== null && !UUID.test(afterId)) throw new Error("--after-id must be a company UUID (the previous run's next_cursor)");
  const shortlist = values.has("--shortlist") ? Number(values.get("--shortlist")) : 10;
  if (!Number.isInteger(shortlist) || shortlist < 1 || shortlist > INVENTORY_MAX_SHORTLIST) throw new Error(`--shortlist must be an integer from 1 to ${INVENTORY_MAX_SHORTLIST}`);
  const out = values.get("--out");
  if (!out) throw new Error("--out <file outside the repository> is required");
  return { limit, afterId, shortlist, out };
}

/** The hostname the crawl would fetch, or null when it is missing or not a plain hostname. */
export function inventoryDomain(raw: string | null): string | null {
  const domain = String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain) ? domain : null;
}
/** The one identity rule for classification and ownership: inventoryDomain() (case, scheme, path) without a leading www. */
export function domainIdentity(raw: string | null): string | null {
  return inventoryDomain(raw)?.replace(/^www\./, "") ?? null;
}
// Postgres orders uuid bytewise, which equals plain string order for lower-case hex; localeCompare may not.
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function classify(input: {
  company: InventoryCompany; now: string; domainOwners: Map<string, Set<string>>; boards: InventoryBoard[]; activeJobs: number; rawRows: Record<CanaryTable, Record<string, unknown>[]>; secrets: string[];
}): InventoryRecord {
  const { company, boards } = input;
  const enabled = boards.filter((b) => b.enabled);
  const record: InventoryRecord = {
    company_id: company.id, name: company.name, canonical_domain: company.canonical_domain, active_jobs: input.activeJobs,
    ats: { enabled: enabled.length, disabled: boards.length - enabled.length, boards: enabled.slice(0, 10).map((b) => ({ id: b.id, ats_type: b.ats_type, slug: b.slug, careers_url: b.careers_url })) },
    coverage: { facts: 0, fact_keys: [], leadership: 0, news: 0, refresh_status: null, last_succeeded_at: null, next_refresh_at: null, last_error: null },
    freshness: null, categories: [], eligible: false, error: null,
  };
  const categories = new Set<InventoryCategory>();
  const domain = inventoryDomain(company.canonical_domain);
  if (!domain) categories.add("missing_domain");
  else if ((input.domainOwners.get(domainIdentity(domain)!)?.size || 0) > 1) categories.add("ambiguous_identity");
  if (!enabled.length) categories.add("no_enabled_ats");
  try {
    const rows = Object.fromEntries(PROFILE_TABLES.map((t) => [t, input.rawRows[t].map((r) => normalizeCanaryRow(t, r))])) as Record<CanaryTable, CanaryRow[]>;
    const state = rows.company_profile_refresh_state[0] || null;
    record.coverage = {
      facts: rows.company_profile_facts.length, fact_keys: rows.company_profile_facts.map((r) => String(r.fact_key)).sort(),
      leadership: rows.company_profile_leadership.length, news: rows.company_profile_news.length,
      refresh_status: state?.status ?? null, last_succeeded_at: state?.last_succeeded_at ?? null, next_refresh_at: state?.next_refresh_at ?? null,
      last_error: state?.last_error ? redactCanaryText(state.last_error, input.secrets) : null,
    };
    const freshness = evaluateCompanyProfileFreshness({
      now: input.now, state,
      facts: Object.fromEntries(rows.company_profile_facts.map((r) => [r.fact_key, { retrievedAt: r.retrieved_at!, status: r.fact_status as "fresh" | "stale" | "conflict" }])),
      leadership: rows.company_profile_leadership.map((r) => ({ retrievedAt: r.retrieved_at! })),
      news: rows.company_profile_news.map((r) => ({ publishedAt: r.published_at!, retrievedAt: r.retrieved_at! })),
    });
    record.freshness = freshness.status;
    categories.add(freshness.status === "fresh" ? "fresh_cache_hit" : freshness.status);
    if (freshness.status !== "fresh" && !freshness.shouldRefresh) categories.add("refresh_not_due");
    if (!state && !record.coverage.facts && !record.coverage.leadership && !record.coverage.news) categories.add("never_enriched");
    if (!record.coverage.facts) categories.add("missing_facts");
    if (!record.coverage.leadership) categories.add("missing_leadership");
    if (!record.coverage.news) categories.add("missing_news");
  } catch (error) {
    categories.add("error");
    record.error = redactCanaryText(error instanceof Error ? error.message : String(error), input.secrets);
  }
  record.categories = Array.from(categories).sort();
  record.eligible = !HOLD_CATEGORIES.some((c) => categories.has(c));
  return record;
}

const missingSections = (r: InventoryRecord) => [r.coverage.facts, r.coverage.leadership, r.coverage.news].filter((n) => n === 0).length;
/** Ranking comparator; see INVENTORY_RANKING. */
export function compareCandidates(a: InventoryRecord, b: InventoryRecord): number {
  const lastOk = (r: InventoryRecord) => (r.coverage.last_succeeded_at ? Date.parse(r.coverage.last_succeeded_at) : -Infinity);
  return b.active_jobs - a.active_jobs || missingSections(b) - missingSections(a) || lastOk(a) - lastOk(b) || byId(a.company_id, b.company_id);
}

function shortlistEntry(record: InventoryRecord, rank: number): ShortlistEntry {
  const domain = inventoryDomain(record.canonical_domain)!;
  const missing = (["facts", "leadership", "news"] as const).filter((k) => record.coverage[k] === 0);
  const boards = record.ats.boards.map((b) => [b.ats_type, b.slug].filter(Boolean).join(":") || b.id);
  const reasons = [
    `${record.active_jobs} active job${record.active_jobs === 1 ? "" : "s"}`,
    missing.length ? `missing ${missing.join(", ")}` : "all three sections have rows",
    record.categories.includes("never_enriched") ? "never enriched" : record.coverage.last_succeeded_at ? `last successful refresh ${record.coverage.last_succeeded_at.slice(0, 10)}` : "no successful refresh recorded",
    ...(record.freshness === "conflict" ? ["has a conflict to re-check"] : []),
    `enabled ATS evidence: ${boards.join(", ")}`,
  ];
  // robots.txt + homepage always; up to MAX_OFFICIAL_SUBPAGES same-host links, and each fetch retries at most twice on 5xx/timeout.
  const maximum = 2 + MAX_OFFICIAL_SUBPAGES;
  return {
    rank, company_id: record.company_id, name: record.name, canonical_domain: domain, active_jobs: record.active_jobs,
    ats_evidence: record.ats.boards, coverage: record.coverage, freshness: record.freshness, reasons,
    proposed_source_urls: [`https://${domain}/robots.txt`, `https://${domain}/`, `up to ${MAX_OFFICIAL_SUBPAGES} same-host about/leadership/team/news/press links found on that homepage and allowed by robots.txt (known only after the read-only plan)`],
    estimated_requests: { minimum: 2, maximum, maximum_with_retries: maximum * 3 },
  };
}

export async function buildCompanyInventory(input: {
  store: InventoryStore; afterId: string | null; limit: number; shortlist: number; now: () => Date; codeSha: string | null; target: string; secrets?: string[];
}): Promise<CompanyInventoryReport> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > INVENTORY_MAX_LIMIT) throw new Error("Inventory limit out of range");
  const now = canonicalTimestamp(input.now())!;
  const secrets = input.secrets || [];
  const records: InventoryRecord[] = [];
  let cursor = input.afterId;
  let exhausted = false;
  while (records.length < input.limit) {
    const want = Math.min(PAGE_SIZE, input.limit - records.length);
    const page = await input.store.companiesAfter(cursor, want);
    for (let i = 1; i < page.length; i++) if (byId(page[i - 1].id, page[i].id) >= 0) throw new Error("Store returned companies out of UUID order; refusing to build a cursor");
    if (page.length && cursor && byId(page[0].id, cursor) <= 0) throw new Error("Store returned a company at or before the cursor");
    if (!page.length) { exhausted = true; break; }
    const ids = page.map((c) => c.id);
    const identities = Array.from(new Set(page.map((c) => domainIdentity(c.canonical_domain)).filter((d): d is string => Boolean(d))));
    const [candidates, boards, jobs, ...tableRows] = await Promise.all([
      input.store.domainCandidates(identities), input.store.boards(ids), input.store.activeJobCounts(ids), ...PROFILE_TABLES.map((t) => input.store.rows(t, ids)),
    ]);
    // Ownership counts distinct companies, across the whole table, whose stored value normalizes to the same identity.
    const domainOwners = new Map(identities.map((d) => [d, new Set<string>()]));
    for (const row of candidates) domainOwners.get(domainIdentity(row.canonical_domain) ?? "")?.add(row.id);
    for (const company of page) {
      const rawRows = Object.fromEntries(PROFILE_TABLES.map((t, i) => [t, tableRows[i].filter((r) => String(r.company_id) === company.id)])) as Record<CanaryTable, Record<string, unknown>[]>;
      records.push(classify({ company, now, domainOwners, boards: boards.filter((b) => b.company_id === company.id), activeJobs: jobs[company.id] || 0, rawRows, secrets }));
    }
    cursor = page[page.length - 1].id;
    if (page.length < want) { exhausted = true; break; }
  }
  const categoryNames = Object.keys(INVENTORY_DEFINITIONS).filter((k) => k !== "scanned" && k !== "eligible") as InventoryCategory[];
  const companyCounts = Object.fromEntries(categoryNames.map((c) => [c, records.filter((r) => r.categories.includes(c)).length])) as CompanyInventoryReport["counts"]["companies"];
  companyCounts.scanned = records.length;
  companyCounts.eligible = records.filter((r) => r.eligible).length;
  const rowCounts = {
    company_profile_facts: records.reduce((n, r) => n + r.coverage.facts, 0),
    company_profile_leadership: records.reduce((n, r) => n + r.coverage.leadership, 0),
    company_profile_news: records.reduce((n, r) => n + r.coverage.news, 0),
    company_profile_refresh_state: records.filter((r) => r.coverage.refresh_status !== null).length,
  };
  const review = records.filter((r) => r.categories.includes("missing_domain") || r.categories.includes("ambiguous_identity"));
  const reviewIds = new Set(review.map((r) => r.company_id));
  return {
    kind: "company-profile-candidate-inventory", format: 1, read_only: true, writes: 0, crawled: false, authorizes_canary: false,
    generated_at: now, code_sha: input.codeSha, target: input.target,
    window: { after_id: input.afterId, limit: input.limit, scanned: records.length, next_cursor: exhausted ? null : cursor, scope: INVENTORY_SCOPE },
    definitions: INVENTORY_DEFINITIONS, ranking: INVENTORY_RANKING,
    counts: { companies: companyCounts, rows: rowCounts },
    shortlist: records.filter((r) => r.eligible).sort(compareCandidates).slice(0, input.shortlist).map((r, i) => shortlistEntry(r, i + 1)),
    review_queue: review.map((r) => ({ company_id: r.company_id, name: r.name, canonical_domain: r.canonical_domain, active_jobs: r.active_jobs, reasons: r.categories.filter((c) => c === "missing_domain" || c === "ambiguous_identity") })),
    holds: records.filter((r) => !r.eligible && !reviewIds.has(r.company_id)).map((r) => ({ company_id: r.company_id, name: r.name, reasons: r.categories.filter((c) => HOLD_CATEGORIES.includes(c)) })),
    companies: records,
  };
}

const cell = (v: unknown) => String(v ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Short human-readable companion to the JSON report. */
export function renderInventorySummary(report: CompanyInventoryReport): string {
  const c = report.counts.companies;
  const lines = [
    "# Company-profile candidate inventory (read-only)",
    "",
    `Generated ${report.generated_at} · target \`${report.target}\` · code \`${report.code_sha ?? "unknown"}\``,
    `Window: after \`${report.window.after_id ?? "start"}\`, ${report.window.scanned} of limit ${report.window.limit} scanned · next cursor \`${report.window.next_cursor ?? "none (end of table)"}\``,
    "",
    `Scope: ${report.window.scope}`,
    "",
    "**No writes, no crawl. Suggestions are not permission:** the owner picks at most 3 UUIDs for the read-only canary plan.",
    "",
    "## Company counts (categories overlap; see the JSON `definitions`)",
    "",
    "| scanned | eligible | missing domain | ambiguous | no enabled ATS | fresh (cache hit) | refresh not due | stale | conflict | never enriched | missing facts | missing leadership | missing news | errors |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    `| ${c.scanned} | ${c.eligible} | ${c.missing_domain} | ${c.ambiguous_identity} | ${c.no_enabled_ats} | ${c.fresh_cache_hit} | ${c.refresh_not_due} | ${c.stale} | ${c.conflict} | ${c.never_enriched} | ${c.missing_facts} | ${c.missing_leadership} | ${c.missing_news} | ${c.error} |`,
    "",
    `Existing rows for these companies: ${report.counts.rows.company_profile_facts} facts, ${report.counts.rows.company_profile_leadership} leaders, ${report.counts.rows.company_profile_news} news items, ${report.counts.rows.company_profile_refresh_state} refresh states.`,
    "",
    "## Shortlist",
    "",
    ...report.ranking.map((r) => `- ${r}`),
    "",
    "| # | Company UUID | Name | Domain | Active jobs | Coverage (facts / leaders / news) | Why | Max requests |",
    "|---|---|---|---|---|---|---|---|",
    ...report.shortlist.map((s) => `| ${s.rank} | \`${s.company_id}\` | ${cell(s.name)} | ${cell(s.canonical_domain)} | ${s.active_jobs} | ${s.coverage.facts} / ${s.coverage.leadership} / ${s.coverage.news} | ${cell(s.reasons.join("; "))} | ${s.estimated_requests.maximum} (${s.estimated_requests.maximum_with_retries} with retries) |`),
    ...(report.shortlist.length ? [] : ["| — | none eligible in this window | | | | | | |"]),
    "",
    `## Review queue (${report.review_queue.length}): fix or confirm the domain by hand; never guessed`,
    "",
    ...report.review_queue.map((r) => `- \`${r.company_id}\` ${cell(r.name)} (${cell(r.canonical_domain)}): ${r.reasons.join(", ")}`),
    "",
    `## Holds (${report.holds.length})`,
    "",
    ...report.holds.map((h) => `- \`${h.company_id}\` ${cell(h.name)}: ${h.reasons.join(", ")}`),
    "",
  ];
  return lines.join("\n");
}
