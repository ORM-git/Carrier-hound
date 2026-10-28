/**
 * scripts/board-ingest.ts
 *
 * Automated Company Board Ingestion for Greenhouse, Lever, and Ashby.
 *
 * Operational Locks:
 * - Legal documented public endpoints only:
 *     Greenhouse: boards-api.greenhouse.io/v1/boards/<company>/jobs
 *     Lever: api.lever.co/v0/postings/<company>
 *     Ashby: api.ashbyhq.com/posting-api/job-board/<company>
 * - No scraping of HTML career pages, no login, no captcha bypass.
 * - Explicitly banned scrapable domains: LinkedIn, Indeed, Naukri, Glassdoor, Jobright, Workday.
 * - Employer text is never misrepresented; real apply URLs & company names preserved.
 * - Stored sources: 'greenhouse' | 'lever' | 'ashby'.
 * - Rate limit is strictly 1 req/s per host (1000ms delay between consecutive requests to the same domain).
 *   Do not lower rate limit to 500ms unless explicitly instructed.
 * - Closed-job handling:
 *     - Only count misses after a successful non-empty fetch for that specific company board.
 *     - Scoped strictly by source + company_slug.
 *     - Reconciled with cleanup.ts: jobs that vanish are marked inactive after 2 consecutive misses (never deleted).
 *     - Inactive jobs remain until cleanup.ts deletes them after 14 days of being unseen (last_seen_at < 14d).
 *     - Active jobs older than 45 days are naturally expired by cleanup.ts (posted_at < 45d).
 *     - Sensible posted_at: Greenhouse updated_at is NOT a posting date (it updates on recruiter edits).
 *       Use first_published_at or created_at if present; otherwise fall back to discovery time.
 * - Real run and fixture run share ONE canonical normalizer: normalizeAtsJob.
 * - Dry-run mode by default; live database writes require explicit --live-write-unlocked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { NormalizedJob } from './types';
import {
  cleanText,
  cleanAndTruncateDescription,
  detectCountryCode,
  detectRemoteEligibility,
  detectRemote,
  detectJobType,
  detectSeniority,
  detectCategory,
  slugify,
  parseSalary,
  formatSalary,
} from './utils/sanitizer';
import { politeFetchJson, isForbiddenDomain } from './utils/polite-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface CompanyRegistryEntry {
  id: string;
  company: string;
  name?: string;
  ats: 'greenhouse' | 'lever' | 'ashby';
  type?: string;
  token: string;
  target?: string;
  country_hint?: string;
  enabled?: boolean;
}

export interface IngestionOptions {
  dryRun?: boolean;
  limit?: number;
  offset?: number;
  atsFilter?: 'greenhouse' | 'lever' | 'ashby' | 'all';
  companyFilter?: string;
  configPath?: string;
  fixtureMode?: boolean;
  fixtureDir?: string;
}

export interface ClosedJobRecord {
  id: string;
  source: 'greenhouse' | 'lever' | 'ashby';
  company_slug: string;
  source_job_id: string;
  company: string;
  title: string;
  consecutive_misses: number;
  is_active: boolean;
  status: string;
}

export interface ClosedJobDecision {
  id: string;
  source: 'greenhouse' | 'lever' | 'ashby';
  company_slug: string;
  source_job_id: string;
  consecutive_misses: number;
  is_active: boolean;
  status: string;
  action: 'kept_active' | 'marked_inactive' | 'reset_active';
}

export interface BoardIngestionStats {
  verifiedTokensTotal: number;
  tokensPerAts: Record<string, number>;
  companiesAttempted: number;
  companiesSucceeded: number;
  companiesFailed: number;
  totalJobsFetched: number;
  totalJobsAccepted: number;
  totalJobsDeduplicated: number;
  indiaCount: number;
  remoteCount: number;
  nonTechCount: number;
  countryBreakdown: Record<string, number>;
  topCompanies: Array<{ company: string; ats: string; jobs: number }>;
  errors: Array<{ company: string; ats: string; error: string }>;
}

/**
 * Loads the company-token registry from disk (data/ats-company-registry.json).
 */
export function loadCompanyRegistry(customPath?: string): CompanyRegistryEntry[] {
  const resolvedPath = customPath
    ? path.resolve(customPath)
    : path.resolve(__dirname, '../data/ats-company-registry.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`ATS company registry file not found at ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const items: CompanyRegistryEntry[] = JSON.parse(raw);
  return items.filter((item) => item.enabled !== false);
}

/**
 * Builds the canonical public API URL for a given ATS provider and token.
 */
export function buildAtsApiUrl(ats: 'greenhouse' | 'lever' | 'ashby', token: string): string {
  const cleanToken = encodeURIComponent(token.trim().toLowerCase());
  if (ats === 'greenhouse') {
    return `https://boards-api.greenhouse.io/v1/boards/${cleanToken}/jobs?content=true&pay_transparency=true`;
  }
  if (ats === 'lever') {
    return `https://api.lever.co/v0/postings/${cleanToken}?mode=json`;
  }
  if (ats === 'ashby') {
    return `https://api.ashbyhq.com/posting-api/job-board/${cleanToken}`;
  }
  throw new Error(`Unsupported ATS type: ${ats}`);
}

/**
 * Evaluates whether an ATS request URL is authorized and adheres to public API locks.
 * Strictly verifies https protocol, authorized hostnames, and rejects forbidden scrapable domains.
 */
export function isAuthorizedAtsUrl(url: string, ats: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (isForbiddenDomain(url)) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    if (ats === 'greenhouse') {
      return parsed.hostname === 'boards-api.greenhouse.io' && parsed.pathname.startsWith('/v1/boards/');
    }
    if (ats === 'lever') {
      return parsed.hostname === 'api.lever.co' && parsed.pathname.startsWith('/v0/postings/');
    }
    if (ats === 'ashby') {
      return parsed.hostname === 'api.ashbyhq.com' && parsed.pathname.startsWith('/posting-api/job-board/');
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates apply_url to ensure it is HTTPS-only, well-formed, and not hosted on a forbidden domain.
 */
export function isValidApplyUrl(applyUrl: string): boolean {
  if (!applyUrl || typeof applyUrl !== 'string') return false;
  try {
    const parsed = new URL(applyUrl);
    if (parsed.protocol !== 'https:') return false;
    if (isForbiddenDomain(applyUrl)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Fetches raw employer posting objects from authorized public endpoints.
 * Calls isAuthorizedAtsUrl on every request URL before dispatching.
 */
export async function fetchRawAtsJobs(
  ats: 'greenhouse' | 'lever' | 'ashby',
  token: string
): Promise<{ rawJobs: any[]; fetchSucceeded: boolean }> {
  const url = buildAtsApiUrl(ats, token);

  // Security guard: verify URL before making HTTP request
  if (!isAuthorizedAtsUrl(url, ats)) {
    throw new Error(`Unauthorized or forbidden ATS request URL: ${url}`);
  }

  const data = await politeFetchJson<any>(url);
  if (!data) {
    return { rawJobs: [], fetchSucceeded: false };
  }

  if (ats === 'greenhouse') {
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return { rawJobs: jobs, fetchSucceeded: true };
  }
  if (ats === 'lever') {
    const jobs = Array.isArray(data) ? data : [];
    return { rawJobs: jobs, fetchSucceeded: true };
  }
  if (ats === 'ashby') {
    const jobs = Array.isArray(data.jobs) ? data.jobs : [];
    return { rawJobs: jobs, fetchSucceeded: true };
  }

  return { rawJobs: [], fetchSucceeded: false };
}

/**
 * ONE CANONICAL NORMALIZER:
 * Normalizes an employer posting into the standardized CareerMonke jobs schema.
 * Shared by both the live network fetcher and fixture-based tests.
 *
 * Rules:
 * 1. Validates apply_url: must be https-only and non-forbidden host.
 * 2. Sensible posted_at: Greenhouse updated_at is NOT a posting date.
 *    Uses first_published_at or created_at if present; falls back to discovery timestamp.
 * 3. Extracts structured compensation when available with fallback to sanitizing description.
 */
export function normalizeAtsJob(
  raw: any,
  ats: 'greenhouse' | 'lever' | 'ashby',
  company: string,
  slug: string
): NormalizedJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const nowIso = new Date().toISOString();

  // ---------------------------------------------------------------------------
  // GREENHOUSE
  // ---------------------------------------------------------------------------
  if (ats === 'greenhouse') {
    if (!raw.title || !raw.absolute_url) return null;
    const applyUrl = String(raw.absolute_url).trim();
    if (!isValidApplyUrl(applyUrl)) return null;

    const title = cleanText(raw.title);
    if (!title) return null;

    const location = cleanText(raw.location?.name || 'Unspecified');
    const remote = detectRemote(title, location);
    const countryCode = detectCountryCode(location);
    const description = cleanAndTruncateDescription(raw.content, 4000);

    // Sensible posted_at: Greenhouse updated_at is NOT a posting date.
    // Recruiter edits update updated_at. Use first_published_at or created_at if present;
    // otherwise fallback to nowIso (discovery time).
    const postedAt = raw.first_published_at || raw.created_at || nowIso;

    // Structured pay transparency extraction
    let salaryText: string | null = null;
    let salaryMin: number | null = null;
    let salaryMax: number | null = null;
    let currency = 'USD';
    let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

    const validRange = Array.isArray(raw.pay_input_ranges)
      ? raw.pay_input_ranges.find(
          (r: any) =>
            (r && r.min_cents != null && r.min_cents > 0) ||
            (r && r.max_cents != null && r.max_cents > 0)
        )
      : null;

    if (validRange) {
      const rawMin =
        validRange.min_cents != null && validRange.min_cents > 0
          ? validRange.min_cents / 100
          : null;
      const rawMax =
        validRange.max_cents != null && validRange.max_cents > 0
          ? validRange.max_cents / 100
          : null;

      salaryMin = rawMin != null ? Math.round(rawMin) : null;
      salaryMax = rawMax != null ? Math.round(rawMax) : null;

      if (salaryMin != null && salaryMax != null && salaryMin > salaryMax) {
        const temp = salaryMin;
        salaryMin = salaryMax;
        salaryMax = temp;
      }

      if (validRange.currency_type && String(validRange.currency_type).trim()) {
        currency = String(validRange.currency_type).trim().toUpperCase();
      }

      const context = `${validRange.title || ''} ${validRange.blurb || ''}`;
      if (currency === 'USD' && /\b(hour|hourly|\/hr)\b/i.test(context)) {
        salaryPeriod = 'hourly';
      } else {
        salaryPeriod = undefined;
      }

      if (salaryMin != null || salaryMax != null) {
        salaryText = formatSalary(salaryMin, salaryMax, currency, salaryPeriod);
      }
    }

    if (!salaryText && salaryMin == null && salaryMax == null) {
      const fallback = parseSalary(description, { title, location });
      salaryText = fallback.salary_text;
      salaryMin = fallback.salary_min;
      salaryMax = fallback.salary_max;
      currency = fallback.currency;
      salaryPeriod = fallback.salary_period;
    }

    return {
      source: 'greenhouse',
      source_type: 'ats',
      source_job_id: `${slug}-${raw.id}`,
      title,
      company,
      company_slug: slug,
      location,
      country_code: countryCode,
      remote,
      remote_scope: remote ? 'remote' : 'onsite',
      remote_eligibility: detectRemoteEligibility(location, remote),
      job_type: detectJobType(title),
      seniority: detectSeniority(title),
      description,
      apply_url: applyUrl,
      source_url: `https://boards.greenhouse.io/${slug}`,
      salary_text: salaryText,
      salary_min: salaryMin,
      salary_max: salaryMax,
      currency,
      salary_period: salaryPeriod,
      category: detectCategory(title),
      posted_at: postedAt,
      discovered_at: nowIso,
      last_seen_at: nowIso,
      verified: true,
      is_active: true,
    };
  }

  // ---------------------------------------------------------------------------
  // LEVER
  // ---------------------------------------------------------------------------
  if (ats === 'lever') {
    if (!raw.text) return null;
    const applyUrl = String(raw.hostedUrl || raw.applyUrl || '').trim();
    if (!isValidApplyUrl(applyUrl)) return null;

    const title = cleanText(raw.text);
    if (!title) return null;

    const location = cleanText(raw.categories?.location || 'Unspecified');
    const isRemoteWorkplace = raw.workplaceType === 'remote';
    const remote = isRemoteWorkplace || detectRemote(title, location);
    const countryCode = detectCountryCode(location);
    const rawDesc = raw.descriptionPlain || raw.description;
    const description = cleanAndTruncateDescription(rawDesc, 4000);

    const postedAt = raw.createdAt ? new Date(raw.createdAt).toISOString() : nowIso;

    // Structured salary extraction from Lever salaryRange
    let salaryText: string | null = null;
    let salaryMin: number | null = null;
    let salaryMax: number | null = null;
    let currency = 'USD';
    let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

    if (raw.salaryRange && typeof raw.salaryRange === 'object') {
      const min = typeof raw.salaryRange.min === 'number' ? raw.salaryRange.min : null;
      const max = typeof raw.salaryRange.max === 'number' ? raw.salaryRange.max : null;
      if (min != null || max != null) {
        salaryMin = min;
        salaryMax = max;
        currency = raw.salaryRange.currency ? String(raw.salaryRange.currency).toUpperCase() : 'USD';
        const interval = raw.salaryRange.interval ? String(raw.salaryRange.interval).toLowerCase() : '';
        if (interval.includes('hour')) salaryPeriod = 'hourly';
        else if (interval.includes('month')) salaryPeriod = 'monthly';
        else if (interval.includes('year') || interval.includes('annu')) salaryPeriod = 'yearly';
        salaryText = formatSalary(salaryMin, salaryMax, currency, salaryPeriod);
      }
    }

    if (!salaryText && salaryMin == null && salaryMax == null) {
      const fallback = parseSalary(description, { title, location });
      salaryText = fallback.salary_text;
      salaryMin = fallback.salary_min;
      salaryMax = fallback.salary_max;
      currency = fallback.currency;
      salaryPeriod = fallback.salary_period;
    }

    return {
      source: 'lever',
      source_type: 'ats',
      source_job_id: `${slug}-${raw.id}`,
      title,
      company,
      company_slug: slug,
      location,
      country_code: countryCode,
      remote,
      remote_scope: remote ? 'remote' : 'onsite',
      remote_eligibility: detectRemoteEligibility(location, remote),
      job_type: detectJobType(title, raw.categories?.commitment || ''),
      seniority: detectSeniority(title),
      description,
      apply_url: applyUrl,
      source_url: `https://jobs.lever.co/${slug}`,
      salary_text: salaryText,
      salary_min: salaryMin,
      salary_max: salaryMax,
      currency,
      salary_period: salaryPeriod,
      category: detectCategory(title),
      posted_at: postedAt,
      discovered_at: nowIso,
      last_seen_at: nowIso,
      verified: true,
      is_active: true,
    };
  }

  // ---------------------------------------------------------------------------
  // ASHBY
  // ---------------------------------------------------------------------------
  if (ats === 'ashby') {
    if (!raw.title) return null;
    const applyUrl = String(raw.jobUrl || raw.applyUrl || '').trim();
    if (!isValidApplyUrl(applyUrl)) return null;

    const title = cleanText(raw.title);
    if (!title) return null;

    const location = cleanText(raw.location || 'Unspecified');
    const remote = detectRemote(title, location, raw.isRemote);
    const countryCode = detectCountryCode(location);
    const rawDesc = raw.descriptionPlain || raw.descriptionHtml;
    const description = cleanAndTruncateDescription(rawDesc, 4000);

    const postedAt = raw.publishedAt || raw.createdAt || nowIso;

    // Structured compensation extraction from Ashby compensation block
    let salaryText: string | null = null;
    let salaryMin: number | null = null;
    let salaryMax: number | null = null;
    let currency = 'USD';
    let salaryPeriod: 'yearly' | 'monthly' | 'hourly' | undefined = undefined;

    if (raw.compensation && typeof raw.compensation === 'object') {
      const comp = raw.compensation;
      const tier = Array.isArray(comp.compensationTiers) && comp.compensationTiers[0];
      const components = tier?.components || comp.summaryComponents || [];
      const salaryComp = components.find(
        (c: any) =>
          c &&
          (c.compensationType === 'Salary' ||
            (c.minValue != null && c.minValue > 0) ||
            (c.maxValue != null && c.maxValue > 0))
      );

      if (salaryComp) {
        salaryMin = salaryComp.minValue ?? null;
        salaryMax = salaryComp.maxValue ?? null;
        if (salaryComp.currencyCode) currency = String(salaryComp.currencyCode).toUpperCase();
        const interval = salaryComp.interval ? String(salaryComp.interval).toLowerCase() : '';
        if (interval.includes('hour')) salaryPeriod = 'hourly';
        else if (interval.includes('month')) salaryPeriod = 'monthly';
        else if (interval.includes('year')) salaryPeriod = 'yearly';
        salaryText = formatSalary(salaryMin, salaryMax, currency, salaryPeriod);
      } else if (comp.scrapeableCompensationSalarySummary) {
        salaryText = comp.scrapeableCompensationSalarySummary;
      }
    }

    if (!salaryText && salaryMin == null && salaryMax == null) {
      const fallback = parseSalary(description, { title, location });
      salaryText = fallback.salary_text;
      salaryMin = fallback.salary_min;
      salaryMax = fallback.salary_max;
      currency = fallback.currency;
      salaryPeriod = fallback.salary_period;
    }

    return {
      source: 'ashby',
      source_type: 'ats',
      source_job_id: `${slug}-${raw.id}`,
      title,
      company,
      company_slug: slug,
      location,
      country_code: countryCode,
      remote,
      remote_scope: remote ? 'remote' : 'onsite',
      remote_eligibility: detectRemoteEligibility(location, remote),
      job_type: detectJobType(title),
      seniority: detectSeniority(title),
      description,
      apply_url: applyUrl,
      source_url: `https://jobs.ashbyhq.com/${slug}`,
      salary_text: salaryText,
      salary_min: salaryMin,
      salary_max: salaryMax,
      currency,
      salary_period: salaryPeriod,
      category: detectCategory(title),
      posted_at: postedAt,
      discovered_at: nowIso,
      last_seen_at: nowIso,
      verified: true,
      is_active: true,
    };
  }

  return null;
}

/**
 * Deduplicates jobs across ATS identifiers, employer apply URLs, and normalized content roles.
 */
export function dedupJobs(
  jobs: NormalizedJob[],
  existingSeenUrls?: Set<string>,
  existingSeenRoles?: Set<string>
): {
  accepted: NormalizedJob[];
  duplicates: number;
} {
  const seenUrls = existingSeenUrls || new Set<string>();
  const seenRoles = existingSeenRoles || new Set<string>();
  const seenAtsIds = new Set<string>();
  const accepted: NormalizedJob[] = [];
  let duplicates = 0;

  for (const job of jobs) {
    if (!job || !job.apply_url || !job.title || !job.company) {
      duplicates++;
      continue;
    }

    // 1. Stable ATS ID key
    const atsKey = `${job.source}:${job.source_job_id}`;
    if (seenAtsIds.has(atsKey)) {
      duplicates++;
      continue;
    }

    // 2. Strict apply URL deduplication
    if (seenUrls.has(job.apply_url)) {
      duplicates++;
      continue;
    }

    // 3. Cross-source / duplicate role key: normalized company + title + location
    const roleKey = `${slugify(job.company)}::${slugify(job.title)}::${slugify(job.location || 'unspecified')}`;
    if (seenRoles.has(roleKey)) {
      duplicates++;
      continue;
    }

    seenAtsIds.add(atsKey);
    seenUrls.add(job.apply_url);
    seenRoles.add(roleKey);
    accepted.push(job);
  }

  return { accepted, duplicates };
}

/**
 * Closed-job handling:
 *
 * Rules:
 * 1. Count a miss ONLY after a successful non-empty fetch for that specific company board.
 *    If the API failed or returned 0 jobs (transient outage, rate limit), skip miss counting.
 * 2. Scope strictly by source + company_slug:
 *    Only evaluate jobs matching existing.source === ats && existing.company_slug === slug.
 * 3. Reconciled with cleanup.ts:
 *    - Re-seen active jobs: consecutive_misses reset to 0, status='active', is_active=true.
 *    - 1 miss: consecutive_misses=1, remains active (grace period).
 *    - 2 consecutive misses: consecutive_misses=2, is_active=false, status='inactive'.
 *    - Jobs are NEVER deleted here. Inactive jobs are permanently deleted by cleanup.ts
 *      only after 14 days of being unseen (last_seen_at < 14d).
 *    - Active jobs posted > 45 days ago will also be naturally expired by cleanup.ts.
 */
export function handleClosedJobs(
  existingJobsForCompany: ClosedJobRecord[],
  freshFetchedJobIds: Set<string>,
  context: {
    source: 'greenhouse' | 'lever' | 'ashby';
    company_slug: string;
    fetchSucceeded: boolean;
  }
): ClosedJobDecision[] {
  // If fetch failed or returned 0 jobs, do NOT penalize with a miss (defend against transient outages)
  if (!context.fetchSucceeded || freshFetchedJobIds.size === 0) {
    return [];
  }

  // Filter existing jobs strictly by source and company_slug
  const targetJobs = existingJobsForCompany.filter(
    (j) => j.source === context.source && j.company_slug === context.company_slug
  );

  const decisions: ClosedJobDecision[] = [];

  for (const existing of targetJobs) {
    const isPresent = freshFetchedJobIds.has(existing.source_job_id);

    if (isPresent) {
      // Re-verified active on board
      decisions.push({
        id: existing.id,
        source: existing.source,
        company_slug: existing.company_slug,
        source_job_id: existing.source_job_id,
        consecutive_misses: 0,
        is_active: true,
        status: 'active',
        action: 'reset_active',
      });
    } else {
      // Vanished from current successful non-empty board fetch
      const updatedMisses = (existing.consecutive_misses || 0) + 1;
      const shouldDeactivate = updatedMisses >= 2;

      decisions.push({
        id: existing.id,
        source: existing.source,
        company_slug: existing.company_slug,
        source_job_id: existing.source_job_id,
        consecutive_misses: updatedMisses,
        is_active: !shouldDeactivate,
        status: shouldDeactivate ? 'inactive' : (existing.status || 'active'),
        action: shouldDeactivate ? 'marked_inactive' : 'kept_active',
      });
    }
  }

  return decisions;
}

/**
 * Executes Board Ingestion across Greenhouse, Lever, and Ashby.
 * In dry-run mode, fetches live API data or fixtures, runs through the ONE canonical
 * normalizer (normalizeAtsJob), and prints structured summary statistics without DB mutations.
 */
export async function runBoardIngestion(options: IngestionOptions = {}): Promise<BoardIngestionStats> {
  const {
    dryRun = true,
    limit,
    offset = 0,
    atsFilter = 'all',
    companyFilter,
    configPath,
    fixtureMode = false,
    fixtureDir,
  } = options;

  console.log('\n======================================================');
  console.log('🚀 CareerMonke ATS Board Ingestion (Greenhouse, Lever, Ashby)');
  console.log('======================================================');
  console.log(`Execution Mode: ${dryRun ? 'DRY RUN (Safe - No Writes)' : 'PRODUCTION'}`);
  console.log(`Rate Pacing:    1 req/s per host (MIN_DOMAIN_INTERVAL_MS = 1000)`);
  console.log(`ATS Filter:     ${atsFilter}`);
  if (companyFilter) console.log(`Company Filter: ${companyFilter}`);

  const registry = loadCompanyRegistry(configPath);
  let targets = registry.filter((entry) => {
    if (atsFilter !== 'all' && entry.ats !== atsFilter) return false;
    if (companyFilter && !entry.company.toLowerCase().includes(companyFilter.toLowerCase())) return false;
    return true;
  });

  const tokensPerAts: Record<string, number> = { greenhouse: 0, lever: 0, ashby: 0 };
  for (const t of registry) {
    tokensPerAts[t.ats] = (tokensPerAts[t.ats] || 0) + 1;
  }

  if (offset > 0 || (limit && limit > 0)) {
    if (limit && atsFilter === 'all' && !companyFilter) {
      // Balanced sample across Greenhouse, Lever, and Ashby
      const perAts = Math.max(1, Math.floor(limit / 3));
      const gh = targets.filter((t) => t.ats === 'greenhouse').slice(0, perAts);
      const lv = targets.filter((t) => t.ats === 'lever').slice(0, perAts);
      const as = targets.filter((t) => t.ats === 'ashby').slice(0, limit - gh.length - lv.length);
      targets = [...gh, ...lv, ...as];
    } else {
      targets = targets.slice(offset, limit ? offset + limit : undefined);
    }
  }

  console.log(`Processing ${targets.length} target company boards...\n`);

  const stats: BoardIngestionStats = {
    verifiedTokensTotal: registry.length,
    tokensPerAts,
    companiesAttempted: targets.length,
    companiesSucceeded: 0,
    companiesFailed: 0,
    totalJobsFetched: 0,
    totalJobsAccepted: 0,
    totalJobsDeduplicated: 0,
    indiaCount: 0,
    remoteCount: 0,
    nonTechCount: 0,
    countryBreakdown: {},
    topCompanies: [],
    errors: [],
  };

  const seenUrls = new Set<string>();
  const seenRoles = new Set<string>();

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const prefix = `[${i + 1}/${targets.length}] [${target.ats.toUpperCase()}] ${target.company}`;

    try {
      let rawItems: any[] = [];
      let fetchSucceeded = false;

      if (fixtureMode && fixtureDir) {
        // Load fixture files for test suite isolation
        const fixturePath = path.resolve(fixtureDir, `${target.ats}-response.json`);
        if (fs.existsSync(fixturePath)) {
          const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
          if (target.ats === 'greenhouse') {
            rawItems = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];
          } else if (target.ats === 'lever') {
            rawItems = Array.isArray(rawFixture) ? rawFixture : [];
          } else if (target.ats === 'ashby') {
            rawItems = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];
          }
          fetchSucceeded = true;
        }
      } else {
        // Real run: fetch raw JSON from authorized public endpoint
        const fetchResult = await fetchRawAtsJobs(target.ats, target.token);
        rawItems = fetchResult.rawJobs;
        fetchSucceeded = fetchResult.fetchSucceeded;
      }

      stats.totalJobsFetched += rawItems.length;

      // ONE NORMALIZER: Route every item through normalizeAtsJob
      const normalizedJobs: NormalizedJob[] = [];
      for (const item of rawItems) {
        const job = normalizeAtsJob(item, target.ats, target.company, target.token);
        if (job) {
          normalizedJobs.push(job);
        }
      }

      const { accepted, duplicates } = dedupJobs(normalizedJobs, seenUrls, seenRoles);
      stats.totalJobsDeduplicated += duplicates;
      stats.totalJobsAccepted += accepted.length;
      if (fetchSucceeded) {
        stats.companiesSucceeded++;
      } else {
        stats.companiesFailed++;
      }

      for (const job of accepted) {
        const isIndia = job.country_code === 'IN' || (job.location && /india/i.test(job.location));
        if (isIndia) stats.indiaCount++;
        if (job.remote) stats.remoteCount++;

        const category = job.category || 'other';
        const isNonTech = category !== 'engineering' && category !== 'data';
        if (isNonTech) stats.nonTechCount++;

        const countryKey = job.country_code || (job.remote ? 'REMOTE' : 'UNKNOWN');
        stats.countryBreakdown[countryKey] = (stats.countryBreakdown[countryKey] || 0) + 1;
      }

      stats.topCompanies.push({
        company: target.company,
        ats: target.ats,
        jobs: accepted.length,
      });

      console.log(`   ${prefix}: ${accepted.length} accepted (${duplicates} deduped, ${rawItems.length} raw)`);
    } catch (err: any) {
      stats.companiesFailed++;
      stats.errors.push({
        company: target.company,
        ats: target.ats,
        error: err.message,
      });
      console.warn(`   ⚠️ ${prefix} failed: ${err.message}`);
    }
  }

  // Sort top companies by job count descending
  stats.topCompanies.sort((a, b) => b.jobs - a.jobs);

  // Print Dry-Run Summary Report
  console.log('\n======================================================');
  console.log('📊 DRY-RUN INGESTION SUMMARY REPORT');
  console.log('======================================================');
  console.log(`Verified Tokens Total: ${stats.verifiedTokensTotal}`);
  console.log(`Tokens per ATS:`);
  console.log(`  - Greenhouse: ${stats.tokensPerAts.greenhouse || 0}`);
  console.log(`  - Lever:      ${stats.tokensPerAts.lever || 0}`);
  console.log(`  - Ashby:      ${stats.tokensPerAts.ashby || 0}`);
  console.log(`Boards Processed:      ${stats.companiesAttempted} (${stats.companiesSucceeded} ok, ${stats.companiesFailed} err)`);
  console.log(`Total Jobs Fetched:    ${stats.totalJobsFetched}`);
  console.log(`Total Jobs Accepted:   ${stats.totalJobsAccepted}`);
  console.log(`Duplicates Dropped:    ${stats.totalJobsDeduplicated}`);
  console.log(`India Jobs:            ${stats.indiaCount}`);
  console.log(`Remote Jobs:           ${stats.remoteCount}`);
  console.log(`Non-Tech Jobs:         ${stats.nonTechCount}`);
  console.log('======================================================\n');

  return stats;
}

// Direct CLI invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const isDryRun = !args.includes('--live-write-unlocked');

  if (!isDryRun) {
    console.error('❌ LIVE PRODUCTION WRITE LOCKED: This task strictly enforces Dry-Run mode only.');
    process.exit(1);
  }

  const atsIdx = args.findIndex((a) => a === '--ats');
  const atsFilter = atsIdx !== -1 ? (args[atsIdx + 1] as any) : 'all';

  const compIdx = args.findIndex((a) => a === '--company');
  const companyFilter = compIdx !== -1 ? args[compIdx + 1] : undefined;

  const limitIdx = args.findIndex((a) => a === '--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  runBoardIngestion({ dryRun: true, atsFilter, companyFilter, limit })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal Ingestion Error:', err);
      process.exit(1);
    });
}
