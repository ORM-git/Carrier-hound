/**
 * scripts/board-ingest.ts
 *
 * Automated Company Board Ingestion for Greenhouse, Lever, Ashby, and all supported ATS platforms.
 *
 * Operational Locks:
 * - Legal documented public endpoints only:
 *     Greenhouse: boards-api.greenhouse.io/v1/boards/<company>/jobs
 *     Lever: api.lever.co/v0/postings/<company>
 *     Ashby: api.ashbyhq.com/posting-api/job-board/<company>
 *     Workable: apply.workable.com/api/v1/widget/accounts/<company>
 *     SmartRecruiters: api.smartrecruiters.com/v1/companies/<company>/postings
 *     Recruitee: <company>.recruitee.com/api/offers/
 *     Breezy: <company>.breezy.hr/json
 *     Teamtailor: <company>.teamtailor.com/jobs.rss
 *     Personio: <company>.jobs.personio.de/xml
 *     BambooHR: <company>.bamboohr.com/careers/list
 *     Join: join.com/api/companies/<company>
 * - No scraping of HTML career pages, no login, no captcha bypass.
 * - Explicitly banned scrapable domains: LinkedIn, Indeed, Naukri, Glassdoor, Jobright, Workday.
 * - Employer text is never misrepresented; real apply URLs & company names preserved.
 * - Rate limit: Strictly 1 req/s per host / registrable domain.
 * - Descriptions truncated to 1500 chars, plain text only. apply_url https-only.
 * - Dedup against existing rows (company+title+location) before insert.
 * - Live-write mode: OFF by default. Requires explicit --live-write AND --confirm-prod-write.
 *   Credentials read from local env only; never logged, never in CI/workflows (workflows stay dry-run only).
 * - Safety controls: --max-jobs N, batches of 500, --boards N, --dry-plan, abort if estimated DB growth > 150 MB without --allow-large.
 * - Writes go through standard upsert (onConflict: 'source,source_job_id', set last_seen_at).
 *   No new tables/columns, do NOT depend on consecutive_misses migration. Skip closed-job logic in live-write.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { NormalizedJob, SourceConfig, SourceType } from './types';
import { getAdapter } from './adapters';
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
import { politeFetchJson, politeFetchText, isForbiddenDomain } from './utils/polite-fetch';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load local environment safely without printing secrets
dotenv.config();
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

// ISO alpha-2 -> display name for the legacy country text column
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', IN: 'India', GB: 'United Kingdom', CA: 'Canada', DE: 'Germany',
  SG: 'Singapore', AU: 'Australia', FR: 'France', NL: 'Netherlands', IE: 'Ireland',
  JP: 'Japan', BR: 'Brazil', CH: 'Switzerland', SE: 'Sweden', ES: 'Spain', IT: 'Italy',
  PL: 'Poland', MX: 'Mexico', IL: 'Israel', AE: 'United Arab Emirates', AT: 'Austria',
  DK: 'Denmark', NO: 'Norway', FI: 'Finland', NZ: 'New Zealand', PT: 'Portugal', PH: 'Philippines',
};

export interface CompanyRegistryEntry {
  id?: string;
  company: string;
  name?: string;
  ats:
    | 'greenhouse'
    | 'lever'
    | 'ashby'
    | 'workable'
    | 'smartrecruiters'
    | 'recruitee'
    | 'breezy'
    | 'teamtailor'
    | 'personio'
    | 'bamboohr'
    | 'join'
    | string;
  type?: string;
  token: string;
  target?: string;
  country_hint?: string;
  job_count?: number;
  india_job_count?: number;
  remote_job_count?: number;
  verified_at?: string;
  discovery_source?: string;
  enabled?: boolean;
}

export interface IngestManifestRow {
  source: string;
  source_job_id: string;
}

export interface IngestManifest {
  run_discovered_at: string;
  generated_at: string;
  total_rows: number;
  rows: IngestManifestRow[];
}

export interface IngestionOptions {
  dryRun?: boolean;
  liveWrite?: boolean;
  confirmProdWrite?: boolean;
  dryPlan?: boolean;
  allowLarge?: boolean;
  allowUpdates?: boolean;
  manifestPath?: string;
  maxJobs?: number;
  batchSize?: number;
  boardsLimit?: number;
  limit?: number;
  offset?: number;
  atsFilter?: string;
  companyFilter?: string;
  inputPath?: string;
  configPath?: string;
  fixtureMode?: boolean;
  fixtureDir?: string;
  supabaseClient?: any;
  expectHost?: string;
  skipExistingRegistry?: boolean;
}

export interface ClosedJobRecord {
  id: string;
  source: 'greenhouse' | 'lever' | 'ashby' | string;
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
  source: 'greenhouse' | 'lever' | 'ashby' | string;
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
  planStats?: {
    totalAccepted: number;
    rowsToInsert: number;
    rowsToUpdate: number;
    updatesSkipped?: number;
    dedupSkipped: number;
    estimatedGrowthMB: number;
  };
  liveWriteStats?: {
    rowsWritten: number;
    rowsInserted: number;
    rowsUpdated: number;
    updatesSkipped: number;
    confirmedCount: number;
    batchesCount: number;
    discoveredAt: string;
    manifestPath?: string;
    rollbackSql?: string;
  };
}

/**
 * Generates the idempotent rollback SQL statement for deleting exclusively the rows
 * inserted in a specific ingestion run, matching both discovered_at and the exact
 * (source, source_job_id) composite pairs.
 *
 * Never executed automatically; printed for manual audit and verification.
 */
export function generateRollbackSql(
  rows: Array<{ source: string; source_job_id: string }>,
  discoveredAt: string
): string {
  if (rows.length === 0) {
    return `-- No rows to rollback for discovered_at = '${discoveredAt}'\n`;
  }

  const tupleValues = rows
    .map((r) => `  ('${r.source.replace(/'/g, "''")}', '${r.source_job_id.replace(/'/g, "''")}')`)
    .join(',\n');

  return [
    `-- ==============================================================================`,
    `-- ROLLBACK SQL (DO NOT RUN AUTOMATICALLY - MANUAL VERIFICATION ONLY)`,
    `-- Target: DELETE rows inserted in run discovered_at = '${discoveredAt}'`,
    `-- Total Keys: ${rows.length}`,
    `-- ==============================================================================`,
    `DELETE FROM jobs`,
    `WHERE discovered_at = '${discoveredAt}'`,
    `  AND (source, source_job_id) IN (`,
    tupleValues,
    `  );`,
    `-- ==============================================================================`,
  ].join('\n');
}

/**
 * Initializes Supabase Client safely from local environment only.
 * Tokens and keys are strictly masked and never logged.
 */
export function getSupabaseClient(
  customUrl?: string,
  customKey?: string,
  expectHost?: string
): SupabaseClient | null {
  const supabaseUrl = customUrl || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = customKey || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return null;
  }

  let targetHost = '';
  try {
    const parsed = new URL(supabaseUrl);
    targetHost = parsed.host;
    console.log(`🔌 [Live-Write] Target Supabase host: ${targetHost}`);
  } catch {
    console.error('❌ [Live-Write] Invalid Supabase URL in local environment.');
    if (expectHost) {
      throw new Error(`HOST MISMATCH ABORT: Invalid Supabase URL, cannot verify expected host "${expectHost}".`);
    }
    return null;
  }

  if (expectHost && targetHost !== expectHost) {
    const errMsg = `HOST MISMATCH ABORT: Expected host "${expectHost}" does not match target host "${targetHost}".`;
    console.error(`❌ ${errMsg}`);
    throw new Error(errMsg);
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Loads verified boards from data/ats-candidates.json (output of board-verify-all.ts).
 * Only boards with verified status and >= 1 active job are selected.
 */
export function loadVerifiedBoards(customPath?: string): CompanyRegistryEntry[] {
  const candidatesPath = customPath
    ? path.resolve(customPath)
    : path.resolve(__dirname, '../data/ats-candidates.json');

  if (fs.existsSync(candidatesPath)) {
    try {
      const raw = fs.readFileSync(candidatesPath, 'utf-8');
      const items: CompanyRegistryEntry[] = JSON.parse(raw);
      const valid = items.filter(
        (item) => item && (item.job_count == null || item.job_count >= 1) && item.enabled !== false
      );
      if (valid.length > 0) return valid;
    } catch {
      // Fallback if candidates file cannot be read
    }
  }

  // Fallback to registry if candidates file is missing
  return loadCompanyRegistry();
}

/**
 * Loads company-token registry from disk (data/ats-company-registry.json).
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
export function buildAtsApiUrl(
  ats:
    | 'greenhouse'
    | 'lever'
    | 'ashby'
    | 'workable'
    | 'smartrecruiters'
    | 'recruitee'
    | 'breezy'
    | 'teamtailor'
    | 'personio'
    | 'bamboohr'
    | 'join'
    | string,
  token: string
): string {
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
  if (ats === 'workable') {
    return `https://apply.workable.com/api/v1/widget/accounts/${cleanToken}`;
  }
  if (ats === 'smartrecruiters') {
    return `https://api.smartrecruiters.com/v1/companies/${cleanToken}/postings`;
  }
  if (ats === 'recruitee') {
    return `https://${cleanToken}.recruitee.com/api/offers/`;
  }
  if (ats === 'breezy') {
    return `https://${cleanToken}.breezy.hr/json`;
  }
  if (ats === 'teamtailor') {
    return `https://${cleanToken}.teamtailor.com/jobs.rss`;
  }
  if (ats === 'personio') {
    return `https://${cleanToken}.jobs.personio.de/xml`;
  }
  if (ats === 'bamboohr') {
    return `https://${cleanToken}.bamboohr.com/careers/list`;
  }
  if (ats === 'join') {
    return `https://join.com/api/companies/${cleanToken}`;
  }
  throw new Error(`Unsupported ATS type: ${ats}`);
}

/**
 * Evaluates whether an ATS request URL is authorized and adheres to public API locks.
 * Strictly verifies https protocol, exact authorized hostnames, and rejects forbidden scrapable domains.
 */
export function isAuthorizedAtsUrl(url: string, ats: string): boolean {
  if (!url || typeof url !== 'string') return false;
  if (isForbiddenDomain(url)) return false;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;

    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname;

    if (ats === 'greenhouse') {
      return host === 'boards-api.greenhouse.io' && pathname.startsWith('/v1/boards/');
    }
    if (ats === 'lever') {
      return host === 'api.lever.co' && pathname.startsWith('/v0/postings/');
    }
    if (ats === 'ashby') {
      return host === 'api.ashbyhq.com' && pathname.startsWith('/posting-api/job-board/');
    }
    if (ats === 'workable') {
      return host === 'apply.workable.com' && pathname.startsWith('/api/');
    }
    if (ats === 'smartrecruiters') {
      return host === 'api.smartrecruiters.com' && pathname.startsWith('/v1/companies/');
    }
    if (ats === 'recruitee') {
      return /^[a-z0-9_-]+\.recruitee\.com$/.test(host) && pathname.startsWith('/api/offers');
    }
    if (ats === 'breezy') {
      return /^[a-z0-9_-]+\.breezy\.hr$/.test(host) && pathname.startsWith('/json');
    }
    if (ats === 'teamtailor') {
      return /^[a-z0-9_-]+\.teamtailor\.com$/.test(host) && pathname.startsWith('/jobs');
    }
    if (ats === 'personio') {
      return /^[a-z0-9_-]+(\.[a-z0-9_-]+)?\.personio\.(de|com)$/.test(host) && pathname.startsWith('/xml');
    }
    if (ats === 'bamboohr') {
      return /^[a-z0-9_-]+\.bamboohr\.com$/.test(host) && pathname.startsWith('/careers/');
    }
    if (ats === 'join') {
      return (
        (host === 'join.com' || host === 'www.join.com' || /^[a-z0-9_-]+\.join\.com$/.test(host)) &&
        (pathname.startsWith('/api/') || pathname.startsWith('/companies/'))
      );
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
  ats: string,
  token: string
): Promise<{ rawJobs: any[]; fetchSucceeded: boolean }> {
  const url = buildAtsApiUrl(ats, token);

  if (!isAuthorizedAtsUrl(url, ats)) {
    throw new Error(`Unauthorized or forbidden ATS request URL: ${url}`);
  }

  if (ats === 'teamtailor' || ats === 'personio') {
    const text = await politeFetchText(url);
    if (!text) return { rawJobs: [], fetchSucceeded: false };
    return { rawJobs: [text], fetchSucceeded: true };
  }

  const data = await politeFetchJson<any>(url);
  if (!data) {
    return { rawJobs: [], fetchSucceeded: false };
  }

  if (ats === 'greenhouse') {
    return { rawJobs: Array.isArray(data.jobs) ? data.jobs : [], fetchSucceeded: true };
  }
  if (ats === 'lever') {
    return { rawJobs: Array.isArray(data) ? data : [], fetchSucceeded: true };
  }
  if (ats === 'ashby') {
    return { rawJobs: Array.isArray(data.jobs) ? data.jobs : [], fetchSucceeded: true };
  }
  if (ats === 'workable') {
    return { rawJobs: Array.isArray(data.jobs) ? data.jobs : [], fetchSucceeded: true };
  }
  if (ats === 'smartrecruiters') {
    return { rawJobs: Array.isArray(data.content) ? data.content : [], fetchSucceeded: true };
  }
  if (ats === 'recruitee') {
    return { rawJobs: Array.isArray(data.offers) ? data.offers : [], fetchSucceeded: true };
  }
  if (ats === 'breezy') {
    return { rawJobs: Array.isArray(data) ? data : [], fetchSucceeded: true };
  }
  if (ats === 'bamboohr') {
    const list = Array.isArray(data.result) ? data.result : Array.isArray(data.jobs) ? data.jobs : Array.isArray(data) ? data : [];
    return { rawJobs: list, fetchSucceeded: true };
  }
  if (ats === 'join') {
    const list = Array.isArray(data.jobs) ? data.jobs : Array.isArray(data) ? data : [];
    return { rawJobs: list, fetchSucceeded: true };
  }

  return { rawJobs: [], fetchSucceeded: false };
}

/**
 * ONE CANONICAL NORMALIZER:
 * Normalizes an employer posting into the standardized CareerMonke jobs schema.
 *
 * Rules:
 * 1. Validates apply_url: must be https-only and non-forbidden host.
 * 2. Descriptions capped strictly at 1500 characters, plain text only (strip HTML).
 * 3. Sensible posted_at: Greenhouse updated_at is NOT a posting date.
 *    Uses first_published_at or created_at if present; falls back to discovery timestamp.
 * 4. Extracts structured compensation when available with fallback to sanitizing description.
 */
export function normalizeAtsJob(
  raw: any,
  ats: string,
  company: string,
  slug: string
): NormalizedJob | null {
  if (!raw || typeof raw !== 'object') return null;
  const nowIso = new Date().toISOString();

  // GREENHOUSE
  if (ats === 'greenhouse') {
    if (!raw.title || !raw.absolute_url) return null;
    const applyUrl = String(raw.absolute_url).trim();
    if (!isValidApplyUrl(applyUrl)) return null;

    const title = cleanText(raw.title);
    if (!title) return null;

    const location = cleanText(raw.location?.name || 'Unspecified');
    const remote = detectRemote(title, location);
    const countryCode = detectCountryCode(location);
    const description = cleanAndTruncateDescription(raw.content, 1500);
    const postedAt = raw.first_published_at || raw.created_at || null;

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
      const rawMin = validRange.min_cents != null && validRange.min_cents > 0 ? validRange.min_cents / 100 : null;
      const rawMax = validRange.max_cents != null && validRange.max_cents > 0 ? validRange.max_cents / 100 : null;
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
      source: ats.endsWith('-board') ? ats : `${ats}-board`,
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

  // LEVER
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
    const description = cleanAndTruncateDescription(rawDesc, 1500);
    const postedAt = raw.createdAt ? new Date(raw.createdAt).toISOString() : null;

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
      source: ats.endsWith('-board') ? ats : `${ats}-board`,
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

  // ASHBY
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
    const description = cleanAndTruncateDescription(rawDesc, 1500);
    const postedAt = raw.publishedAt || raw.createdAt || null;

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
      source: ats.endsWith('-board') ? ats : `${ats}-board`,
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
 * Closed-job handling (used during audit/fixture checks, skipped in live-write).
 */
export function handleClosedJobs(
  existingJobsForCompany: ClosedJobRecord[],
  freshFetchedJobIds: Set<string>,
  context: {
    source: 'greenhouse' | 'lever' | 'ashby' | string;
    company_slug: string;
    fetchSucceeded: boolean;
  }
): ClosedJobDecision[] {
  if (!context.fetchSucceeded || freshFetchedJobIds.size === 0) {
    return [];
  }

  const targetJobs = existingJobsForCompany.filter(
    (j) => j.source === context.source && j.company_slug === context.company_slug
  );

  const decisions: ClosedJobDecision[] = [];

  for (const existing of targetJobs) {
    const isPresent = freshFetchedJobIds.has(existing.source_job_id);

    if (isPresent) {
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
 * Executes Company Board Ingestion across all supported ATS platforms.
 *
 * Modes:
 * - Default: Safe Dry-Run (fetches, parses, dedups, prints audit summary).
 * - --dry-plan: Calculates insert vs update distribution and estimated DB growth in MB.
 *               Aborts if growth > 150 MB without --allow-large.
 * - --live-write: Requires explicit --confirm-prod-write. Writes to database via batches of 500.
 */
export async function runBoardIngestion(options: IngestionOptions = {}): Promise<BoardIngestionStats> {
  const {
    dryRun = true,
    liveWrite = false,
    confirmProdWrite = false,
    dryPlan = false,
    allowLarge = false,
    allowUpdates = false,
    manifestPath: customManifestPath,
    maxJobs,
    batchSize: customBatchSize,
    boardsLimit,
    limit,
    offset = 0,
    atsFilter = 'all',
    companyFilter,
    inputPath,
    configPath,
    fixtureMode = false,
    fixtureDir,
    supabaseClient,
    expectHost,
    skipExistingRegistry = true,
  } = options;

  const effectiveBoardsLimit = boardsLimit || limit;
  const isActualLiveWrite = liveWrite && !dryPlan;

  console.log('\n======================================================');
  console.log('🚀 CareerMonke ATS Board Ingestion Engine');
  console.log('======================================================');
  console.log(`Execution Mode: ${isActualLiveWrite ? '🔴 PRODUCTION LIVE-WRITE' : dryPlan ? '📋 DRY-PLAN' : '🟢 DRY-RUN (Safe)'}`);
  console.log(`Update Mode:    ${allowUpdates ? 'OPT-IN (Updates enabled)' : 'OFF (Insert-only: skipping existing rows, updates disabled)'}`);
  console.log(`Rate Pacing:    1 req/s per host (MIN_DOMAIN_INTERVAL_MS = 1000)`);
  console.log(`ATS Filter:     ${atsFilter}`);
  if (companyFilter) console.log(`Company Filter: ${companyFilter}`);
  if (maxJobs) console.log(`Max Jobs Cap:   ${maxJobs}`);
  if (effectiveBoardsLimit) console.log(`Boards Limit:   ${effectiveBoardsLimit}`);

  // Safety Gate: Live write requires explicit --confirm-prod-write, compulsory --max-jobs, and compulsory --expect-host
  if (liveWrite) {
    if (!confirmProdWrite) {
      throw new Error('LIVE PRODUCTION WRITE REFUSED: --live-write requires explicit --confirm-prod-write flag.');
    }
    if (!maxJobs || maxJobs <= 0) {
      throw new Error('LIVE PRODUCTION WRITE REFUSED: --max-jobs <N> is compulsory with --live-write (aborting).');
    }
    if (!expectHost || !expectHost.trim()) {
      throw new Error('LIVE PRODUCTION WRITE REFUSED: --expect-host <host> is compulsory with --live-write (aborting).');
    }
  }

  // Obtain Supabase Client if live write or dry-plan against DB is needed
  let supabase: SupabaseClient | null = null;
  if (isActualLiveWrite || (dryPlan && (process.env.SUPABASE_SERVICE_ROLE_KEY || supabaseClient))) {
    supabase = supabaseClient || getSupabaseClient(undefined, undefined, expectHost);
    if (isActualLiveWrite && !supabase) {
      throw new Error('LIVE PRODUCTION WRITE FAILED: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.');
    }

    if (expectHost && supabaseClient) {
      const clientUrl = supabaseClient._url || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
      let actualHost = '';
      try {
        if (clientUrl) actualHost = new URL(clientUrl).host;
      } catch {
        actualHost = '';
      }
      if (actualHost) {
        console.log(`🔌 [Live-Write] Target Supabase host: ${actualHost}`);
        if (actualHost !== expectHost) {
          throw new Error(`HOST MISMATCH ABORT: Expected host "${expectHost}" does not match target host "${actualHost}".`);
        }
      } else {
        throw new Error(`HOST MISMATCH ABORT: Unable to determine target host to verify against expected host "${expectHost}".`);
      }
    }
  }

  // Load target verified boards
  let targetBoards = loadVerifiedBoards(inputPath || configPath);

  // Load existing registry to ensure live-write never touches existing registry boards
  const registryEntries = loadCompanyRegistry();
  const existingRegistrySlugs = new Set<string>();
  for (const r of registryEntries) {
    if (r.token) existingRegistrySlugs.add(r.token.toLowerCase());
    if (r.target) existingRegistrySlugs.add(r.target.toLowerCase());
  }

  let skippedRegistryCount = 0;
  let targets = targetBoards.filter((entry) => {
    if (atsFilter !== 'all' && entry.ats !== atsFilter) return false;
    if (companyFilter && !entry.company?.toLowerCase().includes(companyFilter.toLowerCase())) return false;

    // Skip any board whose slug already exists in the existing registry
    if (skipExistingRegistry !== false) {
      const slug = (entry.token || '').toLowerCase();
      if (existingRegistrySlugs.has(slug)) {
        skippedRegistryCount++;
        return false;
      }
    }
    return true;
  });

  if (skippedRegistryCount > 0) {
    console.log(`🛡️ Skipped ${skippedRegistryCount} boards already present in existing registry.`);
  }

  const tokensPerAts: Record<string, number> = {};
  for (const t of targetBoards) {
    tokensPerAts[t.ats] = (tokensPerAts[t.ats] || 0) + 1;
  }

  if (offset > 0 || (effectiveBoardsLimit && effectiveBoardsLimit > 0)) {
    targets = targets.slice(offset, effectiveBoardsLimit ? offset + effectiveBoardsLimit : undefined);
  }

  console.log(`Processing ${targets.length} target verified boards...\n`);

  const stats: BoardIngestionStats = {
    verifiedTokensTotal: targetBoards.length,
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
  const allAcceptedJobs: NormalizedJob[] = [];

  for (let i = 0; i < targets.length; i++) {
    // Check max-jobs cap
    if (maxJobs && maxJobs > 0 && allAcceptedJobs.length >= maxJobs) {
      console.log(`🛑 Reached max-jobs cap (${maxJobs}). Halting further board fetches.`);
      break;
    }

    const target = targets[i];
    const prefix = `[${i + 1}/${targets.length}] [${target.ats.toUpperCase()}] ${target.company || target.token}`;

    try {
      let acceptedForCompany: NormalizedJob[] = [];
      let rawCount = 0;
      let duplicates = 0;
      let fetchSucceeded = false;

      if (fixtureMode && fixtureDir) {
        // Test suite fixture mode
        const fixturePath = path.resolve(fixtureDir, `${target.ats}-response.json`);
        if (fs.existsSync(fixturePath)) {
          const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
          let rawItems: any[] = [];
          if (target.ats === 'greenhouse') rawItems = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];
          else if (target.ats === 'lever') rawItems = Array.isArray(rawFixture) ? rawFixture : [];
          else if (target.ats === 'ashby') rawItems = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];

          rawCount = rawItems.length;
          const normalized = rawItems
            .map((item) => normalizeAtsJob(item, target.ats, target.company || target.token, target.token))
            .filter((j): j is NormalizedJob => j !== null);

          const dedupRes = dedupJobs(normalized, seenUrls, seenRoles);
          acceptedForCompany = dedupRes.accepted;
          duplicates = dedupRes.duplicates;
          fetchSucceeded = true;
        }
      } else {
        // Adapter-driven ingestion for all 11 ATS platforms
        const adapter = getAdapter(target.ats as SourceType);
        if (adapter) {
          const sourceConfig: SourceConfig = {
            id: target.token,
            name: target.company || target.token,
            type: target.ats as SourceType,
            target: target.token,
            enabled: true,
          };

          const rawFetchedJobs = await adapter.fetchJobs(sourceConfig);
          rawCount = rawFetchedJobs.length;

          // Re-normalize descriptions <= 1500 chars text-only and validate apply_url https
          const sanitizedJobs = rawFetchedJobs
            .filter((j) => j && j.title && isValidApplyUrl(j.apply_url))
            .map((j): NormalizedJob => ({
              ...j,
              source: target.ats.endsWith('-board') ? target.ats : `${target.ats}-board`,
              source_type: 'ats',
              company_slug: target.token,
              description: cleanAndTruncateDescription(j.description, 1500),
              last_seen_at: new Date().toISOString(),
              is_active: true,
              verified: true,
            }));

          const dedupRes = dedupJobs(sanitizedJobs, seenUrls, seenRoles);
          acceptedForCompany = dedupRes.accepted;
          duplicates = dedupRes.duplicates;
          fetchSucceeded = true;
        } else {
          // Fallback to fetchRawAtsJobs + normalizeAtsJob
          const fetchResult = await fetchRawAtsJobs(target.ats, target.token);
          rawCount = fetchResult.rawJobs.length;
          fetchSucceeded = fetchResult.fetchSucceeded;

          const normalized = fetchResult.rawJobs
            .map((item) => normalizeAtsJob(item, target.ats, target.company || target.token, target.token))
            .filter((j): j is NormalizedJob => j !== null);

          const dedupRes = dedupJobs(normalized, seenUrls, seenRoles);
          acceptedForCompany = dedupRes.accepted;
          duplicates = dedupRes.duplicates;
        }
      }

      stats.totalJobsFetched += rawCount;
      stats.totalJobsDeduplicated += duplicates;

      // Honor maxJobs cap within current board batch
      if (maxJobs && maxJobs > 0 && allAcceptedJobs.length + acceptedForCompany.length > maxJobs) {
        const remaining = maxJobs - allAcceptedJobs.length;
        acceptedForCompany = acceptedForCompany.slice(0, remaining);
      }

      stats.totalJobsAccepted += acceptedForCompany.length;
      allAcceptedJobs.push(...acceptedForCompany);

      if (fetchSucceeded) {
        stats.companiesSucceeded++;
      } else {
        stats.companiesFailed++;
      }

      for (const job of acceptedForCompany) {
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
        company: target.company || target.token,
        ats: target.ats,
        jobs: acceptedForCompany.length,
      });

      console.log(`   ${prefix}: ${acceptedForCompany.length} accepted (${duplicates} deduped, ${rawCount} raw)`);
    } catch (err: any) {
      stats.companiesFailed++;
      stats.errors.push({
        company: target.company || target.token,
        ats: target.ats,
        error: err.message,
      });
      console.warn(`   ⚠️ ${prefix} failed: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Database Cross-Check & Planning (Dry-Plan / Live-Write)
  // ---------------------------------------------------------------------------
  let rowsToInsert: NormalizedJob[] = [];
  let rowsToUpdate: NormalizedJob[] = [];
  let dedupSkipped = 0;
  const nowIso = new Date().toISOString();
  const runDiscoveredAt = nowIso;

  if (supabase && allAcceptedJobs.length > 0) {
    const uniqueCompanyNames = Array.from(new Set(allAcceptedJobs.map((j) => j.company)));
    const existingDbRoles = new Set<string>();
    const existingDbSourceIds = new Set<string>();

    // Chunk company lookups in groups of 50 to avoid query size limits
    const compChunkSize = 50;
    const existingDbJobsMap = new Map<string, { posted_at?: string | null; discovered_at?: string | null }>();

    for (let i = 0; i < uniqueCompanyNames.length; i += compChunkSize) {
      const compSlice = uniqueCompanyNames.slice(i, i + compChunkSize);
      const { data: dbRows, error: dbErr } = await supabase
        .from('jobs')
        .select('id, company, title, location, source, source_job_id, apply_url, posted_at, discovered_at')
        .in('company', compSlice);

      if (!dbErr && Array.isArray(dbRows)) {
        for (const row of dbRows) {
          const roleKey = `${slugify(row.company)}::${slugify(row.title)}::${slugify(row.location || 'unspecified')}`;
          existingDbRoles.add(roleKey);
          const sourceIdKey = `${row.source}:${row.source_job_id}`;
          existingDbSourceIds.add(sourceIdKey);
          existingDbJobsMap.set(sourceIdKey, {
            posted_at: row.posted_at || null,
            discovered_at: row.discovered_at || null,
          });
        }
      }
    }

    const seenLocalRoles = new Set<string>();

    for (const job of allAcceptedJobs) {
      const sourceIdKey = `${job.source}:${job.source_job_id}`;
      const roleKey = `${slugify(job.company)}::${slugify(job.title)}::${slugify(job.location || 'unspecified')}`;

      if (existingDbSourceIds.has(sourceIdKey)) {
        // Exists with identical source + source_job_id -> UPDATE
        // Never overwrite existing posted_at or discovered_at
        const existingMeta = existingDbJobsMap.get(sourceIdKey);
        const updatedJob: NormalizedJob = {
          ...job,
          posted_at: existingMeta?.posted_at ?? (job.posted_at || null),
          discovered_at: existingMeta?.discovered_at ?? undefined,
          last_seen_at: nowIso,
        };
        rowsToUpdate.push(updatedJob);
      } else if (existingDbRoles.has(roleKey) || seenLocalRoles.has(roleKey)) {
        // Role (company + title + location) already exists under different ID -> DEDUP SKIP
        dedupSkipped++;
      } else {
        // Brand new job -> INSERT
        // discovered_at only set on insert to runDiscoveredAt
        const newJob: NormalizedJob = {
          ...job,
          posted_at: job.posted_at || null,
          discovered_at: runDiscoveredAt,
          last_seen_at: nowIso,
        };
        rowsToInsert.push(newJob);
        seenLocalRoles.add(roleKey);
      }
    }
  } else {
    // In offline dry-run without DB client: treat accepted jobs as new
    rowsToInsert = allAcceptedJobs.map((j) => ({
      ...j,
      discovered_at: runDiscoveredAt,
      last_seen_at: nowIso,
    }));
  }

  // Safety sizing calculations (conservative 4096 bytes per new row including indexes)
  const ESTIMATED_BYTES_PER_ROW = 4096;
  const estimatedGrowthBytes = rowsToInsert.length * ESTIMATED_BYTES_PER_ROW;
  const estimatedGrowthMB = estimatedGrowthBytes / (1024 * 1024);

  stats.planStats = {
    totalAccepted: allAcceptedJobs.length,
    rowsToInsert: rowsToInsert.length,
    rowsToUpdate: rowsToUpdate.length,
    updatesSkipped: allowUpdates ? 0 : rowsToUpdate.length,
    dedupSkipped,
    estimatedGrowthMB: Math.round(estimatedGrowthMB * 100) / 100,
  };

  // Print Dry-Plan Summary Report
  console.log('\n======================================================');
  console.log('📋 INGESTION PLAN (DRY-PLAN & SAFETY SIZING)');
  console.log('======================================================');
  console.log(`Target Boards Processed:    ${targets.length}`);
  console.log(`Total Jobs Accepted:        ${allAcceptedJobs.length}`);
  console.log(`New Rows to Insert:         ${rowsToInsert.length}`);
  console.log(`Existing Rows to Update:    ${rowsToUpdate.length} ${allowUpdates ? '(Will be updated)' : '(SKIPPED: updates disabled)'}`);
  console.log(`Cross-Role Dupes Skipped:   ${dedupSkipped}`);
  console.log(`Estimated DB Growth:        ${stats.planStats.estimatedGrowthMB} MB`);
  console.log(`Safety Threshold:           150.00 MB`);
  console.log('======================================================\n');

  // Safety Lock: abort if estimated growth > 150 MB without explicit --allow-large
  if (stats.planStats.estimatedGrowthMB > 150 && !allowLarge) {
    const errMsg = `SAFETY LOCK TRIGGERED: Estimated database growth (${stats.planStats.estimatedGrowthMB} MB) exceeds 150 MB limit. Pass --allow-large to proceed.`;
    console.error(`❌ ${errMsg}`);
    throw new Error(errMsg);
  }

  // ---------------------------------------------------------------------------
  // Pre-Write Manifest & Rollback SQL Generation (Saved & Printed BEFORE Writes)
  // ---------------------------------------------------------------------------
  console.log(`🕒 Ingestion run discovered_at: ${runDiscoveredAt}`);

  let savedManifestPath: string | undefined = undefined;
  let savedRollbackSqlPath: string | undefined = undefined;
  const rollbackSql = generateRollbackSql(rowsToInsert, runDiscoveredAt);

  if (isActualLiveWrite || (dryPlan && rowsToInsert.length > 0)) {
    const sanitizedTimestamp = runDiscoveredAt.replace(/[:.]/g, '-');
    const defaultManifestPath = path.resolve(process.cwd(), 'reports', `ingest-manifest-${sanitizedTimestamp}.json`);
    const manifestPath = customManifestPath ? path.resolve(customManifestPath) : defaultManifestPath;
    const manifestDir = path.dirname(manifestPath);
    if (!fs.existsSync(manifestDir)) {
      fs.mkdirSync(manifestDir, { recursive: true });
    }

    const manifestData: IngestManifest = {
      run_discovered_at: runDiscoveredAt,
      generated_at: new Date().toISOString(),
      total_rows: rowsToInsert.length,
      rows: rowsToInsert.map((j) => ({
        source: j.source,
        source_job_id: j.source_job_id,
      })),
    };

    fs.writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2), 'utf-8');
    savedManifestPath = manifestPath;
    console.log(`📝 Pre-write manifest saved: ${manifestPath} (${rowsToInsert.length} insert rows queued)`);

    // Print and save rollback SQL immediately after manifest is written and BEFORE the first DB write
    const rollbackSqlPath = manifestPath.replace(/\.json$/, '.sql');
    fs.writeFileSync(rollbackSqlPath, rollbackSql, 'utf-8');
    savedRollbackSqlPath = rollbackSqlPath;
    console.log(`💾 Pre-write rollback SQL saved: ${rollbackSqlPath}`);

    console.log('\n======================================================');
    console.log('↩️ PRE-WRITE ROLLBACK SQL (MANUAL VERIFICATION ONLY)');
    console.log(`   Discovered At: ${runDiscoveredAt}`);
    console.log(`   Queued Insert Rows: ${rowsToInsert.length}`);
    console.log(`   Manifest: ${manifestPath}`);
    console.log('======================================================');
    console.log(rollbackSql);
    console.log('======================================================\n');
  }

  // ---------------------------------------------------------------------------
  // Live Production Writes (Batches of 500)
  // ---------------------------------------------------------------------------
  if (isActualLiveWrite && supabase) {
    const jobsToWrite = allowUpdates ? [...rowsToUpdate, ...rowsToInsert] : rowsToInsert;
    const insertCount = rowsToInsert.length;
    const updateCount = allowUpdates ? rowsToUpdate.length : 0;
    const skippedUpdateCount = allowUpdates ? 0 : rowsToUpdate.length;

    console.log(`🚀 Executing LIVE WRITE for ${jobsToWrite.length} jobs in batches of ${customBatchSize || 500} (mode: ${allowUpdates ? 'UPSERT' : 'INSERT-ONLY'})...\n`);
    if (skippedUpdateCount > 0) {
      console.log(`🛡️ [Insert-Only] ${skippedUpdateCount} existing rows skipped (pass --allow-updates to enable updates).\n`);
    }

    const BATCH_SIZE = customBatchSize && customBatchSize > 0 ? customBatchSize : 500;
    let totalWritten = 0;
    let batchesCount = 0;

    for (let i = 0; i < jobsToWrite.length; i += BATCH_SIZE) {
      const chunk = jobsToWrite.slice(i, i + BATCH_SIZE);
      batchesCount++;

      const payload = chunk.map((j) => ({
        source: j.source,
        source_job_id: j.source_job_id,
        title: j.title,
        company: j.company,
        location: j.location,
        remote: j.remote,
        remote_scope: j.remote_scope || (j.remote ? 'remote' : 'onsite'),
        job_type: j.job_type,
        apply_url: j.apply_url,
        source_url: j.source_url || j.apply_url,
        salary_text: j.salary_text,
        salary_min: j.salary_min,
        salary_max: j.salary_max,
        currency: j.currency || 'USD',
        category: j.category,
        posted_at: j.posted_at || null,
        last_seen_at: nowIso,
        is_active: true,
        status: 'active',
        description: cleanAndTruncateDescription(j.description, 1500),
        verified: true,
        verified_at: nowIso,
        source_type: 'ats',
        discovered_at: j.discovered_at || runDiscoveredAt,
        country_code: j.country_code || null,
        country: j.country_code && COUNTRY_NAMES[j.country_code] && !j.remote ? COUNTRY_NAMES[j.country_code] : null,
        remote_eligibility: j.remote_eligibility || 'unknown',
        seniority: j.seniority || 'unknown',
        salary_period: j.salary_period || null,
      }));

      try {
        const { error: writeErr } = allowUpdates
          ? await supabase.from('jobs').upsert(payload, { onConflict: 'source,source_job_id' })
          : await supabase.from('jobs').upsert(payload, { ignoreDuplicates: true });

        if (writeErr) {
          throw new Error(`Database write error in batch ${batchesCount}: ${writeErr.message}`);
        }
      } catch (err: any) {
        console.error('\n======================================================');
        console.error(`🚨 BATCH ${batchesCount} FAILED: ABORTED DURING LIVE-WRITE`);
        console.error('↩️ ROLLBACK SQL (USE TO RESTORE DATABASE STATE)');
        console.error(`   Manifest Path: ${savedManifestPath || 'none'}`);
        console.error(`   Run discovered_at: ${runDiscoveredAt}`);
        console.error('======================================================');
        console.error(rollbackSql);
        console.error('======================================================\n');
        throw err;
      }

      totalWritten += chunk.length;
      console.log(`   ✅ Batch ${batchesCount}: Synced ${chunk.length} jobs (Total: ${totalWritten}/${jobsToWrite.length})`);
    }

    let confirmedCount = 0;
    if (rowsToInsert.length > 0) {
      console.log(`\n🔍 Re-selecting inserted keys from database to confirm...`);
      const CHECK_BATCH_SIZE = 200;
      const confirmedKeys = new Set<string>();

      for (let i = 0; i < rowsToInsert.length; i += CHECK_BATCH_SIZE) {
        const chunk = rowsToInsert.slice(i, i + CHECK_BATCH_SIZE);
        const chunkIds = chunk.map((c) => c.source_job_id);

        const { data: confirmedRows, error: confirmErr } = await supabase
          .from('jobs')
          .select('source, source_job_id, discovered_at')
          .in('source_job_id', chunkIds)
          .eq('discovered_at', runDiscoveredAt);

        if (confirmErr) {
          console.warn(`   ⚠️ Warning: Confirmation select query failed: ${confirmErr.message}`);
        } else if (Array.isArray(confirmedRows)) {
          for (const row of confirmedRows) {
            const key = `${row.source}:${row.source_job_id}`;
            if (!confirmedKeys.has(key)) {
              confirmedKeys.add(key);
              confirmedCount++;
            }
          }
        }
      }

      console.log(`   ✅ Confirmation verified: ${confirmedCount}/${rowsToInsert.length} keys confirmed in database.`);
      if (confirmedCount < rowsToInsert.length) {
        console.warn(`   ⚠️ Warning: Confirmed count (${confirmedCount}) is less than queued insert rows (${rowsToInsert.length}). Some rows may have been skipped due to duplicates or constraints.`);
      }
    }

    const actualInserted = allowUpdates ? insertCount : confirmedCount;

    console.log(`\n📊 Live-Write Result:`);
    console.log(`   Total rows written:    ${totalWritten}`);
    console.log(`   New rows inserted:     ${actualInserted}`);
    console.log(`   Existing rows updated: ${updateCount}`);
    console.log(`   Existing rows skipped: ${skippedUpdateCount}`);

    if (savedRollbackSqlPath) {
      console.log(`💾 Rollback SQL ready: ${savedRollbackSqlPath}\n`);
    }

    stats.liveWriteStats = {
      rowsWritten: totalWritten,
      rowsInserted: actualInserted,
      rowsUpdated: updateCount,
      updatesSkipped: skippedUpdateCount,
      confirmedCount,
      batchesCount,
      discoveredAt: runDiscoveredAt,
      manifestPath: savedManifestPath,
      rollbackSql,
    };

    console.log(`🎉 Live-Write Complete: ${totalWritten} jobs successfully synced to database across ${batchesCount} batches.\n`);
  }

  // Sort top companies
  stats.topCompanies.sort((a, b) => b.jobs - a.jobs);

  return stats;
}

// Direct CLI invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);

  const liveWrite = args.includes('--live-write');
  const confirmProdWrite = args.includes('--confirm-prod-write');
  const dryPlan = args.includes('--dry-plan');
  const allowLarge = args.includes('--allow-large');
  const allowUpdates = args.includes('--allow-updates') || args.includes('--update-existing');

  const manifestIdx = args.findIndex((a) => a === '--manifest-path');
  const manifestPath = manifestIdx !== -1 && args[manifestIdx + 1] && !args[manifestIdx + 1].startsWith('--') ? args[manifestIdx + 1] : undefined;

  const atsIdx = args.findIndex((a) => a === '--ats');
  const atsFilter = atsIdx !== -1 ? args[atsIdx + 1] : 'all';

  const compIdx = args.findIndex((a) => a === '--company');
  const companyFilter = compIdx !== -1 ? args[compIdx + 1] : undefined;

  const maxJobsIdx = args.findIndex((a) => a === '--max-jobs');
  const maxJobs = maxJobsIdx !== -1 ? parseInt(args[maxJobsIdx + 1], 10) : undefined;

  const batchIdx = args.findIndex((a) => a === '--batch-size');
  const batchSize = batchIdx !== -1 ? parseInt(args[batchIdx + 1], 10) : undefined;

  const boardsIdx = args.findIndex((a) => a === '--boards');
  const boardsLimit = boardsIdx !== -1 ? parseInt(args[boardsIdx + 1], 10) : undefined;

  const limitIdx = args.findIndex((a) => a === '--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : undefined;

  const inputIdx = args.findIndex((a) => a === '--input');
  const inputPath = inputIdx !== -1 ? args[inputIdx + 1] : undefined;

  const hostIdx = args.findIndex((a) => a === '--expect-host');
  const expectHost = hostIdx !== -1 && args[hostIdx + 1] && !args[hostIdx + 1].startsWith('--') ? args[hostIdx + 1] : undefined;

  runBoardIngestion({
    dryRun: !liveWrite,
    liveWrite,
    confirmProdWrite,
    dryPlan,
    allowLarge,
    allowUpdates,
    batchSize,
    manifestPath,
    maxJobs,
    boardsLimit: boardsLimit || limit,
    atsFilter,
    companyFilter,
    inputPath,
    expectHost,
  })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal Ingestion Error:', err.message);
      process.exit(1);
    });
}
