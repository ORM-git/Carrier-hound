/**
 * Production canary for company-profile enrichment: an explicit allowlist of at most 3 companies,
 * a reviewed dry-run plan bound to target/IDs/code/schema/expiry, a digest-confirmed write that
 * revalidates everything first, and a write-ahead journal that supports resume and conditional rollback.
 * NOT atomic: every row change is one compare-and-set statement; see docs/company-profile-canary.md.
 */
import { createHash } from "node:crypto";
import type { CompanyFact, CompanyFactKey } from "./types";
import {
  dedupeCompanyNewsObservations, dedupeLeadershipObservations, evaluateCompanyProfileFreshness, extractOfficialCompanyPage,
  extractOfficialCompanySubpage, isAtsEvidenceLinked, reconcileCompanyFacts, robotsAllows,
  type CompanyAtsEvidence, type OfficialPageExtraction,
} from "./enrichment";
import { fetchWikidataProfile, WIKIDATA_HOST, wikidataClient, type WikidataFetcher, type WikidataProfile } from "./wikidata";

export const COMPANY_PROFILE_PRODUCTION_PROJECT_REF = "szakevhxhwpeskidvtfs";
export const COMPANY_PROFILE_SCHEMA_VERSION = "20261124a_company_profile_wikidata";
/** Values 20261124a adds to company_profile_facts' CHECK allowlists; every CHECK on the column must allow them. */
export const REQUIRED_FACT_ALLOWLISTS = { fact_key: ["funding_stage"], source_kind: ["wikidata"], conflict_source_kind: ["wikidata"] } as const;
export const CANARY_MAX_COMPANIES = 3;
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 72;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const CANARY_TABLES = {
  company_profile_facts: {
    key: ["company_id", "fact_key"],
    columns: ["company_id", "fact_key", "fact_value", "source_url", "source_kind", "observed_at", "fact_status", "conflict_value", "conflict_source_url", "conflict_source_kind", "conflict_retrieved_at", "conflict_observed_at", "retrieved_at"],
    timestamps: ["observed_at", "conflict_retrieved_at", "conflict_observed_at", "retrieved_at"],
    dates: [],
  },
  company_profile_leadership: {
    key: ["id"],
    columns: ["id", "company_id", "name", "role", "role_as_of", "source_url", "retrieved_at"],
    timestamps: ["retrieved_at"],
    dates: ["role_as_of"],
  },
  company_profile_news: {
    key: ["id"],
    columns: ["id", "company_id", "headline", "published_at", "source_url", "excerpt", "retrieved_at"],
    timestamps: ["published_at", "retrieved_at"],
    dates: [],
  },
  company_profile_refresh_state: {
    key: ["company_id"],
    columns: ["company_id", "status", "last_attempted_at", "last_succeeded_at", "next_refresh_at", "last_error"],
    timestamps: ["last_attempted_at", "last_succeeded_at", "next_refresh_at"],
    dates: [],
  },
} as const satisfies Record<string, { key: readonly string[]; columns: readonly string[]; timestamps: readonly string[]; dates: readonly string[] }>;
export type CanaryTable = keyof typeof CANARY_TABLES;
export type CanaryRow = Record<string, string | null>;
const TABLE_NAMES = Object.keys(CANARY_TABLES) as CanaryTable[];

// ---------------------------------------------------------------------------------------------
// Target identity, options, code SHA
// ---------------------------------------------------------------------------------------------

/** Separate from the local/staging guard: only the exact production identity, never inferred from credentials. */
export function isAllowedCompanyProfileProductionTarget(supabaseUrl: string, environment: string, targetProject: string | undefined, productionFlag: boolean): boolean {
  if (productionFlag !== true || environment !== "production" || targetProject !== COMPANY_PROFILE_PRODUCTION_PROJECT_REF) return false;
  try {
    const url = new URL(supabaseUrl);
    return url.protocol === "https:" && !url.username && !url.password && !url.port && (url.pathname === "/" || url.pathname === "")
      && !url.search && url.hostname === `${COMPANY_PROFILE_PRODUCTION_PROJECT_REF}.supabase.co`;
  } catch { return false; }
}

export type CanaryMode = "plan" | "write" | "resume" | "rollback";
export interface CanaryOptions {
  mode: CanaryMode;
  targetProject: string;
  companyIds: string[];
  maxCompanies: number;
  planPath: string;
  journalPath?: string;
  confirmDigest?: string;
  codeSha?: string;
  ttlHours: number;
}

const VALUE_FLAGS = new Set(["--target-project", "--company-ids", "--max-companies", "--plan-out", "--plan", "--journal", "--confirm-digest", "--code-sha", "--ttl-hours"]);
const SWITCH_FLAGS = new Set(["--production", "--write", "--resume", "--rollback"]);
/** Any of these routes the CLI to the canary parser, which then demands --production (--write alone stays the batch path). */
export const CANARY_ROUTING_FLAGS = new Set(Array.from(VALUE_FLAGS).concat(Array.from(SWITCH_FLAGS)).filter((flag) => flag !== "--write"));

export function parseCanaryOptions(argv: string[]): CanaryOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (SWITCH_FLAGS.has(arg)) { switches.add(arg); continue; }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} needs a value`);
      if (values.has(arg)) throw new Error(`${arg} given twice`);
      values.set(arg, value);
      i++;
      continue;
    }
    // Cursor / all-company selection and every unknown flag are refused outright.
    throw new Error(`Production canary does not accept ${arg.startsWith("--") ? arg : "positional arguments"}; select companies only with --company-ids`);
  }
  if (!switches.has("--production")) throw new Error("--production is required for the production canary");
  const targetProject = values.get("--target-project") || "";
  if (targetProject !== COMPANY_PROFILE_PRODUCTION_PROJECT_REF) throw new Error("--target-project must be the exact production project ref");
  const maxCompanies = Number(values.get("--max-companies"));
  if (!Number.isInteger(maxCompanies) || maxCompanies < 1 || maxCompanies > CANARY_MAX_COMPANIES) throw new Error(`--max-companies must be an integer from 1 to ${CANARY_MAX_COMPANIES}`);
  const rawIds = values.get("--company-ids");
  if (!rawIds) throw new Error("--company-ids is required (comma-separated company UUIDs)");
  const companyIds = rawIds.split(",").map((id) => id.trim().toLowerCase());
  if (companyIds.some((id) => !UUID.test(id))) throw new Error("--company-ids must contain only company UUIDs");
  if (new Set(companyIds).size !== companyIds.length) throw new Error("--company-ids contains a duplicate ID");
  if (companyIds.length > maxCompanies) throw new Error(`--company-ids lists ${companyIds.length} companies, over --max-companies ${maxCompanies}`);
  const modes = ["--write", "--resume", "--rollback"].filter((flag) => switches.has(flag));
  if (modes.length > 1) throw new Error("Use only one of --write, --resume, --rollback");
  const mode: CanaryMode = modes.length ? (modes[0].slice(2) as CanaryMode) : "plan";
  const codeSha = values.get("--code-sha")?.toLowerCase();
  if (codeSha !== undefined && !/^[0-9a-f]{40}$/.test(codeSha)) throw new Error("--code-sha must be a full 40-character commit SHA");
  const ttlRaw = values.get("--ttl-hours");
  const ttlHours = ttlRaw === undefined ? DEFAULT_TTL_HOURS : Number(ttlRaw);
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) throw new Error(`--ttl-hours must be an integer from 1 to ${MAX_TTL_HOURS}`);
  if (mode === "plan") {
    const planPath = values.get("--plan-out");
    if (!planPath) throw new Error("Dry-run needs --plan-out <file>");
    for (const flag of ["--plan", "--journal", "--confirm-digest"]) if (values.has(flag)) throw new Error(`${flag} is only for --write, --resume or --rollback`);
    return { mode, targetProject, companyIds, maxCompanies, planPath, codeSha, ttlHours };
  }
  if (values.has("--plan-out") || values.has("--ttl-hours")) throw new Error("--plan-out and --ttl-hours are only for the dry-run");
  const planPath = values.get("--plan");
  const journalPath = values.get("--journal");
  const confirmDigest = values.get("--confirm-digest")?.toLowerCase();
  if (!planPath) throw new Error(`--${mode} needs --plan <reviewed plan file>`);
  if (!journalPath) throw new Error(`--${mode} needs --journal <rollback manifest file>`);
  if (!confirmDigest || !/^[0-9a-f]{64}$/.test(confirmDigest)) throw new Error(`--${mode} needs --confirm-digest <64-hex plan digest>`);
  return { mode, targetProject, companyIds, maxCompanies, planPath, journalPath, confirmDigest, codeSha, ttlHours };
}

/** In a git checkout the SHA comes from a clean HEAD; outside one it must be given with --code-sha. */
export function resolveCodeSha(git: { head: string | null; dirty: boolean }, flag?: string): string {
  if (git.head) {
    const head = git.head.trim().toLowerCase();
    if (git.dirty) throw new Error("Refusing to run from a checkout with uncommitted tracked changes");
    if (flag && flag !== head) throw new Error("--code-sha does not match the checked-out commit");
    return head;
  }
  if (!flag) throw new Error("Not a git checkout: pass --code-sha <full commit SHA of this code>");
  return flag;
}

// ---------------------------------------------------------------------------------------------
// Canonical rows, digests, redaction
// ---------------------------------------------------------------------------------------------

/** One canonical UTC form for PostgREST ("…+00:00", microseconds), Postgres text ("… +00") and JS ISO strings. */
export function canonicalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return canonicalTimestamp(value.toISOString());
  const text = String(value);
  const match = text.match(/^(\d{4}-\d\d-\d\d)[T ](\d\d:\d\d:\d\d)(?:\.(\d{1,6}))?(Z|[+-]00(?::?00)?)$/i);
  if (match) {
    const fraction = (match[3] || "").replace(/0+$/, "");
    return `${match[1]}T${match[2]}${fraction ? `.${fraction}` : ""}Z`;
  }
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) throw new Error("Unparseable timestamp in profile row");
  return canonicalTimestamp(new Date(parsed).toISOString());
}

export function normalizeCanaryRow(table: CanaryTable, raw: Record<string, unknown>): CanaryRow {
  const spec = CANARY_TABLES[table];
  const row: CanaryRow = {};
  for (const column of spec.columns) {
    if (!(column in raw)) throw new Error(`Schema mismatch: ${table}.${column} missing from row`);
    const value = raw[column];
    if (value === null || value === undefined) row[column] = null;
    else if ((spec.timestamps as readonly string[]).includes(column)) row[column] = canonicalTimestamp(value);
    else if ((spec.dates as readonly string[]).includes(column)) row[column] = (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
    else row[column] = String(value);
  }
  return row;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object).sort().filter((key) => (value as any)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson((value as any)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const sameRow = (a: CanaryRow | null | undefined, b: CanaryRow | null | undefined) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const keyOf = (table: CanaryTable, row: CanaryRow): CanaryRow => Object.fromEntries(CANARY_TABLES[table].key.map((column) => [column, row[column]]));

export function computePlanDigest(plan: Omit<CanaryPlan, "plan_digest"> & { plan_digest?: string }): string {
  const { plan_digest: _ignored, ...body } = plan;
  return sha256(canonicalJson(body));
}

/** Strips secrets, tokens, connection strings and external URLs from anything printed or journaled. */
export function redactCanaryText(text: string, secrets: Array<string | undefined> = []): string {
  let out = String(text);
  for (const secret of secrets) if (secret && secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[redacted-token]")
    .replace(/\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]")
    .replace(/\bpostgres(?:ql)?:\/\/\S+/gi, "[redacted-dsn]")
    .replace(/https?:\/\/\S+/gi, "[external URL]")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------------------------
// Store (Supabase in the CLI, a disposable Postgres in tests)
// ---------------------------------------------------------------------------------------------

export interface CanaryCompany { id: string; name: string; canonical_domain: string | null }
export interface CanaryBoard extends CompanyAtsEvidence { id: string }
export interface CanaryStore {
  /** Names of required tables/columns that are absent; empty when the schema matches COMPANY_PROFILE_SCHEMA_VERSION. */
  missingSchema(): Promise<string[]>;
  /** Read-only: each single-column CHECK on company_profile_facts.{fact_key,source_kind,conflict_source_kind} as pg_get_constraintdef text. */
  factAllowlists(): Promise<Array<{ column_name: string; definition: string }>>;
  companies(ids: string[]): Promise<CanaryCompany[]>;
  /** Enabled ATS boards for one company (at most 10, as the batch path). */
  boards(companyId: string): Promise<CanaryBoard[]>;
  /** Every row of `table` for these companies, normalized with normalizeCanaryRow. */
  rows(table: CanaryTable, companyIds: string[]): Promise<CanaryRow[]>;
  insert(table: CanaryTable, row: CanaryRow): Promise<void>;
  /** UPDATE … SET `set` WHERE every column equals `match` (NULL-safe); returns rows changed. */
  updateWhere(table: CanaryTable, match: CanaryRow, set: CanaryRow): Promise<number>;
  /** DELETE … WHERE every column equals `match` (NULL-safe); returns rows removed. */
  deleteWhere(table: CanaryTable, match: CanaryRow): Promise<number>;
}

export function readOnlyCanaryStore(store: CanaryStore): CanaryStore {
  const refuse = async () => { throw new Error("Dry-run store is read-only"); };
  return { missingSchema: () => store.missingSchema(), factAllowlists: () => store.factAllowlists(), companies: (ids) => store.companies(ids), boards: (id) => store.boards(id), rows: (t, ids) => store.rows(t, ids), insert: refuse, updateWhere: refuse, deleteWhere: refuse };
}

// ---------------------------------------------------------------------------------------------
// Official-source crawl (shared by the batch path and the canary; same robots/ATS/verification checks)
// ---------------------------------------------------------------------------------------------

export interface FetchedPage { url: string; text: string; status: number; contentType: string }
export type PageFetcher = (url: string) => Promise<FetchedPage>;
export type Sleeper = (ms: number) => Promise<void>;
export interface SourceRecord { company_id: string; kind: "robots" | "page" | "wikidata"; requested_url: string; final_url: string; status: number; fetched_at: string; bytes: number; sha256: string }

export async function fetchWithBackoff(fetchPage: PageFetcher, sleep: Sleeper, url: string): Promise<FetchedPage> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await fetchPage(url); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !/HTTP 5\d\d|timeout|fetch failed/i.test(message) || /HTTP 429|HTTP 403/i.test(message)) throw error;
      await sleep(500 * (attempt + 1));
    }
  }
  throw new Error("Company source retry limit exceeded");
}

export async function fetchRobotsTxt(fetchPage: PageFetcher, sleep: Sleeper, url: string): Promise<FetchedPage> {
  try { return await fetchWithBackoff(fetchPage, sleep, url); }
  catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) return { text: "", url, contentType: "text/plain", status: 404 };
    throw error;
  }
}

/** Same-host about/leadership/news pages fetched after the homepage; bounds every crawl and the planner's request estimate. */
export const MAX_OFFICIAL_SUBPAGES = 3;

export function officialCandidateUrls(homeHtml: string, origin: string): string[] {
  const originHost = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  const urls = new Set<string>();
  for (const match of Array.from(homeHtml.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi))) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), origin);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (url.protocol === "https:" && host === originHost && /(?:about|leadership|team|management|news|press|stories|blog|reports?)/i.test(url.pathname)) urls.add(url.href);
    } catch {}
  }
  return Array.from(urls).slice(0, MAX_OFFICIAL_SUBPAGES);
}

export type CrawlOutcome = "no_ats_evidence" | "robots_disallowed" | "off_domain_redirect" | "not_ats_linked" | "not_verified" | "verified";

export async function crawlOfficialProfile(input: {
  company: CanaryCompany; boards: CompanyAtsEvidence[]; fetchPage: PageFetcher; sleep: Sleeper; now: () => string; record?: (source: Omit<SourceRecord, "company_id">) => void;
}): Promise<{ outcome: CrawlOutcome; extracted: OfficialPageExtraction | null }> {
  const { company, boards, fetchPage, sleep, now, record } = input;
  if (!boards.length) return { outcome: "no_ats_evidence", extracted: null };
  const domain = String(company.canonical_domain || "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!domain || domain.includes("@") || domain.includes(":")) throw new Error("Canonical domain is invalid");
  const fetched = async (kind: SourceRecord["kind"], url: string) => {
    const page = kind === "robots" ? await fetchRobotsTxt(fetchPage, sleep, url) : await fetchWithBackoff(fetchPage, sleep, url);
    const fetchedAt = now();
    record?.({ kind, requested_url: url, final_url: page.url, status: page.status, fetched_at: fetchedAt, bytes: Buffer.byteLength(page.text), sha256: sha256(page.text) });
    return { page, fetchedAt };
  };
  const { page: robots } = await fetched("robots", `https://${domain}/robots.txt`);
  if (!robotsAllows(robots.text, "/")) return { outcome: "robots_disallowed", extracted: null };
  const { page, fetchedAt } = await fetched("page", `https://${domain}/`);
  // A homepage that redirects to another site is not this company's official source; never crawl the other host.
  const site = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return null; } };
  if (site(page.url) !== domain.replace(/^www\./, "")) return { outcome: "off_domain_redirect", extracted: null };
  if (!isAtsEvidenceLinked(domain, page.text, page.url, boards)) return { outcome: "not_ats_linked", extracted: null };
  let extracted = extractOfficialCompanyPage({ html: page.text, pageUrl: page.url, canonicalDomain: domain, companyName: company.name, atsBoards: boards, retrievedAt: fetchedAt });
  const verifiedHomepageContext = extracted.verified ? { verified: true, homepageUrl: page.url, homepageHtml: page.text } : undefined;
  for (const candidateUrl of officialCandidateUrls(page.text, page.url)) {
    if (!robotsAllows(robots.text, new URL(candidateUrl).pathname)) continue;
    await sleep(1_000);
    const { page: candidate, fetchedAt: candidateAt } = await fetched("page", candidateUrl);
    if (site(candidate.url) !== site(page.url)) continue;
    const candidateData = extractOfficialCompanySubpage({ html: candidate.text, pageUrl: candidate.url, canonicalDomain: domain, companyName: company.name, atsBoards: boards, homepageContext: verifiedHomepageContext, retrievedAt: candidateAt });
    if (!candidateData.verified) continue;
    extracted = { verified: true, facts: reconcileCompanyFacts(extracted.facts, candidateData.facts, true), leadership: [...extracted.leadership, ...candidateData.leadership].slice(0, 12), news: [...extracted.news, ...candidateData.news].slice(0, 8) };
  }
  return extracted.verified ? { outcome: "verified", extracted } : { outcome: "not_verified", extracted: null };
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------

export interface CanaryAction { seq: number; company_id: string; table: CanaryTable; op: "insert" | "update"; key: CanaryRow; before: CanaryRow | null; after: CanaryRow }
export interface CanaryCompanyPlan {
  company_id: string; name: string; canonical_domain: string | null;
  ats_boards: Array<{ id: string; ats_type: string | null; slug: string | null; careers_url: string | null }>;
  freshness: { status: "fresh" | "stale" | "conflict"; should_refresh: boolean };
  outcome: CrawlOutcome | "cache_hit" | "fetch_failed";
  error: string | null;
  proposed: { facts: CanaryRow[]; leadership: CanaryRow[]; news: CanaryRow[] };
  current: Record<CanaryTable, CanaryRow[]>;
  /** Present only when the plan was made with a Wikidata fetcher (Step D). */
  wikidata?: { outcome: WikidataProfile["outcome"] | "fetch_failed"; entity_id: string | null; error: string | null };
}
export interface CanaryPlan {
  kind: "company-profile-canary-plan"; format: 1; atomic: false;
  target_project: string; company_ids: string[]; max_companies: number;
  code_sha: string; schema_version: string; created_at: string; expires_at: string;
  sources: SourceRecord[];
  companies: CanaryCompanyPlan[];
  actions: CanaryAction[];
  summary: { companies: number; planned_companies: number; inserts: number; updates: number; by_table: Record<CanaryTable, number> };
  plan_digest: string;
}

export const sortCanaryRows = (table: CanaryTable, rows: CanaryRow[]) => [...rows].sort((a, b) => canonicalJson(keyOf(table, a)).localeCompare(canonicalJson(keyOf(table, b))));

async function snapshot(store: CanaryStore, companyIds: string[]): Promise<Record<string, Record<CanaryTable, CanaryRow[]>>> {
  const out: Record<string, Record<CanaryTable, CanaryRow[]>> = {};
  for (const id of companyIds) out[id] = Object.fromEntries(TABLE_NAMES.map((t) => [t, [] as CanaryRow[]])) as Record<CanaryTable, CanaryRow[]>;
  for (const table of TABLE_NAMES) {
    for (const row of await store.rows(table, companyIds)) {
      const id = String(row.company_id);
      if (!out[id]) throw new Error(`Store returned a ${table} row outside the allowlist`);
      out[id][table].push(row);
    }
  }
  for (const id of companyIds) for (const table of TABLE_NAMES) out[id][table] = sortCanaryRows(table, out[id][table]);
  return out;
}

export function missingFactAllowlists(defs: Array<{ column_name: string; definition: string }>): string[] {
  return Object.entries(REQUIRED_FACT_ALLOWLISTS).flatMap(([column, values]) => {
    const checks = defs.filter((d) => d.column_name === column);
    return values.filter((v) => !checks.length || checks.some((d) => !d.definition.includes(`'${v}'`))).map((v) => `company_profile_facts.${column} allowlist '${v}'`);
  });
}

/** Read-only preflight run before any plan and before any row write; a missing allowlist refuses the whole plan. */
async function requireSchemaAndCompanies(store: CanaryStore, companyIds: string[]): Promise<CanaryCompany[]> {
  const missing = await store.missingSchema();
  let defs: Array<{ column_name: string; definition: string }>;
  try { defs = await store.factAllowlists(); }
  catch { throw new Error(`Schema ${COMPANY_PROFILE_SCHEMA_VERSION} is not applied: the company_profile_fact_allowlists() preflight is unavailable`); }
  missing.push(...missingFactAllowlists(defs));
  if (missing.length) throw new Error(`Schema ${COMPANY_PROFILE_SCHEMA_VERSION} is not applied: missing ${missing.join(", ")}`);
  const companies = await store.companies(companyIds);
  const found = new Map(companies.map((c) => [c.id.toLowerCase(), c]));
  const absent = companyIds.filter((id) => !found.has(id));
  if (absent.length || companies.length !== companyIds.length) throw new Error(`Company IDs not found: ${absent.join(", ") || "(unexpected extra rows)"}`);
  return companyIds.map((id) => found.get(id)!);
}

function factRow(companyId: string, key: string, fact: CompanyFact): CanaryRow {
  return normalizeCanaryRow("company_profile_facts", {
    company_id: companyId, fact_key: key, fact_value: fact.value, source_url: fact.sourceUrl, source_kind: fact.sourceKind, retrieved_at: fact.retrievedAt,
    observed_at: fact.observedAt || null, fact_status: fact.status || "fresh", conflict_value: fact.conflict?.value || null, conflict_source_url: fact.conflict?.sourceUrl || null,
    conflict_source_kind: fact.conflict?.sourceKind || null, conflict_retrieved_at: fact.conflict?.retrievedAt || null, conflict_observed_at: fact.conflict?.observedAt || null,
  });
}

export async function buildCanaryPlan(input: {
  store: CanaryStore; fetchPage: PageFetcher; sleep: Sleeper; now: () => Date; newId: () => string;
  targetProject: string; companyIds: string[]; maxCompanies: number; codeSha: string; ttlHours?: number; secrets?: string[];
  /** Step D: Wikidata Action API fetcher. Wikidata fills only fact keys no official source covers. */
  fetchWikidata?: WikidataFetcher;
}): Promise<CanaryPlan> {
  const { store, fetchPage, sleep, now, newId } = input;
  if (input.targetProject !== COMPANY_PROFILE_PRODUCTION_PROJECT_REF) throw new Error("Plan target must be the production project");
  // One client for the whole plan: the 1 req/s pacer, 429 cooldown and response cache span every company.
  const fetchWikidata = input.fetchWikidata && wikidataClient(input.fetchWikidata, { sleep, nowMs: () => now().getTime(), cache: true });
  if (!input.companyIds.length || input.companyIds.length > input.maxCompanies || input.maxCompanies > CANARY_MAX_COMPANIES) throw new Error("Company allowlist is empty or over the cap");
  const createdAt = canonicalTimestamp(now())!;
  const companies = await requireSchemaAndCompanies(store, input.companyIds);
  const current = await snapshot(store, input.companyIds);
  const sources: SourceRecord[] = [];
  const companyPlans: CanaryCompanyPlan[] = [];
  const actions: Array<Omit<CanaryAction, "seq">> = [];
  for (const company of companies) {
    const rows = current[company.id];
    const boards = await store.boards(company.id);
    const existing: Partial<Record<CompanyFactKey, CompanyFact>> = {};
    for (const row of rows.company_profile_facts) {
      existing[row.fact_key as CompanyFactKey] = {
        value: row.fact_value!, sourceUrl: row.source_url!, sourceKind: row.source_kind as CompanyFact["sourceKind"], retrievedAt: row.retrieved_at!, observedAt: row.observed_at, status: row.fact_status as CompanyFact["status"],
        conflict: row.conflict_value ? { value: row.conflict_value, sourceUrl: row.conflict_source_url!, sourceKind: row.conflict_source_kind as CompanyFact["sourceKind"], retrievedAt: row.conflict_retrieved_at!, observedAt: row.conflict_observed_at } : null,
      };
    }
    const state = rows.company_profile_refresh_state[0] || null;
    const freshness = evaluateCompanyProfileFreshness({
      now: createdAt, state,
      facts: Object.fromEntries(Object.entries(existing).map(([k, f]) => [k, { retrievedAt: f!.retrievedAt, status: f!.status }])),
      leadership: rows.company_profile_leadership.map((r) => ({ retrievedAt: r.retrieved_at! })),
      news: rows.company_profile_news.map((r) => ({ publishedAt: r.published_at!, retrievedAt: r.retrieved_at! })),
    });
    const plan: CanaryCompanyPlan = {
      company_id: company.id, name: company.name, canonical_domain: company.canonical_domain,
      ats_boards: boards.map((b) => ({ id: b.id, ats_type: b.ats_type ?? null, slug: b.slug ?? null, careers_url: b.careers_url ?? null })),
      freshness: { status: freshness.status, should_refresh: freshness.shouldRefresh }, outcome: "cache_hit", error: null,
      proposed: { facts: [], leadership: [], news: [] }, current: rows,
    };
    companyPlans.push(plan);
    if (!freshness.shouldRefresh) continue;
    let crawl: Awaited<ReturnType<typeof crawlOfficialProfile>> | null = null;
    try {
      crawl = await crawlOfficialProfile({ company, boards, fetchPage, sleep, now: () => canonicalTimestamp(now())!, record: (s) => sources.push({ company_id: company.id, ...s }) });
      plan.outcome = crawl.outcome;
    } catch (error) {
      plan.outcome = "fetch_failed";
      plan.error = redactCanaryText(error instanceof Error ? error.message : String(error), input.secrets);
      if (!fetchWikidata) continue;
    }
    // Wikidata is independent of the official crawl's identity gate: its own identity rule is P856 == stored domain.
    let wikidata: WikidataProfile | null = null;
    if (fetchWikidata) {
      plan.wikidata = { outcome: "no_match", entity_id: null, error: null };
      try {
        wikidata = await fetchWikidataProfile({ company, fetchJson: fetchWikidata, now: () => canonicalTimestamp(now())!, sha256, record: (s) => sources.push({ company_id: company.id, ...s }) });
        plan.wikidata = { outcome: wikidata.outcome, entity_id: wikidata.entityId, error: null };
      } catch (error) {
        plan.wikidata = { outcome: "fetch_failed", entity_id: null, error: redactCanaryText(error instanceof Error ? error.message : String(error), input.secrets) };
      }
    }
    const official = crawl?.extracted || null;
    if (!official && !wikidata?.entityId) continue;
    // Official sources always win: Wikidata only fills keys that no official row or observation covers, and a
    // stored Wikidata value is replaced outright (never a conflict) once an official source states the key.
    const officialKeys = new Set([...Object.keys(official?.facts || {}), ...Object.entries(existing).filter(([, f]) => f!.sourceKind !== "wikidata").map(([k]) => k)]);
    const fromWikidata = Object.fromEntries(Object.entries(wikidata?.facts || {}).filter(([k]) => !officialKeys.has(k)));
    const base = Object.fromEntries(Object.entries(existing).filter(([k, f]) => !(f!.sourceKind === "wikidata" && official?.facts[k as CompanyFactKey]))) as typeof existing;
    const next = reconcileCompanyFacts(base, { ...fromWikidata, ...(official?.facts || {}) }, true);
    const nextFacts = Object.entries(next).map(([key, fact]) => factRow(company.id, key, fact!));
    plan.proposed.facts = nextFacts;
    if (!nextFacts.length) continue;
    for (const after of nextFacts) {
      const before = rows.company_profile_facts.find((r) => r.fact_key === after.fact_key) || null;
      if (!sameRow(before, after)) actions.push({ company_id: company.id, table: "company_profile_facts", op: before ? "update" : "insert", key: keyOf("company_profile_facts", after), before, after });
    }
    // Leadership is never concatenated: Wikidata leaders only when no official leader is observed or stored.
    const hasOfficialLeaders = Boolean(official?.leadership.length) || rows.company_profile_leadership.some((r) => !isWikidataSource(r.source_url));
    const leaders = dedupeLeadershipObservations((hasOfficialLeaders ? official?.leadership || [] : wikidata?.leadership || []).map((p) => ({ company_id: company.id, name: p.name, role: p.role, role_as_of: p.roleAsOf ? p.roleAsOf.slice(0, 10) : null, source_url: p.sourceUrl, retrieved_at: canonicalTimestamp(p.retrievedAt)! })));
    for (const leader of leaders) {
      const before = rows.company_profile_leadership.find((r) => r.name === leader.name && r.role === leader.role && r.role_as_of === leader.role_as_of) || null;
      // Same identity: only retrieved_at moves forward, as the observation RPC does; sourced fields stay.
      const after = before
        ? { ...before, retrieved_at: Date.parse(leader.retrieved_at) > Date.parse(before.retrieved_at!) ? leader.retrieved_at : before.retrieved_at }
        : normalizeCanaryRow("company_profile_leadership", { id: newId(), ...leader });
      plan.proposed.leadership.push(after);
      if (!sameRow(before, after)) actions.push({ company_id: company.id, table: "company_profile_leadership", op: before ? "update" : "insert", key: keyOf("company_profile_leadership", after), before, after });
    }
    const news = dedupeCompanyNewsObservations((official?.news || []).map((n) => ({ company_id: company.id, headline: n.headline, published_at: canonicalTimestamp(n.publishedAt)!, source_url: n.sourceUrl, excerpt: n.excerpt || null, retrieved_at: createdAt })));
    for (const item of news) {
      const before = rows.company_profile_news.find((r) => r.source_url === item.source_url) || null;
      const after = before
        ? { ...before, retrieved_at: Date.parse(item.retrieved_at) > Date.parse(before.retrieved_at!) ? item.retrieved_at : before.retrieved_at }
        : normalizeCanaryRow("company_profile_news", { id: newId(), ...item });
      plan.proposed.news.push(after);
      if (!sameRow(before, after)) actions.push({ company_id: company.id, table: "company_profile_news", op: before ? "update" : "insert", key: keyOf("company_profile_news", after), before, after });
    }
    const conflict = nextFacts.some((f) => f.fact_status === "conflict");
    const refreshAfter = normalizeCanaryRow("company_profile_refresh_state", {
      company_id: company.id, status: conflict ? "conflict" : "fresh", last_attempted_at: createdAt, last_succeeded_at: createdAt,
      next_refresh_at: new Date(Date.parse(createdAt) + (conflict ? 30 : 7) * 86_400_000).toISOString(), last_error: null,
    });
    actions.push({ company_id: company.id, table: "company_profile_refresh_state", op: state ? "update" : "insert", key: keyOf("company_profile_refresh_state", refreshAfter), before: state, after: refreshAfter });
  }
  const numbered = actions.map((action, index) => ({ seq: index + 1, ...action }));
  const byTable = Object.fromEntries(TABLE_NAMES.map((t) => [t, numbered.filter((a) => a.table === t).length])) as Record<CanaryTable, number>;
  const body: Omit<CanaryPlan, "plan_digest"> = {
    kind: "company-profile-canary-plan", format: 1, atomic: false,
    target_project: input.targetProject, company_ids: [...input.companyIds], max_companies: input.maxCompanies,
    code_sha: input.codeSha, schema_version: COMPANY_PROFILE_SCHEMA_VERSION,
    created_at: createdAt, expires_at: canonicalTimestamp(new Date(Date.parse(createdAt) + (input.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000))!,
    sources, companies: companyPlans, actions: numbered,
    summary: { companies: companyPlans.length, planned_companies: new Set(numbered.map((a) => a.company_id)).size, inserts: numbered.filter((a) => a.op === "insert").length, updates: numbered.filter((a) => a.op === "update").length, by_table: byTable },
  };
  return { ...body, plan_digest: computePlanDigest(body) };
}

// ---------------------------------------------------------------------------------------------
// Plan verification (offline interlocks, then live revalidation)
// ---------------------------------------------------------------------------------------------

export interface CanaryBinding { targetProject: string; companyIds: string[]; maxCompanies: number; confirmDigest: string; codeSha?: string; now?: Date; checkExpiry?: boolean }

export function verifyCanaryPlan(plan: CanaryPlan, binding: CanaryBinding): void {
  if (!plan || plan.kind !== "company-profile-canary-plan" || plan.format !== 1) throw new Error("Not a company-profile canary plan");
  if (computePlanDigest(plan) !== plan.plan_digest) throw new Error("Plan digest mismatch: the plan file was modified after it was generated");
  if (binding.confirmDigest !== plan.plan_digest) throw new Error("--confirm-digest does not match the reviewed plan's digest");
  if (plan.target_project !== COMPANY_PROFILE_PRODUCTION_PROJECT_REF || binding.targetProject !== plan.target_project) throw new Error("Plan was made for a different target project");
  if (plan.schema_version !== COMPANY_PROFILE_SCHEMA_VERSION) throw new Error(`Plan schema ${plan.schema_version} does not match this code's ${COMPANY_PROFILE_SCHEMA_VERSION}`);
  if (binding.codeSha !== undefined && plan.code_sha !== binding.codeSha) throw new Error("Plan was made by a different code SHA");
  if (canonicalJson(plan.company_ids) !== canonicalJson(binding.companyIds) || plan.max_companies !== binding.maxCompanies) throw new Error("--company-ids / --max-companies do not match the plan");
  if (!plan.company_ids.length || plan.company_ids.length > plan.max_companies || plan.max_companies > CANARY_MAX_COMPANIES || new Set(plan.company_ids).size !== plan.company_ids.length || plan.company_ids.some((id) => !UUID.test(id))) throw new Error("Plan company allowlist is invalid");
  if (binding.checkExpiry !== false && (binding.now ?? new Date()).getTime() >= Date.parse(plan.expires_at)) throw new Error("Plan has expired; generate and review a new dry-run plan");
  // The digest is not a signature, so every action is also checked structurally against the allowlist.
  plan.actions.forEach((action, index) => {
    const spec = CANARY_TABLES[action.table];
    const columnsOk = (row: CanaryRow | null) => row !== null && canonicalJson(Object.keys(row).sort()) === canonicalJson([...spec.columns].sort());
    if (!spec || action.seq !== index + 1 || !plan.company_ids.includes(action.company_id) || !columnsOk(action.after) || action.after.company_id !== action.company_id
      || !sameRow(action.key, keyOf(action.table, action.after))
      || (action.op === "insert" ? action.before !== null : action.op !== "update" || !columnsOk(action.before) || !sameRow(keyOf(action.table, action.before!), action.key))) {
      throw new Error(`Plan action ${index + 1} is malformed or outside the allowlist`);
    }
  });
}

const isWikidataSource = (url: string | null) => { try { return new URL(String(url)).hostname === WIKIDATA_HOST; } catch { return false; } };

/** Refetches every source of a planned company; Wikidata goes through an uncached paced client, so it is really re-read. */
async function verifySources(plan: CanaryPlan, fetchPage: PageFetcher, sleep: Sleeper, wikidata: WikidataFetcher | null): Promise<void> {
  const planned = new Set(plan.actions.map((action) => action.company_id));
  const sources = plan.sources.filter((s) => planned.has(s.company_id));
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (index) await sleep(1_000);
    if (source.kind === "wikidata" && !wikidata) throw new Error("The plan has Wikidata sources; the write needs a Wikidata fetcher to revalidate them");
    const page = source.kind === "wikidata" ? await wikidata!(source.requested_url) : source.kind === "robots" ? await fetchRobotsTxt(fetchPage, sleep, source.requested_url) : await fetchWithBackoff(fetchPage, sleep, source.requested_url);
    if (page.url !== source.final_url || page.status !== source.status || sha256(page.text) !== source.sha256) throw new Error(`Source drift for company ${source.company_id}: an official page changed since the plan was made`);
  }
}

// ---------------------------------------------------------------------------------------------
// Write-ahead journal: write, resume, rollback
// ---------------------------------------------------------------------------------------------

export type JournalStepStatus = "pending" | "applied" | "failed";
export interface CanaryJournalStep { seq: number; company_id: string; table: CanaryTable; op: "insert" | "update"; key: CanaryRow; before: CanaryRow | null; after: CanaryRow; status: JournalStepStatus; at: string; error?: string }
export type RollbackResult = "restored" | "removed" | "already_restored" | "already_absent" | "not_applied" | "skipped_drifted" | "failed";
export interface CanaryJournal {
  kind: "company-profile-canary-journal"; format: 1; atomic: false;
  plan_digest: string; target_project: string; company_ids: string[]; code_sha: string;
  started_at: string; updated_at: string;
  steps: CanaryJournalStep[];
  rollback: null | { at: string; results: Array<{ seq: number; table: CanaryTable; key: CanaryRow; result: RollbackResult; error?: string }> };
}
export interface JournalIO { read(): CanaryJournal | null; write(journal: CanaryJournal): void }

export class CanaryStoppedError extends Error {
  constructor(message: string, readonly seq: number | null) { super(message); this.name = "CanaryStoppedError"; }
}

async function currentRow(store: CanaryStore, table: CanaryTable, key: CanaryRow, companyId: string): Promise<CanaryRow | null> {
  const rows = (await store.rows(table, [companyId])).filter((row) => sameRow(keyOf(table, row), key));
  if (rows.length > 1) throw new Error(`Identity is not unique for ${table}`);
  return rows[0] || null;
}

function journalMatchesPlan(journal: CanaryJournal, plan: CanaryPlan): void {
  if (journal.kind !== "company-profile-canary-journal" || journal.plan_digest !== plan.plan_digest || journal.target_project !== plan.target_project) throw new Error("Journal belongs to a different plan or target");
  for (const step of journal.steps) {
    const action = plan.actions[step.seq - 1];
    if (!action || action.table !== step.table || action.op !== step.op || !sameRow(action.key, step.key) || !sameRow(action.before, step.before) || !sameRow(action.after, step.after)) {
      throw new Error(`Journal step ${step.seq} does not match the reviewed plan`);
    }
  }
}

export interface CanaryWriteReport { mode: "write" | "resume"; plan_digest: string; atomic: false; applied: number; already_applied: number; total: number }

/** --write / --resume: interlocks, live revalidation, then each planned row as one compare-and-set step. */
export async function runCanaryWrite(input: {
  plan: CanaryPlan; binding: CanaryBinding; store: CanaryStore; fetchPage: PageFetcher; sleep: Sleeper; journal: JournalIO; resume: boolean; now?: () => Date; secrets?: string[];
  fetchWikidata?: WikidataFetcher;
}): Promise<CanaryWriteReport> {
  const { plan, store, journal: io } = input;
  const clock = input.now ?? (() => new Date());
  verifyCanaryPlan(plan, { ...input.binding, now: clock(), checkExpiry: true });
  if (input.binding.codeSha === undefined) throw new Error("A code SHA is required to write");
  let journal = io.read();
  if (input.resume) {
    if (!journal) throw new Error("--resume needs an existing journal");
    journalMatchesPlan(journal, plan);
    if (journal.rollback) throw new Error("This canary was rolled back; generate a new plan instead of resuming");
  } else if (journal) {
    throw new Error("Journal already exists; use --resume to continue it or --rollback to undo it");
  }
  await requireSchemaAndCompanies(store, plan.company_ids);
  if (!input.resume) {
    const live = await snapshot(store, plan.company_ids);
    for (const company of plan.companies) {
      for (const table of TABLE_NAMES) {
        if (canonicalJson(live[company.company_id][table]) !== canonicalJson(company.current[table])) throw new Error(`Stale baseline: ${table} rows for company ${company.company_id} changed since the plan was made`);
      }
    }
  }
  await verifySources(plan, input.fetchPage, input.sleep, input.fetchWikidata ? wikidataClient(input.fetchWikidata, { sleep: input.sleep, nowMs: () => clock().getTime(), cache: false }) : null);
  const stamp = () => canonicalTimestamp(clock())!;
  if (!journal) {
    journal = { kind: "company-profile-canary-journal", format: 1, atomic: false, plan_digest: plan.plan_digest, target_project: plan.target_project, company_ids: plan.company_ids, code_sha: plan.code_sha, started_at: stamp(), updated_at: stamp(), steps: [], rollback: null };
    io.write(journal);
  }
  const save = () => { journal!.updated_at = stamp(); io.write(journal!); };
  let applied = 0, alreadyApplied = 0;
  for (const action of plan.actions) {
    let step = journal.steps.find((s) => s.seq === action.seq);
    const live = await currentRow(store, action.table, action.key, action.company_id);
    if (step) {
      if (sameRow(live, action.after)) {
        if (step.status !== "applied") { step.status = "applied"; step.at = stamp(); delete step.error; save(); }
        alreadyApplied++;
        continue;
      }
      if (step.status === "applied") throw new CanaryStoppedError(`Step ${action.seq} (${action.table}) was applied but the row has since changed; stopping`, action.seq);
    }
    if (!sameRow(live, action.before)) throw new CanaryStoppedError(`Drift before step ${action.seq} (${action.table}): the row no longer matches the reviewed before-image`, action.seq);
    if (!step) {
      step = { ...structuredClone(action), status: "pending", at: stamp() };
      journal.steps.push(step);
    } else { step.status = "pending"; step.at = stamp(); delete step.error; }
    save(); // write-ahead: the before-image is durable before the row changes
    try {
      if (action.op === "insert") await store.insert(action.table, action.after);
      else if ((await store.updateWhere(action.table, action.before!, action.after)) !== 1) throw new Error("conditional update matched no row (concurrent change)");
    } catch (error) {
      step.status = "failed";
      step.error = redactCanaryText(error instanceof Error ? error.message : String(error), input.secrets);
      save();
      throw new CanaryStoppedError(`Step ${action.seq} (${action.table}) failed: ${step.error}. Completed steps are journaled; fix the cause, then --resume or --rollback`, action.seq);
    }
    step.status = "applied"; step.at = stamp();
    save();
    applied++;
  }
  return { mode: input.resume ? "resume" : "write", plan_digest: plan.plan_digest, atomic: false, applied, already_applied: alreadyApplied, total: plan.actions.length };
}

export interface CanaryRollbackReport { mode: "rollback"; plan_digest: string; atomic: false; results: Record<RollbackResult, number> }

/** Restores before-images and removes canary-inserted rows, each only if the row still holds the canary's value. */
export async function runCanaryRollback(input: { plan: CanaryPlan; binding: CanaryBinding; store: CanaryStore; journal: JournalIO; now?: () => Date; secrets?: string[] }): Promise<CanaryRollbackReport> {
  const { plan, store, journal: io } = input;
  const clock = input.now ?? (() => new Date());
  verifyCanaryPlan(plan, { ...input.binding, codeSha: undefined, checkExpiry: false });
  const journal = io.read();
  if (!journal) throw new Error("--rollback needs the journal written by --write");
  journalMatchesPlan(journal, plan);
  const missing = await store.missingSchema();
  if (missing.length) throw new Error(`Schema ${COMPANY_PROFILE_SCHEMA_VERSION} is not applied: missing ${missing.join(", ")}`);
  const results: NonNullable<CanaryJournal["rollback"]>["results"] = [];
  for (const step of [...journal.steps].sort((a, b) => b.seq - a.seq)) {
    let result: RollbackResult;
    let error: string | undefined;
    try {
      const changed = step.op === "insert" ? await store.deleteWhere(step.table, step.after) : await store.updateWhere(step.table, step.after, step.before!);
      if (changed === 1) result = step.op === "insert" ? "removed" : "restored";
      else {
        const live = await currentRow(store, step.table, step.key, step.company_id);
        if (step.op === "insert") result = live === null ? (step.status === "applied" ? "already_absent" : "not_applied") : "skipped_drifted";
        else result = sameRow(live, step.before) ? (step.status === "applied" ? "already_restored" : "not_applied") : "skipped_drifted";
      }
    } catch (caught) {
      result = "failed";
      error = redactCanaryText(caught instanceof Error ? caught.message : String(caught), input.secrets);
    }
    results.push({ seq: step.seq, table: step.table, key: step.key, result, ...(error ? { error } : {}) });
  }
  journal.rollback = { at: canonicalTimestamp(clock())!, results };
  journal.updated_at = journal.rollback.at;
  io.write(journal);
  const counts = { restored: 0, removed: 0, already_restored: 0, already_absent: 0, not_applied: 0, skipped_drifted: 0, failed: 0 } as Record<RollbackResult, number>;
  for (const r of results) counts[r.result]++;
  if (counts.failed) throw new CanaryStoppedError(`Rollback finished with ${counts.failed} failed step(s); the journal lists them; rerun --rollback after fixing the cause`, null);
  return { mode: "rollback", plan_digest: plan.plan_digest, atomic: false, results: counts };
}
