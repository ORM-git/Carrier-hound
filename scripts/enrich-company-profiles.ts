import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { companyProfileObservationRpc, dedupeCompanyNewsObservations, dedupeLeadershipObservations, evaluateCompanyProfileFreshness, isAllowedCompanyProfileWriteTarget, parseEnrichmentOptions, processCompanyBatch, reconcileCompanyFacts } from "../src/lib/company-profile/enrichment";
import {
  CANARY_ROUTING_FLAGS, CANARY_TABLES, buildCanaryPlan, crawlOfficialProfile, isAllowedCompanyProfileProductionTarget, normalizeCanaryRow, parseCanaryOptions,
  readOnlyCanaryStore, redactCanaryText, resolveCodeSha, runCanaryRollback, runCanaryWrite,
  type CanaryJournal, type CanaryPlan, type CanaryRow, type CanaryStore, type JournalIO,
} from "../src/lib/company-profile/canary";
import { renderCanaryPlanSummary } from "../src/lib/company-profile/review";
import { safeFetchCompanyPage, safeFetchWikidataJson } from "../src/lib/company-profile/safeFetch";
import { WIKIDATA_API } from "../src/lib/company-profile/wikidata";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function supabaseCanaryStore(supabase: SupabaseClient): CanaryStore {
  // NULL-safe equality on every column: the update/delete only touches a row still holding exactly `match`.
  const where = (query: any, match: CanaryRow) => Object.entries(match).reduce((q, [column, value]) => (value === null ? q.is(column, null) : q.eq(column, value)), query);
  return {
    async missingSchema() {
      const missing: string[] = [];
      const required: Record<string, readonly string[]> = { companies: ["id", "name", "canonical_domain"], company_boards: ["id", "company_id", "ats_type", "slug", "careers_url", "enabled"], ...Object.fromEntries(Object.entries(CANARY_TABLES).map(([t, s]) => [t, s.columns])) };
      for (const [table, columns] of Object.entries(required)) {
        const { error } = await supabase.from(table).select(columns.join(",")).limit(0);
        if (error) missing.push(`${table}(${columns.join(",")})`);
      }
      return missing;
    },
    async companies(ids) {
      const { data, error } = await supabase.from("companies").select("id,name,canonical_domain").in("id", ids);
      if (error) throw new Error(`Company lookup failed: ${error.message}`);
      return data || [];
    },
    async boards(companyId) {
      const { data, error } = await supabase.from("company_boards").select("id,ats_type,slug,careers_url").eq("company_id", companyId).eq("enabled", true).limit(10);
      if (error) throw new Error(`ATS identity lookup failed: ${error.message}`);
      return data || [];
    },
    async rows(table, companyIds) {
      const { data, error } = await supabase.from(table).select(CANARY_TABLES[table].columns.join(",")).in("company_id", companyIds);
      if (error) throw new Error(`${table} lookup failed: ${error.message}`);
      return ((data || []) as unknown as Record<string, unknown>[]).map((row) => normalizeCanaryRow(table, row));
    },
    async insert(table, row) {
      const { error } = await supabase.from(table).insert(row);
      if (error) throw new Error(`${table} insert failed: ${error.message}`);
    },
    async updateWhere(table, match, set) {
      const { data, error } = await where(supabase.from(table).update(set), match).select(CANARY_TABLES[table].key.join(","));
      if (error) throw new Error(`${table} conditional update failed: ${error.message}`);
      return data?.length || 0;
    },
    async deleteWhere(table, match) {
      const { data, error } = await where(supabase.from(table).delete(), match).select(CANARY_TABLES[table].key.join(","));
      if (error) throw new Error(`${table} conditional delete failed: ${error.message}`);
      return data?.length || 0;
    },
  };
}

/** Durable JSON write: temp file, fsync, rename over the target. */
function writeJsonDurable(file: string, value: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

function fileJournal(file: string): JournalIO {
  return {
    read: () => (fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as CanaryJournal) : null),
    write: (journal) => writeJsonDurable(file, journal),
  };
}

function gitState(): { head: string | null; dirty: boolean } {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "";
    return { head, dirty };
  } catch { return { head: null, dirty: false }; }
}

async function runProductionCanary(argv: string[]) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";
  const secrets = [key, url];
  try {
    const options = parseCanaryOptions(argv);
    if (!url || !key) throw new Error("Supabase service credentials are required");
    // The target comes from --target-project; the loaded URL must match it, never the other way round.
    if (!isAllowedCompanyProfileProductionTarget(url, process.env.COMPANY_PROFILE_ENV || "", options.targetProject, true)) {
      throw new Error("Production canary refused: needs --production, --target-project <exact production ref>, COMPANY_PROFILE_ENV=production and a Supabase URL for exactly that project");
    }
    const codeSha = resolveCodeSha(gitState(), options.codeSha);
    const store = supabaseCanaryStore(createClient(url, key, { auth: { persistSession: false } }));
    // Wikidata Action API URLs (Step D, owner-approved) use the JSON fetcher; everything else is an official page.
    const fetchWikidata = (apiUrl: string) => safeFetchWikidataJson(apiUrl);
    const fetchPage = (pageUrl: string) => (pageUrl.startsWith(`${WIKIDATA_API}?`) ? fetchWikidata(pageUrl) : safeFetchCompanyPage(pageUrl));
    const binding = { targetProject: options.targetProject, companyIds: options.companyIds, maxCompanies: options.maxCompanies, confirmDigest: options.confirmDigest || "", codeSha };
    if (options.mode === "plan") {
      const planPath = path.resolve(options.planPath);
      if (fs.existsSync(planPath)) throw new Error("--plan-out file already exists; choose a new path");
      const plan = await buildCanaryPlan({ store: readOnlyCanaryStore(store), fetchPage, sleep: delay, now: () => new Date(), newId: randomUUID, targetProject: options.targetProject, companyIds: options.companyIds, maxCompanies: options.maxCompanies, codeSha, ttlHours: options.ttlHours, secrets, fetchWikidata });
      const text = JSON.stringify(plan);
      if (secrets.some((secret) => secret && text.includes(secret))) throw new Error("Plan contains a credential value; refusing to write it");
      writeJsonDurable(planPath, plan);
      const summaryPath = `${planPath.replace(/\.json$/i, "")}.summary.md`;
      fs.writeFileSync(summaryPath, renderCanaryPlanSummary(plan), { flag: "wx" });
      console.log(JSON.stringify({ mode: "plan", dry_run: true, writes: 0, plan: planPath, summary_file: summaryPath, plan_digest: plan.plan_digest, expires_at: plan.expires_at, code_sha: plan.code_sha, summary: plan.summary, outcomes: plan.companies.map((c) => ({ company_id: c.company_id, outcome: c.outcome, error: c.error, wikidata: c.wikidata ?? null })) }, null, 2));
      return;
    }
    const plan = JSON.parse(fs.readFileSync(path.resolve(options.planPath), "utf8")) as CanaryPlan;
    const journal = fileJournal(path.resolve(options.journalPath!));
    const report = options.mode === "rollback"
      ? await runCanaryRollback({ plan, binding, store, journal, secrets })
      : await runCanaryWrite({ plan, binding, store, fetchPage, sleep: delay, journal, resume: options.mode === "resume", secrets });
    console.log(JSON.stringify({ ...report, journal: path.resolve(options.journalPath!) }, null, 2));
  } catch (error) {
    console.error(redactCanaryText(error instanceof Error ? error.message : String(error), secrets));
    process.exitCode = 1;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.some((arg) => CANARY_ROUTING_FLAGS.has(arg))) return runProductionCanary(argv);
  const options = parseEnrichmentOptions(argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Supabase service credentials are required");
  if (options.write && !isAllowedCompanyProfileWriteTarget(url, process.env.COMPANY_PROFILE_ENV || "", process.env.COMPANY_PROFILE_ALLOWED_PROJECT_REF)) throw new Error("Write refused: explicitly set COMPANY_PROFILE_ENV=local|staging and matching COMPANY_PROFILE_ALLOWED_PROJECT_REF");
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  let companyQuery = supabase.from("companies").select("id,name,canonical_domain").not("canonical_domain", "is", null).order("id");
  if (options.afterId) companyQuery = companyQuery.gt("id", options.afterId);
  const { data: companies, error } = await companyQuery.limit(options.cap);
  if (error) throw new Error(`Company selection failed: ${error.message}`);
  const report = { dry_run: !options.write, cap: options.cap, after_id: options.afterId || null, next_after_id: options.afterId || null, selected: companies?.length || 0, cache_hits: 0, stale_checked: 0, conflicts: 0, verified: 0, facts_written: 0, leaders_written: 0, news_written: 0, stopped: false, errors: [] as Array<{ company_id: string; error: string }> };
  const progress = await processCompanyBatch(companies || [], options.afterId || null, async (company) => {
      let lastSucceededAt: string | null = null;
      try {
      const [oldResult, leaderResult, newsResult, stateResult] = await Promise.all([
        supabase.from("company_profile_facts").select("fact_key,fact_value,source_url,source_kind,retrieved_at,observed_at,fact_status,conflict_value,conflict_source_url,conflict_source_kind,conflict_retrieved_at,conflict_observed_at").eq("company_id", company.id),
        supabase.from("company_profile_leadership").select("retrieved_at").eq("company_id", company.id),
        supabase.from("company_profile_news").select("published_at,retrieved_at").eq("company_id", company.id),
        supabase.from("company_profile_refresh_state").select("status,last_succeeded_at,next_refresh_at").eq("company_id", company.id).maybeSingle(),
      ]);
      for (const result of [oldResult, leaderResult, newsResult, stateResult]) if (result.error) throw new Error(`Freshness lookup failed: ${result.error.message}`);
      lastSucceededAt = stateResult.data?.last_succeeded_at || null;
      const existing: any = {};
      for (const row of oldResult.data || []) existing[row.fact_key] = { value: row.fact_value, sourceUrl: row.source_url, sourceKind: row.source_kind, retrievedAt: row.retrieved_at, observedAt: row.observed_at, status: row.fact_status, conflict: row.conflict_value ? { value: row.conflict_value, sourceUrl: row.conflict_source_url, sourceKind: row.conflict_source_kind, retrievedAt: row.conflict_retrieved_at, observedAt: row.conflict_observed_at } : null };
      const freshness = evaluateCompanyProfileFreshness({ now: new Date().toISOString(), state: stateResult.data, facts: Object.fromEntries(Object.entries(existing).map(([key, fact]: [string, any]) => [key, { retrievedAt: fact.retrievedAt, status: fact.status }])), leadership: (leaderResult.data || []).map((row) => ({ retrievedAt: row.retrieved_at })), news: (newsResult.data || []).map((row) => ({ publishedAt: row.published_at, retrievedAt: row.retrieved_at })) });
      if (!freshness.shouldRefresh) { report.cache_hits++; return; }
      report.stale_checked++;
      if (freshness.status === "conflict") report.conflicts++;
      const attemptedAt = new Date().toISOString();
      if (options.write) {
        const attempt = await supabase.from("company_profile_refresh_state").upsert({ company_id: company.id, status: freshness.status, last_attempted_at: attemptedAt, last_succeeded_at: lastSucceededAt, next_refresh_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), last_error: null }, { onConflict: "company_id" });
        if (attempt.error) throw new Error(`Refresh attempt state write failed: ${attempt.error.message}`);
      }
      const { data: atsBoards, error: boardError } = await supabase.from("company_boards").select("id,ats_type,slug,careers_url").eq("company_id", company.id).eq("enabled", true).limit(10);
      if (boardError) throw new Error(`ATS identity lookup failed: ${boardError.message}`);
      const crawl = await crawlOfficialProfile({ company, boards: atsBoards || [], fetchPage: (pageUrl) => safeFetchCompanyPage(pageUrl), sleep: delay, now: () => new Date().toISOString() });
      if (!crawl.extracted) return;
      const extracted = crawl.extracted;
      report.verified++;
      const next = reconcileCompanyFacts(existing, extracted.facts, true);
      const factRows = Object.entries(next).map(([fact_key, fact]) => ({ company_id: company.id, fact_key, fact_value: fact.value, source_url: fact.sourceUrl, source_kind: fact.sourceKind, retrieved_at: fact.retrievedAt, observed_at: fact.observedAt || null, fact_status: fact.status || "fresh", conflict_value: fact.conflict?.value || null, conflict_source_url: fact.conflict?.sourceUrl || null, conflict_source_kind: fact.conflict?.sourceKind || null, conflict_retrieved_at: fact.conflict?.retrievedAt || null, conflict_observed_at: fact.conflict?.observedAt || null }));
      if (options.write && factRows.length) {
        const result = await supabase.from("company_profile_facts").upsert(factRows, { onConflict: "company_id,fact_key" });
        if (result.error) throw result.error;
        report.facts_written += factRows.length;
        const leaders = dedupeLeadershipObservations(extracted.leadership.map((p) => ({ company_id: company.id, name: p.name, role: p.role, role_as_of: p.roleAsOf, source_url: p.sourceUrl, retrieved_at: p.retrievedAt })));
        const news = dedupeCompanyNewsObservations(extracted.news.map((n) => ({ company_id: company.id, headline: n.headline, published_at: n.publishedAt, source_url: n.sourceUrl, excerpt: n.excerpt, retrieved_at: new Date().toISOString() })));
        if (leaders.length) { const r = await supabase.rpc(companyProfileObservationRpc.leadership, { p_observations: leaders }); if (r.error) throw r.error; report.leaders_written += leaders.length; }
        if (news.length) { const r = await supabase.rpc(companyProfileObservationRpc.news, { p_observations: news }); if (r.error) throw r.error; report.news_written += news.length; }
        const conflict = Object.values(next).some((fact) => fact.status === "conflict");
        const checkedAt = new Date().toISOString();
        const refresh = await supabase.from("company_profile_refresh_state").upsert({ company_id: company.id, status: conflict ? "conflict" : "fresh", last_attempted_at: checkedAt, last_succeeded_at: checkedAt, next_refresh_at: new Date(Date.now() + (conflict ? 30 : 7) * 86_400_000).toISOString(), last_error: null }, { onConflict: "company_id" });
        if (refresh.error) throw refresh.error;
      }
      await delay(1_000);
      } catch (error) {
        if (options.write) {
          const failedAt = new Date().toISOString();
          const message = (error instanceof Error ? error.message : String(error)).replace(/https?:\/\/\S+/gi, "[external URL]").slice(0, 500);
          await supabase.from("company_profile_refresh_state").upsert({ company_id: company.id, status: "stale", last_attempted_at: failedAt, last_succeeded_at: lastSucceededAt, next_refresh_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(), last_error: message }, { onConflict: "company_id" });
        }
        throw error;
      }
  });
  report.next_after_id = progress.nextAfterId;
  report.stopped = progress.error !== null;
  if (progress.error) report.errors.push({ company_id: progress.error.companyId, error: progress.error.message });
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
