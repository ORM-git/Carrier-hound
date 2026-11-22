import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
dotenv.config();

import { createClient } from "@supabase/supabase-js";
import { extractOfficialCompanyPage, isAllowedCompanyProfileWriteTarget, parseEnrichmentOptions, reconcileCompanyFacts } from "../src/lib/company-profile/enrichment";
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

function robotsAllows(robots: string, path: string): boolean {
  const groups = robots.split(/\r?\n/);
  let applies = false;
  const disallows: string[] = [];
  for (const line of groups) {
    const [rawKey, ...rest] = line.split(":");
    const key = rawKey?.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") applies = value === "*" || /careermonke/i.test(value);
    else if (key === "disallow" && applies && value) disallows.push(value);
  }
  return !disallows.some((rule) => path.startsWith(rule));
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
  const report = { dry_run: !options.write, cap: options.cap, after_id: options.afterId || null, next_after_id: companies?.at(-1)?.id || options.afterId || null, selected: companies?.length || 0, verified: 0, facts_written: 0, leaders_written: 0, news_written: 0, stopped: false, errors: [] as Array<{ company_id: string; error: string }> };
  for (const company of companies || []) {
    try {
      const { data: atsBoards, error: boardError } = await supabase.from("company_boards").select("id,ats_type,slug,careers_url").eq("company_id", company.id).eq("enabled", true).limit(10);
      if (boardError) throw new Error(`ATS identity lookup failed: ${boardError.message}`);
      if (!atsBoards?.length) continue;
      const domain = String(company.canonical_domain || "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
      if (!domain || domain.includes("@") || domain.includes(":")) throw new Error("Canonical domain is invalid");
      const robots = await fetchRobots(`https://${domain}/robots.txt`);
      if (!robotsAllows(robots.text, "/")) continue;
      const page = await fetchWithBackoff(`https://${domain}/`);
      let extracted = extractOfficialCompanyPage({ html: page.text, pageUrl: page.url, canonicalDomain: domain, companyName: company.name });
      for (const candidateUrl of officialCandidateUrls(page.text, page.url)) {
        const path = new URL(candidateUrl).pathname;
        if (!robotsAllows(robots.text, path)) continue;
        await delay(1_000);
        const candidate = await fetchWithBackoff(candidateUrl);
        const candidateData = extractOfficialCompanyPage({ html: candidate.text, pageUrl: candidate.url, canonicalDomain: domain, companyName: company.name });
        if (!candidateData.verified) continue;
        extracted = { verified: true, facts: reconcileCompanyFacts(extracted.facts, candidateData.facts, true), leadership: [...extracted.leadership, ...candidateData.leadership].slice(0, 12), news: [...extracted.news, ...candidateData.news].slice(0, 8) };
      }
      if (!extracted.verified) continue;
      report.verified++;
      const { data: oldRows, error: oldError } = await supabase.from("company_profile_facts").select("fact_key,fact_value,source_url,source_kind,retrieved_at,observed_at").eq("company_id", company.id);
      if (oldError && !/does not exist|schema cache/i.test(oldError.message)) throw oldError;
      const existing: any = {};
      for (const row of oldRows || []) existing[row.fact_key] = { value: row.fact_value, sourceUrl: row.source_url, sourceKind: row.source_kind, retrievedAt: row.retrieved_at, observedAt: row.observed_at };
      const next = reconcileCompanyFacts(existing, extracted.facts, true);
      const factRows = Object.entries(next).map(([fact_key, fact]) => ({ company_id: company.id, fact_key, fact_value: fact.value, source_url: fact.sourceUrl, source_kind: fact.sourceKind, retrieved_at: fact.retrievedAt, observed_at: fact.observedAt || null }));
      if (options.write && factRows.length) {
        const result = await supabase.from("company_profile_facts").upsert(factRows, { onConflict: "company_id,fact_key" });
        if (result.error) throw result.error;
        report.facts_written += factRows.length;
        const leaders = extracted.leadership.map((p) => ({ company_id: company.id, name: p.name, role: p.role, role_as_of: p.roleAsOf, source_url: p.sourceUrl, retrieved_at: p.retrievedAt }));
        const news = extracted.news.map((n) => ({ company_id: company.id, headline: n.headline, published_at: n.publishedAt, source_url: n.sourceUrl, excerpt: n.excerpt, retrieved_at: new Date().toISOString() }));
        if (leaders.length) { const r = await supabase.from("company_profile_leadership").upsert(leaders, { onConflict: "company_id,name,role,role_as_of", ignoreDuplicates: true }); if (r.error) throw r.error; report.leaders_written += leaders.length; }
        if (news.length) { const r = await supabase.from("company_profile_news").upsert(news, { onConflict: "company_id,source_url", ignoreDuplicates: true }); if (r.error) throw r.error; report.news_written += news.length; }
      }
      await delay(1_000);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ company_id: company.id, error: message });
      if (/HTTP 403|HTTP 429|captcha|challenge/i.test(message)) { report.stopped = true; break; }
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
