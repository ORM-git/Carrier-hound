import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { companyProfileObservationRpc, evaluateCompanyProfileFreshness, extractOfficialCompanyPage, extractOfficialCompanySubpage, isAllowedCompanyProfileWriteTarget, isAtsEvidenceLinked, parseEnrichmentOptions, processCompanyBatch, reconcileCompanyFacts, robotsAllows } from "../src/lib/company-profile/enrichment";
import { safeFetchCompanyPage } from "../src/lib/company-profile/safeFetch";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchWithBackoff(url: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await safeFetchCompanyPage(url); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === 2 || !/HTTP 5\d\d|timeout|fetch failed/i.test(message) || /HTTP 429|HTTP 403/i.test(message)) throw error;
      await delay(500 * (attempt + 1));
    }
  }
  throw new Error("Company source retry limit exceeded");
}

async function fetchRobots(url: string) {
  try { return await fetchWithBackoff(url); }
  catch (error) {
    if (error instanceof Error && /HTTP 404/.test(error.message)) return { text: "", url, contentType: "text/plain", status: 404 };
    throw error;
  }
}

function officialCandidateUrls(homeHtml: string, origin: string): string[] {
  const originHost = new URL(origin).hostname.toLowerCase().replace(/^www\./, "");
  const urls = new Set<string>();
  for (const match of Array.from(homeHtml.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi))) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, "&"), origin);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (url.protocol === "https:" && host === originHost && /(?:about|leadership|team|management|news|press|stories|blog|reports?)/i.test(url.pathname)) urls.add(url.href);
    } catch {}
  }
  return [...urls].slice(0, 3);
}

async function main() {
  const options = parseEnrichmentOptions(process.argv.slice(2));
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
      if (!atsBoards?.length) return;
      const domain = String(company.canonical_domain || "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
      if (!domain || domain.includes("@") || domain.includes(":")) throw new Error("Canonical domain is invalid");
      const robots = await fetchRobots(`https://${domain}/robots.txt`);
      if (!robotsAllows(robots.text, "/")) return;
      const page = await fetchWithBackoff(`https://${domain}/`);
      if (!isAtsEvidenceLinked(domain, page.text, page.url, atsBoards || [])) return;
      let extracted = extractOfficialCompanyPage({ html: page.text, pageUrl: page.url, canonicalDomain: domain, companyName: company.name, atsBoards: atsBoards || [] });
      const verifiedHomepageContext = extracted.verified ? { verified: true, homepageUrl: page.url, homepageHtml: page.text } : undefined;
      for (const candidateUrl of officialCandidateUrls(page.text, page.url)) {
        const path = new URL(candidateUrl).pathname;
        if (!robotsAllows(robots.text, path)) continue;
        await delay(1_000);
        const candidate = await fetchWithBackoff(candidateUrl);
        const candidateData = extractOfficialCompanySubpage({ html: candidate.text, pageUrl: candidate.url, canonicalDomain: domain, companyName: company.name, atsBoards: atsBoards || [], homepageContext: verifiedHomepageContext });
        if (!candidateData.verified) continue;
        extracted = { verified: true, facts: reconcileCompanyFacts(extracted.facts, candidateData.facts, true), leadership: [...extracted.leadership, ...candidateData.leadership].slice(0, 12), news: [...extracted.news, ...candidateData.news].slice(0, 8) };
      }
      if (!extracted.verified) return;
      report.verified++;
      const next = reconcileCompanyFacts(existing, extracted.facts, true);
      const factRows = Object.entries(next).map(([fact_key, fact]) => ({ company_id: company.id, fact_key, fact_value: fact.value, source_url: fact.sourceUrl, source_kind: fact.sourceKind, retrieved_at: fact.retrievedAt, observed_at: fact.observedAt || null, fact_status: fact.status || "fresh", conflict_value: fact.conflict?.value || null, conflict_source_url: fact.conflict?.sourceUrl || null, conflict_source_kind: fact.conflict?.sourceKind || null, conflict_retrieved_at: fact.conflict?.retrievedAt || null, conflict_observed_at: fact.conflict?.observedAt || null }));
      if (options.write && factRows.length) {
        const result = await supabase.from("company_profile_facts").upsert(factRows, { onConflict: "company_id,fact_key" });
        if (result.error) throw result.error;
        report.facts_written += factRows.length;
        const leaders = extracted.leadership.map((p) => ({ company_id: company.id, name: p.name, role: p.role, role_as_of: p.roleAsOf, source_url: p.sourceUrl, retrieved_at: p.retrievedAt }));
        const news = extracted.news.map((n) => ({ company_id: company.id, headline: n.headline, published_at: n.publishedAt, source_url: n.sourceUrl, excerpt: n.excerpt, retrieved_at: new Date().toISOString() }));
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
