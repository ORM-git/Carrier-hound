import { LruCache } from "../src/lib/cache/lru";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getAdapter } from './adapters';
import { runJobCleanup, shouldPerformUnseenCleanup } from './cleanup';
import {
  IngestionRunSummary,
  NormalizedJob,
  SourceConfig,
  SourceStats,
} from './types';
import { detectCategory, slugify } from './utils/sanitizer';
import { dropFeedJobsAlreadyCoveredByAts } from './utils/crossSourceDedupe';
import { resolveCompanyLogo } from '../src/lib/companies/logoResolver';

// ISO alpha-2 -> display name for the legacy `country` text column (kept in sync with country_code)
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', IN: 'India', GB: 'United Kingdom', CA: 'Canada', DE: 'Germany',
  SG: 'Singapore', AU: 'Australia', FR: 'France', NL: 'Netherlands', IE: 'Ireland',
  JP: 'Japan', BR: 'Brazil', CH: 'Switzerland', SE: 'Sweden', ES: 'Spain', IT: 'Italy',
  PL: 'Poland', MX: 'Mexico', IL: 'Israel', AE: 'United Arab Emirates', AT: 'Austria',
  DK: 'Denmark', NO: 'Norway', FI: 'Finland', NZ: 'New Zealand', PT: 'Portugal', PH: 'Philippines',
};

// Load environment variables
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

// CLI argument parsing
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry') || args.includes('-d');
const isCleanupOnly = args.includes('--cleanup-only');
const isSkipCleanup = args.includes('--skip-cleanup');
const isSeedRun = args.includes('--seed') || args.includes('-s');
const isScheduledRun = args.includes('--scheduled');

const configArgIdx = args.findIndex((a) => a === '--config' || a === '-c');
const configCustom = configArgIdx !== -1 && args[configArgIdx + 1] ? args[configArgIdx + 1] : null;

const ATS_TYPES = new Set(['greenhouse', 'ashby', 'lever', 'smartrecruiters', 'recruitee', 'workable']);
function isAtsSource(type: string): boolean {
  return ATS_TYPES.has(type.toLowerCase());
}

const capArgIdx = args.findIndex((a) => a === '--cap');
const MAX_RUN_JOBS = capArgIdx !== -1 && args[capArgIdx + 1] ? parseInt(args[capArgIdx + 1], 10) : 50000;

const perSourceIdx = args.findIndex((a) => a === '--per-source');
const MAX_PER_SOURCE = perSourceIdx !== -1 && args[perSourceIdx + 1] ? parseInt(args[perSourceIdx + 1], 10) : null;

const limitIdx = args.findIndex((a) => a === '--limit' || a === '-l');
const MAX_SOURCES_LIMIT = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;

const offsetIdx = args.findIndex((a) => a === '--offset');
const OFFSET = offsetIdx !== -1 && args[offsetIdx + 1] ? parseInt(args[offsetIdx + 1], 10) : 0;

const sourceFilterIdx = args.findIndex((a) => a === '--source');
const sourceFilter = sourceFilterIdx !== -1 ? args[sourceFilterIdx + 1] : null;

const concArgIdx = args.findIndex((a) => a === '--concurrency' || a === '-p');
const CONCURRENCY = concArgIdx !== -1 && args[concArgIdx + 1] ? parseInt(args[concArgIdx + 1], 10) : 4;

const shardArgIdx = args.findIndex((a) => a === '--shard');
const SHARD_INDEX = shardArgIdx !== -1 && args[shardArgIdx + 1] ? parseInt(args[shardArgIdx + 1], 10) : null;

const shardsArgIdx = args.findIndex((a) => a === '--shards' || a === '--total-shards');
const TOTAL_SHARDS = shardsArgIdx !== -1 && args[shardsArgIdx + 1] ? parseInt(args[shardsArgIdx + 1], 10) : null;

const cycleArgIdx = args.findIndex((a) => a === '--cycle-id' || a === '--cycle');
const CYCLE_ID = cycleArgIdx !== -1 && args[cycleArgIdx + 1] ? args[cycleArgIdx + 1] : (process.env.INGEST_CYCLE_ID || null);

const isShardedRun = SHARD_INDEX !== null || (TOTAL_SHARDS !== null && TOTAL_SHARDS > 1);

// Track schema capability flags dynamically
let hasCompaniesTable = false;
let hasJobDescriptionsTable = false;
let hasIngestRunsTable = false;
let hasVerifiedColumn = false;
let hasCoverageColumn = false;

// Entry-count guard, not a measured performance claim. Evicted companies
// follow the existing DB lookup path; correctness does not depend on a hit.
const companyCache = new LruCache<string, string>(5000); // slug -> company_id

// Initialize Supabase Client
function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    if (isDryRun) {
      console.warn('⚠️ [Ingest] Supabase credentials not found in env, proceeding in offline DRY-RUN mode.');
      return null;
    }
    console.error('❌ [Ingest] Missing Supabase credentials in environment:');
    if (!supabaseUrl) console.error('   - Missing: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_URL');
    if (!serviceRoleKey) console.error('   - Missing: SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SERVICE_KEY');
    console.error('   Please configure repository secrets in GitHub: Settings -> Secrets and variables -> Actions.');
    process.exit(1);
  }

  try {
    const parsed = new URL(supabaseUrl);
    console.log(`🔌 [Ingest] Initialized Supabase client for host: ${parsed.host}`);
  } catch {
    console.error(`❌ [Ingest] Invalid Supabase URL format in environment.`);
    process.exit(1);
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Detect database capabilities to remain 100% backward compatible before/after migrations
async function detectSchemaCapabilities(supabase: SupabaseClient): Promise<void> {
  try {
    const { error: compErr } = await supabase.from('companies').select('id').limit(1);
    hasCompaniesTable = !compErr;

    const { error: descErr } = await supabase.from('job_descriptions').select('job_id').limit(1);
    hasJobDescriptionsTable = !descErr;

    const { error: runsErr } = await supabase.from('ingest_runs').select('id').limit(1);
    hasIngestRunsTable = !runsErr;
    if (hasIngestRunsTable) {
      const { error: covErr } = await supabase.from('ingest_runs').select('coverage').limit(1);
      hasCoverageColumn = !covErr;
    }

    const { error: verErr } = await supabase.from('jobs').select('verified').limit(1);
    hasVerifiedColumn = !verErr;

    console.log(`Schema capabilities: companies=${hasCompaniesTable}, job_descriptions=${hasJobDescriptionsTable}, ingest_runs=${hasIngestRunsTable}, coverage_col=${hasCoverageColumn}, verified_col=${hasVerifiedColumn}`);
  } catch (err: any) {
    console.warn(`[Schema Detection Warning]: ${err.message}`);
  }
}

// Resolve or create company record in companies table with logo resolution
async function getOrCreateCompany(
  supabase: SupabaseClient,
  companyName: string,
  slug: string,
  atsType: string,
  sampleApplyUrl?: string
): Promise<string | null> {
  if (!hasCompaniesTable || !slug) return null;
  const cached = companyCache.get(slug);
  if (cached) return cached;

  try {
    const { data: existing } = await supabase
      .from('companies')
      .select('id, logo_url, domain')
      .eq('slug', slug)
      .maybeSingle();

    if (existing?.id) {
      companyCache.set(slug, existing.id);

      // Backfill missing logo_url at ingestion time if sample URL is present
      if (!existing.logo_url) {
        try {
          const resolved = await resolveCompanyLogo(
            { id: existing.id, name: companyName, slug, ats_type: atsType, domain: existing.domain },
            sampleApplyUrl ? [{ apply_url: sampleApplyUrl }] : []
          );
          if (resolved?.imageUrl) {
            await supabase
              .from('companies')
              .update({
                logo_url: resolved.imageUrl,
                ...(resolved.domain && !existing.domain ? { domain: resolved.domain } : {}),
              })
              .eq('id', existing.id);
          }
        } catch {
          // Non-blocking for ingestion
        }
      }

      return existing.id;
    }

    // Resolve logo at insert time for new company
    let initialLogoUrl: string | null = null;
    let initialDomain: string | null = null;
    try {
      const resolved = await resolveCompanyLogo(
        { id: 'pending', name: companyName, slug, ats_type: atsType },
        sampleApplyUrl ? [{ apply_url: sampleApplyUrl }] : []
      );
      if (resolved?.imageUrl) {
        initialLogoUrl = resolved.imageUrl;
        initialDomain = resolved.domain || null;
      }
    } catch {
      // Non-blocking for ingestion
    }

    const { data: inserted } = await supabase
      .from('companies')
      .insert([
        {
          name: companyName,
          slug: slug,
          ats_type: atsType,
          enabled: true,
          last_success_at: new Date().toISOString(),
          ...(initialLogoUrl ? { logo_url: initialLogoUrl } : {}),
          ...(initialDomain ? { domain: initialDomain } : {}),
        },
      ])
      .select('id')
      .maybeSingle();

    if (inserted?.id) {
      companyCache.set(slug, inserted.id);
      return inserted.id;
    }
  } catch {
    // Ignore error
  }
  return null;
}

// Load source configuration
function loadSourcesConfig(): SourceConfig[] {
  let configFile = 'config/sources.json';
  if (configCustom) {
    configFile = configCustom;
  } else if (isScheduledRun) {
    configFile = 'config/companies-scheduled.json';
  } else if (isSeedRun) {
    configFile = 'config/companies-seed.json';
  }
  const configPath = path.isAbsolute(configFile) ? configFile : path.resolve(__dirname, configFile);
  if (!fs.existsSync(configPath)) {
    // Fallback
    const fallbackPath = path.resolve(__dirname, 'config/sources.json');
    if (!fs.existsSync(fallbackPath)) {
      throw new Error(`Sources config file not found at ${configPath}`);
    }
    const raw = fs.readFileSync(fallbackPath, 'utf-8');
    return JSON.parse(raw).filter((s: SourceConfig) => s.enabled);
  }
  const raw = fs.readFileSync(configPath, 'utf-8');
  const sources: SourceConfig[] = JSON.parse(raw);
  return sources.filter((s) => s.enabled);
}

/**
 * Validates whether a normalized job meets minimum ingestion criteria.
 */
function isValidJob(job: NormalizedJob): boolean {
  if (!job.title || job.title.trim().length === 0) return false;
  if (!job.company || job.company.trim().length === 0) return false;
  if (!job.apply_url || !job.apply_url.startsWith('http')) return false;
  return true;
}

/**
 * Main Ingestion Pipeline Runner
 */
async function main() {
  const startTime = Date.now();
  console.log(`\n======================================================`);
  console.log(`🚀 CareerMonke Large-Scale Storage-Optimized Ingestion`);
  console.log(`======================================================`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN (No writes)' : 'LIVE PRODUCTION'}`);
  console.log(`Config Source: ${configCustom || (isScheduledRun ? 'companies-scheduled.json' : isSeedRun ? 'companies-seed.json' : 'sources.json')}`);
  console.log(`Max Run Job Cap: ${MAX_RUN_JOBS}`);
  console.log(`Concurrency: ${CONCURRENCY} workers`);
  if (TOTAL_SHARDS && SHARD_INDEX !== null) console.log(`Shard: [${SHARD_INDEX + 1}/${TOTAL_SHARDS}]`);
  if (OFFSET > 0) console.log(`Offset: Skipping first ${OFFSET} companies`);
  if (MAX_SOURCES_LIMIT) console.log(`Limit: Processing up to ${MAX_SOURCES_LIMIT} companies`);
  if (sourceFilter) console.log(`Filter: Single Source [${sourceFilter}]`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  const supabase = getSupabaseClient();
  if (supabase && !isDryRun) {
    await detectSchemaCapabilities(supabase);
  }

  if (isCleanupOnly) {
    if (!supabase) {
      if (isDryRun) {
        console.warn('⚠️ [Cleanup] Supabase credentials not found in env; skipping cleanup in offline DRY-RUN mode.');
        return;
      }
      console.error('Cleanup requires valid Supabase credentials.');
      process.exit(1);
    }

    let recentRuns: any[] = [];
    if (supabase) {
      try {
        const columns = hasCoverageColumn
          ? 'started_at,finished_at,status,per_source_counts,coverage'
          : 'started_at,finished_at,status,per_source_counts';
        const { data, error } = await supabase
          .from('ingest_runs')
          .select(columns)
          .order('finished_at', { ascending: false })
          .limit(50);
        if (data && !error) recentRuns = data;
      } catch {
        // Fall back to empty runs
      }
    }

    const safetyCheck = shouldPerformUnseenCleanup({
      isScheduled: isScheduledRun,
      isSeed: isSeedRun,
      sourceFilter,
      capArgPresent: capArgIdx !== -1,
      capValue: MAX_RUN_JOBS,
      expectedShards: 6,
      runs: recentRuns,
      cycleId: CYCLE_ID,
    });

    const skipUnseen = !safetyCheck.allowed;
    if (skipUnseen) {
      console.warn(`⚠️ [Cleanup Safety] Global unseen expiration SKIPPED: ${safetyCheck.reason}`);
    } else {
      console.log(`✅ [Cleanup Safety] Global unseen expiration ENABLED: ${safetyCheck.reason}`);
    }

    await runJobCleanup(supabase, {
      dryRun: isDryRun,
      skipUnseenCheck: skipUnseen,
    });
    console.log(`\n🎉 Cleanup complete.`);
    return;
  }

  let sources = loadSourcesConfig();
  if (sourceFilter) {
    sources = sources.filter((s) => s.id === sourceFilter || s.target === sourceFilter);
    if (sources.length === 0) {
      console.error(`❌ Source with id or target "${sourceFilter}" not found in config.`);
      process.exit(1);
    }
  }

  // Authority Tier Sorting: Process Tier 1 (authoritative ATS) before Tier 2 (aggregators/feeds)
  sources.sort((a, b) => {
    const aTier = isAtsSource(a.type) ? 0 : 1;
    const bTier = isAtsSource(b.type) ? 0 : 1;
    return aTier - bTier;
  });

  // Shard partitioning: balanced modulo partition across total shards
  if (TOTAL_SHARDS && TOTAL_SHARDS > 1 && SHARD_INDEX !== null && SHARD_INDEX >= 0 && SHARD_INDEX < TOTAL_SHARDS) {
    sources = sources.filter((_, idx) => idx % TOTAL_SHARDS === SHARD_INDEX);
  }

  if (OFFSET > 0 || (MAX_SOURCES_LIMIT && MAX_SOURCES_LIMIT > 0)) {
    sources = sources.slice(OFFSET, MAX_SOURCES_LIMIT ? OFFSET + MAX_SOURCES_LIMIT : undefined);
  }

  console.log(`Found ${sources.length} active sources to process.\n`);

  const summary: IngestionRunSummary = {
    startedAt: new Date(startTime).toISOString(),
    completedAt: '',
    durationSeconds: 0,
    dryRun: isDryRun,
    totalFetched: 0,
    totalInserted: 0,
    totalUpdated: 0,
    totalSkipped: 0,
    totalFailed: 0,
    sources: [],
    cleanup: { markedExpired: 0, permanentlyDeleted: 0 },
  };

  const seenApplyUrls = new Set<string>();
  const seenAtsRoles = new Set<string>(); // dedupeKey for Tier 1: slugify(company)::slugify(title)::(country_code || 'any')
  let totalAccumulatedJobs = 0;

  async function processSource(source: SourceConfig, sourceIndex: number): Promise<void> {
    if (totalAccumulatedJobs >= MAX_RUN_JOBS) {
      return;
    }

    const stats: SourceStats = {
      sourceId: source.id,
      sourceName: source.name,
      type: source.type,
      fetched: 0,
      normalized: 0,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    };

    console.log(`[${sourceIndex + 1}/${sources.length}] ▶ Processing [${source.type.toUpperCase()}] ${source.name}...`);

    let timeoutId: NodeJS.Timeout | null = null;
    try {
      const adapter = getAdapter(source.type);
      if (!adapter) {
        throw new Error(`No adapter implemented for source type: ${source.type}`);
      }

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Timeout after 45s processing ${source.name}`)), 45000);
      });

      const rawJobs = await Promise.race([
        adapter.fetchJobs(source),
        timeoutPromise,
      ]);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }

      stats.fetched = rawJobs.length;
      summary.totalFetched += rawJobs.length;

      // Filter and deduplicate within current run
      const validJobs: NormalizedJob[] = [];
      for (const job of rawJobs) {
        if (!isValidJob(job)) {
          stats.skipped++;
          continue;
        }

        // Intra-run deduplication on apply_url
        if (seenApplyUrls.has(job.apply_url)) {
          stats.skipped++;
          continue;
        }

        // Cross-source deduplication: Tier 1 ATS direct vs Tier 2 Aggregator feeds
        const roleDedupeKey = `${slugify(job.company)}::${slugify(job.title)}::${job.country_code || 'any'}`;
        if (isAtsSource(source.type)) {
          seenAtsRoles.add(roleDedupeKey);
        } else {
          // If a verified ATS role already exists, drop the feed duplicate
          if (seenAtsRoles.has(roleDedupeKey)) {
            stats.skipped++;
            continue;
          }
        }

        seenApplyUrls.add(job.apply_url);
        validJobs.push(job);
        totalAccumulatedJobs++;
        if (MAX_PER_SOURCE && validJobs.length >= MAX_PER_SOURCE) break;
        if (totalAccumulatedJobs >= MAX_RUN_JOBS) break;
      }

      // Cross-run dedupe (Backend rank 98): drop feed jobs whose role is already active in the DB
      // from a verified ATS source. Live runs only; fails open (keeps everything) on any DB error.
      if (supabase && !isDryRun && !isAtsSource(source.type) && validJobs.length > 0) {
        const covered = await dropFeedJobsAlreadyCoveredByAts(supabase, validJobs);
        if (covered.dropped > 0) {
          validJobs.splice(0, validJobs.length, ...covered.kept);
          stats.skipped += covered.dropped;
          totalAccumulatedJobs -= covered.dropped;
          console.log(`   Cross-source dedupe: dropped ${covered.dropped} feed job(s) already covered by a verified ATS row.`);
        }
      }

      stats.normalized = validJobs.length;
      console.log(`   Fetched: ${stats.fetched} | Valid: ${stats.normalized} | Skipped: ${stats.skipped}`);

      if (validJobs.length > 0) {
        if (isDryRun || !supabase) {
          // Print sample job preview in dry run
          stats.inserted = validJobs.length;
          const s = validJobs[0];
          console.log(`   [DRY RUN] Sample Job:`);
          console.log(`     Title: ${s.title}`);
          console.log(`     Company: ${s.company} | Country: ${s.country_code || 'N/A'}`);
          console.log(`     Type: ${s.job_type} | Seniority: ${s.seniority || 'unknown'} | Remote: ${s.remote}`);
          console.log(`     Verified: ${s.verified ? 'YES (Source: ATS)' : 'NO'}`);
          console.log(`     Apply URL: ${s.apply_url}`);
          if (s.salary_text) console.log(`     Salary: ${s.salary_text}`);
        } else {
          // Resolve company_id if companies table exists
          let companyId: string | null = null;
          const isAts = isAtsSource(source.type);
          if (isAts && hasCompaniesTable) {
            const companyName = source.name.replace(/\s*\((?:Greenhouse|Lever|Ashby|SmartRecruiters|Recruitee|Workable)\)$/i, '').trim();
            const sampleApplyUrl = validJobs[0]?.apply_url || validJobs[0]?.source_url;
            companyId = await getOrCreateCompany(supabase, companyName, source.target, source.type, sampleApplyUrl);
          }

          // Live Supabase Sync in batches of 50
          const batchSize = 50;
          for (let i = 0; i < validJobs.length; i += batchSize) {
            const batchChunk = validJobs.slice(i, i + batchSize);

            // Construct payload conforming to available columns
            const jobsPayload = batchChunk.map((j) => {
              const row: any = {
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
                category: j.category || detectCategory(j.title),
                posted_at: j.posted_at || new Date().toISOString(),
                last_seen_at: new Date().toISOString(),
                is_active: true,
                status: 'active',
              };

              // If job_descriptions table exists, offload description; otherwise retain for backward compatibility
              if (!hasJobDescriptionsTable) {
                row.description = j.description || `${j.title} at ${j.company}`;
              }

              // Include new Phase 1 columns if available in database
              if (hasVerifiedColumn) {
                row.verified = j.verified ?? false;
                row.verified_at = j.verified_at || null;
                row.source_type = j.source_type || 'ats';
                row.discovered_at = j.discovered_at || new Date().toISOString();
                row.country_code = j.country_code || null;
                // Fill the legacy country text from the code, but keep 'Remote' style rows untouched
                if (j.country_code && COUNTRY_NAMES[j.country_code] && !j.remote) {
                  row.country = COUNTRY_NAMES[j.country_code];
                }
                row.remote_eligibility = j.remote_eligibility || 'unknown';
                row.seniority = j.seniority || 'unknown';
                row.salary_period = j.salary_period || null;
                if (companyId) row.company_id = companyId;
              }

              return row;
            });

            // Upsert jobs into Supabase
            const { data: upsertedRows, error: upsertErr } = await supabase
              .from('jobs')
              .upsert(jobsPayload, { onConflict: 'source,source_job_id' })
              .select('id, source_job_id');

            if (!upsertErr) {
              stats.inserted += jobsPayload.length;

              // If job_descriptions table exists, insert/upsert descriptions
              if (hasJobDescriptionsTable && upsertedRows && upsertedRows.length > 0) {
                const descPayload = upsertedRows
                  .map((r) => {
                    const original = batchChunk.find((b) => b.source_job_id === r.source_job_id);
                    if (!original?.description) return null;
                    return {
                      job_id: r.id,
                      description_text: original.description,
                      updated_at: new Date().toISOString(),
                    };
                  })
                  .filter((item): item is { job_id: string; description_text: string; updated_at: string } => item !== null);

                if (descPayload.length > 0) {
                  await supabase.from('job_descriptions').upsert(descPayload, { onConflict: 'job_id' });
                }
              }
            } else {
              // High-Performance Fallback: Lookup existing by apply_url & source_job_id
              const ids = jobsPayload.map((b: any) => b.source_job_id).filter(Boolean);
              const urls = jobsPayload.map((b: any) => b.apply_url).filter(Boolean);

              const [resUrl, resId] = await Promise.all([
                supabase.from('jobs').select('id, source_job_id, apply_url').in('apply_url', urls),
                supabase.from('jobs').select('id, source_job_id, apply_url').in('source_job_id', ids),
              ]);

              const existingIdMap = new Map<string, string>();
              const existingUrlMap = new Map<string, string>();

              if (resUrl.data) {
                for (const row of resUrl.data) {
                  if (row.apply_url) existingUrlMap.set(row.apply_url, row.id);
                  if (row.source_job_id) existingIdMap.set(row.source_job_id, row.id);
                }
              }
              if (resId.data) {
                for (const row of resId.data) {
                  if (row.source_job_id) existingIdMap.set(row.source_job_id, row.id);
                  if (row.apply_url) existingUrlMap.set(row.apply_url, row.id);
                }
              }

              const toInsert: any[] = [];
              const toUpdate: Array<{ id: string; item: any; original: NormalizedJob }> = [];

              for (let jIdx = 0; jIdx < jobsPayload.length; jIdx++) {
                const item = jobsPayload[jIdx];
                const originalJob = batchChunk[jIdx];
                const existingId =
                  existingIdMap.get(item.source_job_id) || existingUrlMap.get(item.apply_url);

                if (existingId) {
                  toUpdate.push({ id: existingId, item, original: originalJob });
                } else {
                  toInsert.push(item);
                }
              }

              // 1. Batch Insert ALL new items at once
              if (toInsert.length > 0) {
                const { data: insertedRows, error: insErr } = await supabase
                  .from('jobs')
                  .insert(toInsert)
                  .select('id, source_job_id');

                if (!insErr && insertedRows) {
                  stats.inserted += insertedRows.length;
                  if (hasJobDescriptionsTable) {
                    const descBatch = insertedRows
                      .map((r) => {
                        const original = batchChunk.find((b) => b.source_job_id === r.source_job_id);
                        if (!original?.description) return null;
                        return {
                          job_id: r.id,
                          description_text: original.description,
                          updated_at: new Date().toISOString(),
                        };
                      })
                      .filter((x): x is { job_id: string; description_text: string; updated_at: string } => x !== null);

                    if (descBatch.length > 0) {
                      await supabase.from('job_descriptions').upsert(descBatch, { onConflict: 'job_id' });
                    }
                  }
                } else {
                  // Fallback: process row-by-row if a batch item conflicts
                  for (const singleItem of toInsert) {
                    const { data: singleRow, error: singleErr } = await supabase
                      .from('jobs')
                      .insert([singleItem])
                      .select('id, source_job_id')
                      .maybeSingle();

                    if (!singleErr && singleRow) {
                      stats.inserted++;
                      if (hasJobDescriptionsTable) {
                        const original = batchChunk.find((b) => b.source_job_id === singleRow.source_job_id);
                        if (original?.description) {
                          await supabase.from('job_descriptions').upsert({
                            job_id: singleRow.id,
                            description_text: original.description,
                            updated_at: new Date().toISOString(),
                          });
                        }
                      }
                    } else {
                      // If it already exists by apply_url, update it
                      const { error: urlUpdErr } = await supabase
                        .from('jobs')
                        .update({
                          ...singleItem,
                          last_seen_at: new Date().toISOString(),
                          is_active: true,
                          status: 'active',
                        })
                        .eq('apply_url', singleItem.apply_url);

                      if (!urlUpdErr) stats.updated++;
                      else stats.failed++;
                    }
                  }
                }
              }

              // 2. Parallel Update for existing items
              if (toUpdate.length > 0) {
                await Promise.all(
                  toUpdate.map(async ({ id, item, original }) => {
                    const { error: updErr } = await supabase
                      .from('jobs')
                      .update({
                        ...item,
                        last_seen_at: new Date().toISOString(),
                        is_active: true,
                        status: 'active',
                      })
                      .eq('id', id);

                    if (!updErr) {
                      stats.updated++;
                      if (hasJobDescriptionsTable && original?.description) {
                        await supabase.from('job_descriptions').upsert({
                          job_id: id,
                          description_text: original.description,
                          updated_at: new Date().toISOString(),
                        });
                      }
                    } else {
                      stats.failed++;
                    }
                  })
                );
              }
            }
          }
          console.log(`   ✅ Synced ${stats.inserted + stats.updated} jobs (${stats.inserted} new, ${stats.updated} updated).`);

          // Board success tracking & Job Disappearance Detection for ATS boards
          if (isAts && supabase && !isDryRun) {
            try {
              await supabase
                .from('company_boards')
                .update({
                  failure_count: 0,
                  enabled: true,
                  last_success_at: new Date().toISOString(),
                  last_job_count: validJobs.length,
                })
                .eq('ats_type', source.type)
                .eq('slug', source.target);

              if (companyId) {
                await supabase
                  .from('companies')
                  .update({
                    failure_count: 0,
                    enabled: true,
                    last_success_at: new Date().toISOString(),
                    last_job_count: validJobs.length,
                  })
                  .eq('id', companyId);
              }

              // DESTRUCTIVE SAFETY: A source fetch returning empty or error must NEVER be treated as proof
              // that all jobs disappeared. Board cleanup must not expire jobs based on failed/incomplete fetches.
              const isCappedOrIncomplete = Boolean(
                MAX_PER_SOURCE ||
                totalAccumulatedJobs >= MAX_RUN_JOBS ||
                stats.failed > 0 ||
                validJobs.length === 0
              );

              if (isCappedOrIncomplete) {
                if (validJobs.length === 0) {
                  console.log(`   🛡️ [Destructive Safety] Source returned 0 jobs. Skipping disappearance detection to preserve active jobs.`);
                } else {
                  console.log(`   🛡️ [Destructive Safety] Incomplete or capped fetch detected. Skipping disappearance detection.`);
                }
              } else {
                const cleanCompName = source.name.replace(/\s*\((?:Greenhouse|Lever|Ashby|SmartRecruiters|Recruitee|Workable)\)$/i, '').trim();
                const activeQuery = supabase
                  .from('jobs')
                  .select('id, source_job_id')
                  .eq('source', source.type)
                  .eq('is_active', true);

                if (companyId) {
                  activeQuery.eq('company_id', companyId);
                } else {
                  activeQuery.ilike('company', cleanCompName);
                }

                const { data: dbActiveJobs } = await activeQuery;
                if (dbActiveJobs && dbActiveJobs.length > 0) {
                  // Destructive safety guard: if returned count drops by >50% on boards with >5 active jobs,
                  // do not mass-expire in a single sync (protect against partial/paginated API outages)
                  const isSuspiciousDrop = dbActiveJobs.length > 5 && validJobs.length < dbActiveJobs.length * 0.5;
                  if (isSuspiciousDrop) {
                    console.warn(`   ⚠️ [Destructive Safety] Anomaly detected: returned ${validJobs.length} jobs vs ${dbActiveJobs.length} active in DB (>50% drop). Preserving active jobs.`);
                  } else {
                    const returnedIds = new Set(validJobs.map((j) => j.source_job_id));
                    const disappearedIds = dbActiveJobs
                      .filter((j) => !returnedIds.has(j.source_job_id))
                      .map((j) => j.id);

                    if (disappearedIds.length > 0) {
                      const { error: expErr } = await supabase
                        .from('jobs')
                        .update({
                          is_active: false,
                          status: 'expired',
                          expires_at: new Date().toISOString(),
                        })
                        .in('id', disappearedIds);

                      if (!expErr) {
                        console.log(`   📉 Disappearance Detection: Expired ${disappearedIds.length} obsolete jobs verified removed from ATS board.`);
                        summary.cleanup.markedExpired += disappearedIds.length;
                      }
                    }
                  }
                }
              }
            } catch (err: any) {
              console.warn(`   ⚠️ Board tracking/closure warning: ${err.message}`);
            }
          }
        }
      }
    } catch (err: any) {
    stats.failed = stats.fetched || 1;
    stats.error = err.message;
    console.error(`   ❌ Failed processing source: ${err.message}`);

    // Track consecutive board failures
    if (isAtsSource(source.type) && supabase && !isDryRun) {
      try {
        const { data: boardRow } = await supabase
          .from('company_boards')
          .select('id, failure_count')
          .eq('ats_type', source.type)
          .eq('slug', source.target)
          .maybeSingle();

        const currentFailures = (boardRow?.failure_count || 0) + 1;
        const shouldDisable = currentFailures >= 3;

        await supabase
          .from('company_boards')
          .update({
            failure_count: currentFailures,
            enabled: !shouldDisable,
          })
          .eq('ats_type', source.type)
          .eq('slug', source.target);

        if (shouldDisable) {
          console.warn(`   ⚠️ Board [${source.type}] ${source.target} disabled after 3 consecutive failures. Active jobs preserved.`);
          // DESTRUCTIVE SAFETY: Do NOT mass-expire jobs on fetch failures!
          // A source fetch returning empty or error must NEVER be treated as proof that jobs disappeared.
        }
      } catch {}
    }
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

    summary.sources.push(stats);
    summary.totalInserted += stats.inserted;
    summary.totalUpdated += stats.updated;
    summary.totalSkipped += stats.skipped;
    summary.totalFailed += stats.failed;
  }

  // Run sources with concurrency worker pool
  let nextIdx = 0;
  async function worker() {
    while (nextIdx < sources.length) {
      if (totalAccumulatedJobs >= MAX_RUN_JOBS) break;
      const currentIdx = nextIdx++;
      await processSource(sources[currentIdx], currentIdx);
    }
  }

  const poolSize = Math.max(1, Math.min(CONCURRENCY, sources.length));
  console.log(`Starting worker pool with ${poolSize} concurrent workers...`);
  const workers = Array.from({ length: poolSize }, () => worker());
  await Promise.all(workers);

  // Cleanup & expiration phase
  if (!isSkipCleanup && supabase) {
    // Destructive safety: only run unseen-based expiration if this was a complete, full-corpus run with zero source failures
    const isFullRun = !isSeedRun && !isShardedRun && !sourceFilter && !MAX_SOURCES_LIMIT && !OFFSET && !MAX_PER_SOURCE && summary.totalFailed === 0;
    const cleanupResult = await runJobCleanup(supabase, {
      dryRun: isDryRun,
      skipUnseenCheck: !isFullRun,
    });
    summary.cleanup = cleanupResult;
  }

  const endTime = Date.now();
  summary.completedAt = new Date(endTime).toISOString();
  summary.durationSeconds = Math.round((endTime - startTime) / 1000);

  // Record Run into ingest_runs if table exists
  if (hasIngestRunsTable && supabase && !isDryRun) {
    try {
      const effectiveCycleId = CYCLE_ID || (isShardedRun ? `cycle-${summary.startedAt}` : `standalone-${summary.startedAt}`);
      const coverageData = {
        cycle_id: effectiveCycleId,
        shard_id: SHARD_INDEX ?? 0,
        expected_shards: TOTAL_SHARDS ?? 1,
      };

      const runRecord: Record<string, any> = {
        started_at: summary.startedAt,
        finished_at: summary.completedAt,
        duration_seconds: summary.durationSeconds,
        companies_processed: summary.sources.length,
        total_active: summary.totalInserted + summary.totalUpdated,
        total_verified: summary.sources
          .filter((s) => s.type === 'greenhouse' || s.type === 'lever' || s.type === 'ashby')
          .reduce((acc, s) => acc + s.inserted + s.updated, 0),
        per_source_counts: {
          ...summary.sources.reduce(
            (acc, s) => ({ ...acc, [s.sourceId]: s.inserted + s.updated }),
            {}
          ),
          coverage: coverageData,
        },
        status: summary.totalFailed > 0 ? (summary.totalInserted > 0 ? 'warning' : 'failed') : 'success',
      };

      if (hasCoverageColumn) {
        runRecord.coverage = coverageData;
      }

      await supabase.from('ingest_runs').insert([runRecord]);
    } catch {
      // Ignore
    }
  }

  // Refresh planner statistics after the bulk load (Database row #73,
  // migration 20261106q). Fail-open: until the migration is applied the
  // function is missing - warn and skip without failing the run.
  if (supabase && !isDryRun) {
    try {
      const { error: analyzeError } = await supabase.rpc('analyze_after_ingest');
      if (analyzeError) {
        if (/could not find|does not exist|function|PGRST202/i.test(analyzeError.message)) {
          console.log('- Skipping post-ingest ANALYZE: analyze_after_ingest is not applied yet (migration 20261106q_analyze_after_ingest.sql).');
        } else {
          console.warn(`- Post-ingest ANALYZE RPC error (non-fatal): ${analyzeError.message}`);
        }
      } else {
        console.log('Post-ingest ANALYZE: jobs, job_descriptions, companies refreshed.');
      }
    } catch (analyzeEx) {
      console.warn(`- Post-ingest ANALYZE failed (non-fatal): ${analyzeEx}`);
    }
  }

  // Print Summary Table
  console.log(`\n======================================================`);
  console.log(`📊 INGESTION SUMMARY REPORT`);
  console.log(`======================================================`);
  console.table(
    summary.sources.map((s) => ({
      Source: s.sourceName,
      Type: s.type,
      Fetched: s.fetched,
      Valid: s.normalized,
      Upserted: s.inserted,
      Skipped: s.skipped,
      Errors: s.failed,
    }))
  );

  console.log(`Total Fetched:    ${summary.totalFetched}`);
  console.log(`Total Upserted:   ${summary.totalInserted} ${isDryRun ? '(dry-run)' : ''}`);
  console.log(`Total Skipped:    ${summary.totalSkipped}`);
  console.log(`Total Errors:     ${summary.totalFailed}`);
  if (!isSkipCleanup && supabase) {
    console.log(`Expired Marked:   ${summary.cleanup.markedExpired}`);
    console.log(`Purged Deleted:   ${summary.cleanup.permanentlyDeleted}`);
  }
  console.log(`Duration:         ${summary.durationSeconds}s`);
  console.log(`======================================================\n`);

  if (summary.totalFailed > 0) {
    console.error(`❌ [Ingest Failure] Shard encountered ${summary.totalFailed} source failures. Exiting non-zero.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal Ingestion Pipeline Failure:', err);
  process.exit(1);
});
