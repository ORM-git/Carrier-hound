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
 * - Closed-job handling: jobs that vanish from the board are marked inactive after 2 consecutive misses (not deleted).
 * - Dry-run mode by default; live database writes require explicit --live-write-unlocked.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAdapter } from './adapters';
import { GreenhouseAdapter } from './adapters/greenhouse';
import { LeverAdapter } from './adapters/lever';
import { AshbyAdapter } from './adapters/ashby';
import { NormalizedJob, SourceConfig } from './types';
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
} from './utils/sanitizer';
import { isForbiddenDomain } from './utils/polite-fetch';

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
  source_job_id: string;
  company: string;
  title: string;
  consecutive_misses: number;
  is_active: boolean;
  status: string;
}

export interface ClosedJobDecision {
  id: string;
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
 * Loads the company-token registry from disk.
 */
export function loadCompanyRegistry(customPath?: string): CompanyRegistryEntry[] {
  const defaultPaths = [
    path.resolve(__dirname, '../data/ats-company-registry.json'),
    path.resolve(__dirname, 'config/ats-company-registry.json'),
  ];

  let resolvedPath = customPath ? path.resolve(customPath) : null;
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    for (const p of defaultPaths) {
      if (fs.existsSync(p)) {
        resolvedPath = p;
        break;
      }
    }
  }

  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error('ATS company registry file not found in data/ or scripts/config/');
  }

  const raw = fs.readFileSync(resolvedPath, 'utf-8');
  const items: CompanyRegistryEntry[] = JSON.parse(raw);
  return items.filter((item) => item.enabled !== false);
}

/**
 * Evaluates whether an ATS URL is authorized and adheres to public API locks.
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
 * Normalizes an employer posting into the standardized CareerMonke jobs schema.
 */
export function normalizeAtsJob(raw: any, ats: 'greenhouse' | 'lever' | 'ashby', company: string, slug: string): NormalizedJob | null {
  const nowIso = new Date().toISOString();

  if (ats === 'greenhouse') {
    if (!raw || !raw.title || !raw.absolute_url) return null;
    const title = cleanText(raw.title);
    const location = cleanText(raw.location?.name || 'Unspecified');
    const remote = detectRemote(title, location);
    const countryCode = detectCountryCode(location);
    const description = cleanAndTruncateDescription(raw.content, 4000);

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
      apply_url: raw.absolute_url,
      source_url: `https://boards.greenhouse.io/${slug}`,
      category: detectCategory(title),
      posted_at: raw.updated_at || nowIso,
      discovered_at: nowIso,
      last_seen_at: nowIso,
      verified: true,
      is_active: true,
    };
  }

  if (ats === 'lever') {
    if (!raw || !raw.text || (!raw.hostedUrl && !raw.applyUrl)) return null;
    const title = cleanText(raw.text);
    const location = cleanText(raw.categories?.location || 'Unspecified');
    const isRemoteWorkplace = raw.workplaceType === 'remote';
    const remote = isRemoteWorkplace || detectRemote(title, location);
    const countryCode = detectCountryCode(location);
    const rawDesc = raw.descriptionPlain || raw.description;
    const description = cleanAndTruncateDescription(rawDesc, 4000);

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
      apply_url: raw.hostedUrl || raw.applyUrl,
      source_url: `https://jobs.lever.co/${slug}`,
      category: detectCategory(title),
      posted_at: raw.createdAt ? new Date(raw.createdAt).toISOString() : nowIso,
      discovered_at: nowIso,
      last_seen_at: nowIso,
      verified: true,
      is_active: true,
    };
  }

  if (ats === 'ashby') {
    if (!raw || !raw.title || (!raw.jobUrl && !raw.applyUrl)) return null;
    const title = cleanText(raw.title);
    const location = cleanText(raw.location || 'Unspecified');
    const remote = detectRemote(title, location, raw.isRemote);
    const countryCode = detectCountryCode(location);
    const rawDesc = raw.descriptionPlain || raw.descriptionHtml;
    const description = cleanAndTruncateDescription(rawDesc, 4000);

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
      apply_url: raw.jobUrl || raw.applyUrl,
      source_url: `https://jobs.ashbyhq.com/${slug}`,
      category: detectCategory(title),
      posted_at: raw.publishedAt || nowIso,
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
export function dedupJobs(jobs: NormalizedJob[], existingSeenUrls?: Set<string>, existingSeenRoles?: Set<string>): {
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
 * Jobs that vanish from an employer's board are marked inactive after 2 consecutive misses.
 * They are NEVER deleted.
 * When a job reappears, its consecutive misses count is reset to 0 and marked active.
 */
export function handleClosedJobs(
  existingJobsForCompany: ClosedJobRecord[],
  freshFetchedJobIds: Set<string>
): ClosedJobDecision[] {
  const decisions: ClosedJobDecision[] = [];

  for (const existing of existingJobsForCompany) {
    const isPresent = freshFetchedJobIds.has(existing.source_job_id);

    if (isPresent) {
      // Re-verified active on board
      decisions.push({
        id: existing.id,
        source_job_id: existing.source_job_id,
        consecutive_misses: 0,
        is_active: true,
        status: 'active',
        action: 'reset_active',
      });
    } else {
      // Vanished from current board fetch
      const updatedMisses = (existing.consecutive_misses || 0) + 1;
      const shouldDeactivate = updatedMisses >= 2;

      decisions.push({
        id: existing.id,
        source_job_id: existing.source_job_id,
        consecutive_misses: updatedMisses,
        is_active: !shouldDeactivate,
        status: shouldDeactivate ? 'inactive' : existing.status,
        action: shouldDeactivate ? 'marked_inactive' : 'kept_active',
      });
    }
  }

  return decisions;
}

/**
 * Executes Board Ingestion across Greenhouse, Lever, and Ashby.
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
  console.log(`ATS Filter: ${atsFilter}`);
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
      let rawJobs: NormalizedJob[] = [];

      if (fixtureMode && fixtureDir) {
        // Load fixture files for test suite isolation
        const fixturePath = path.resolve(fixtureDir, `${target.ats}-response.json`);
        if (fs.existsSync(fixturePath)) {
          const rawFixture = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
          if (target.ats === 'greenhouse') {
            const jobsArr = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];
            rawJobs = jobsArr
              .map((j: any) => normalizeAtsJob(j, 'greenhouse', target.company, target.token))
              .filter(Boolean) as NormalizedJob[];
          } else if (target.ats === 'lever') {
            const jobsArr = Array.isArray(rawFixture) ? rawFixture : [];
            rawJobs = jobsArr
              .map((j: any) => normalizeAtsJob(j, 'lever', target.company, target.token))
              .filter(Boolean) as NormalizedJob[];
          } else if (target.ats === 'ashby') {
            const jobsArr = Array.isArray(rawFixture.jobs) ? rawFixture.jobs : [];
            rawJobs = jobsArr
              .map((j: any) => normalizeAtsJob(j, 'ashby', target.company, target.token))
              .filter(Boolean) as NormalizedJob[];
          }
        }
      } else {
        // Standard adapter fetch via polite rate-limited API client
        const sourceConfig: SourceConfig = {
          id: target.id || `${target.ats}-${target.token}`,
          name: target.company,
          type: target.ats,
          target: target.token,
          enabled: true,
        };

        const adapter = getAdapter(target.ats);
        if (!adapter) {
          throw new Error(`Adapter for ${target.ats} not found`);
        }

        rawJobs = await adapter.fetchJobs(sourceConfig);
      }

      stats.totalJobsFetched += rawJobs.length;

      const { accepted, duplicates } = dedupJobs(rawJobs, seenUrls, seenRoles);
      stats.totalJobsDeduplicated += duplicates;
      stats.totalJobsAccepted += accepted.length;
      stats.companiesSucceeded++;

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

      console.log(`   ${prefix}: ${accepted.length} accepted (${duplicates} deduped)`);
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
