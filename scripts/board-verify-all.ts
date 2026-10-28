/**
 * scripts/board-verify-all.ts
 *
 * High-Scale ATS Candidate Verification Engine (Greenhouse, Lever, Ashby).
 *
 * Operational Locks & Rules:
 * - Reads candidate tokens from data/ats-candidates-all.json.
 * - Supports --resume, --offset <n>, --limit <n> (defaults to 500).
 * - Checkpoint mechanism (data/ats-verify-checkpoint.json, gitignored):
 *     * Stores per-candidate completed and failure keys only (no shared counter/offset).
 *     * --resume scans candidates and never skips untested candidates.
 *     * Real 404 / 0 active jobs get a 7-day TTL.
 *     * Transient errors (network, 429, 5xx, timeout) get a 1-hour TTL and are automatically retried.
 * - Hosts run in parallel (Greenhouse, Lever, Ashby) with strict 1 req/s per host pacing.
 * - User-Agent: CareerMonkeBot/1.0.
 * - Respects 429 with Retry-After backoff.
 * - Verified rule: Documented public ATS API HTTP 200 AND job_count >= 1.
 * - Company names: Extracted from real ATS response if available, else candidate.company or null. Never inferred from token.
 * - Persists verified tokens to data/ats-candidates.json.
 * - Prints comprehensive audit stats: tested, verified per ATS, rejected (404/0 jobs/error),
 *   estimated total jobs, India jobs, remote jobs, and elapsed time.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { buildAtsApiUrl, isAuthorizedAtsUrl } from './board-ingest';
import { politeFetchJson, politeFetchText, isForbiddenDomain, sleep } from './utils/polite-fetch';
import { sanitizeToken, AtsType, DiscoverySource } from './board-discovery';
import { detectRemote, detectCountryCode } from './utils/sanitizer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// TTL configurations per failure classification
export const TRANSIENT_FAILURE_TTL_MS = 60 * 60 * 1000; // 1 hour for network, 429, 5xx, timeouts
export const PERMANENT_FAILURE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for real 404 and 0 active jobs

export interface RawCandidateEntry {
  company: string | null;
  ats: AtsType;
  token: string;
  discovery_source: DiscoverySource;
}

export interface VerifiedCandidateRecord {
  company: string | null;
  ats: AtsType;
  token: string;
  job_count: number;
  india_job_count: number;
  remote_job_count: number;
  verified_at: string;
  discovery_source: DiscoverySource;
}

export interface CheckpointRecord {
  updated_at: string;
  completed: Record<string, {
    verified: boolean;
    job_count: number;
    india_jobs: number;
    remote_jobs: number;
    company: string | null;
    status: number;
    checked_at: string;
  }>;
  failures: Record<string, {
    status: number;
    error: string;
    checked_at: string;
    ttl_expires_at: string;
    transient: boolean;
  }>;
}

export interface VerifyAllOptions {
  limit?: number;
  offset?: number;
  resume?: boolean;
  candidatesPath?: string;
  outputPath?: string;
  checkpointPath?: string;
}

export interface VerifyMetrics {
  tested: number;
  verified: number;
  verifiedPerAts: Record<AtsType, number>;
  rejectedTotal: number;
  rejected404: number;
  rejectedZeroJobs: number;
  rejectedErrors: number;
  estimatedTotalJobs: number;
  indiaJobs: number;
  remoteJobs: number;
  elapsedSeconds: number;
}

/**
 * Loads checkpoint file or initializes an empty one.
 * Stores per-candidate completed and failure keys only (no offset counter).
 */
export function loadCheckpoint(checkpointFilePath: string): CheckpointRecord {
  if (fs.existsSync(checkpointFilePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(checkpointFilePath, 'utf-8'));
      return {
        updated_at: parsed.updated_at || new Date().toISOString(),
        completed: parsed.completed || {},
        failures: parsed.failures || {},
      };
    } catch {
      // Corrupt checkpoint fallback
    }
  }
  return {
    updated_at: new Date().toISOString(),
    completed: {},
    failures: {},
  };
}

/**
 * Safely saves checkpoint to disk.
 */
export function saveCheckpoint(checkpointFilePath: string, checkpoint: CheckpointRecord): void {
  try {
    checkpoint.updated_at = new Date().toISOString();
    const tempPath = `${checkpointFilePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(checkpoint, null, 2), 'utf-8');
    fs.renameSync(tempPath, checkpointFilePath);
  } catch (err: any) {
    console.warn(`   ⚠️ Checkpoint save warning: ${err.message}`);
  }
}

/**
 * Verifies a candidate token and computes job metrics (total, India, remote).
 */
export async function verifyAtsTokenWithMetrics(
  ats: AtsType,
  token: string
): Promise<{
  verified: boolean;
  status: number;
  jobCount: number;
  indiaCount: number;
  remoteCount: number;
  companyName: string | null;
  error?: string;
}> {
  const cleanTok = sanitizeToken(token);
  if (!cleanTok) {
    return {
      verified: false,
      status: 400,
      jobCount: 0,
      indiaCount: 0,
      remoteCount: 0,
      companyName: null,
      error: 'Malformed or numeric-only token',
    };
  }

  let url: string;
  try {
    url = buildAtsApiUrl(ats, cleanTok);
  } catch (err: any) {
    return {
      verified: false,
      status: 400,
      jobCount: 0,
      indiaCount: 0,
      remoteCount: 0,
      companyName: null,
      error: err.message,
    };
  }

  if (!isAuthorizedAtsUrl(url, ats)) {
    return {
      verified: false,
      status: 403,
      jobCount: 0,
      indiaCount: 0,
      remoteCount: 0,
      companyName: null,
      error: 'Forbidden or unauthorized ATS URL',
    };
  }

  try {
    let data: any;
    if (ats === 'teamtailor' || ats === 'personio') {
      data = await politeFetchText(url, { retries: 0 });
    } else {
      data = await politeFetchJson<any>(url, { retries: 0 });
    }
    if (!data) {
      return {
        verified: false,
        status: 404,
        jobCount: 0,
        indiaCount: 0,
        remoteCount: 0,
        companyName: null,
        error: 'Empty or not found (404)',
      };
    }

    let jobCount = 0;
    let indiaCount = 0;
    let remoteCount = 0;
    let companyName: string | null = null;

    if (ats === 'greenhouse') {
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
      jobCount = rawJobs.length;
      if (rawJobs.length > 0 && rawJobs[0]?.company_name) {
        companyName = String(rawJobs[0].company_name).trim() || null;
      }
      for (const j of rawJobs) {
        const title = j.title || '';
        const loc = j.location?.name || '';
        if (detectRemote(title, loc)) remoteCount++;
        if (detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'lever') {
      const rawPostings = Array.isArray(data) ? data : [];
      jobCount = rawPostings.length;
      for (const p of rawPostings) {
        const title = p.text || '';
        const loc = p.categories?.location || '';
        const isRemote = p.workplaceType === 'remote' || detectRemote(title, loc);
        if (isRemote) remoteCount++;
        if (detectCountryCode(loc) === 'IN' || p.country === 'in' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'ashby') {
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.title || '';
        const loc = j.location || '';
        const isRemote = j.isRemote || j.workplaceType === 'Remote' || detectRemote(title, loc);
        if (isRemote) remoteCount++;
        const isIndia = detectCountryCode(loc) === 'IN' ||
          (Array.isArray(j.secondaryLocations) && j.secondaryLocations.some((l: any) => detectCountryCode(l.location) === 'IN')) ||
          /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc);
        if (isIndia) indiaCount++;
      }
    } else if (ats === 'workable') {
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.title || '';
        const loc = [j.city, j.country, j.countryCode].filter(Boolean).join(', ');
        if (j.telecommuting || detectRemote(title, loc)) remoteCount++;
        if (j.countryCode === 'IN' || detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'smartrecruiters') {
      const rawJobs = Array.isArray(data.content) ? data.content : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.name || '';
        const loc = [j.location?.city, j.location?.region, j.location?.country].filter(Boolean).join(', ');
        if (j.location?.remote || detectRemote(title, loc)) remoteCount++;
        if (j.location?.country?.toLowerCase() === 'in' || detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'recruitee') {
      const rawJobs = Array.isArray(data.offers) ? data.offers : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.title || '';
        const loc = [j.city, j.country_code, j.location].filter(Boolean).join(', ');
        if (j.remote || detectRemote(title, loc)) remoteCount++;
        if (j.country_code?.toUpperCase() === 'IN' || detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'breezy') {
      const rawJobs = Array.isArray(data) ? data : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.name || '';
        const loc = [j.location?.name, j.location?.country?.name].filter(Boolean).join(', ');
        if (detectRemote(title, loc)) remoteCount++;
        if (j.location?.country?.code?.toUpperCase() === 'IN' || detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'teamtailor') {
      // Data might be XML string or parsed json
      const xmlStr = typeof data === 'string' ? data : '';
      const items = xmlStr.match(/<item[\s\S]*?<\/item>/gi) || [];
      jobCount = items.length;
      for (const it of items) {
        if (/remote/i.test(it)) remoteCount++;
        if (/india|bengaluru|bangalore/i.test(it)) indiaCount++;
      }
    } else if (ats === 'personio') {
      const xmlStr = typeof data === 'string' ? data : '';
      const positions = xmlStr.match(/<position[\s\S]*?<\/position>/gi) || [];
      jobCount = positions.length;
      for (const pos of positions) {
        if (/remote|home[\s_-]?office/i.test(pos)) remoteCount++;
        if (/india|bengaluru|bangalore/i.test(pos)) indiaCount++;
      }
    } else if (ats === 'bamboohr') {
      const rawJobs = Array.isArray(data.result) ? data.result : Array.isArray(data.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.jobOpeningName || j.title || '';
        const loc = [j.location?.city, j.location?.country].filter(Boolean).join(', ');
        if (j.isRemote || detectRemote(title, loc)) remoteCount++;
        if (detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    } else if (ats === 'join') {
      const rawJobs = Array.isArray(data.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      jobCount = rawJobs.length;
      for (const j of rawJobs) {
        const title = j.title || '';
        const loc = j.city || '';
        if (detectRemote(title, loc)) remoteCount++;
        if (detectCountryCode(loc) === 'IN' || /\b(india|bangalore|bengaluru|delhi|mumbai|hyderabad|pune|gurgaon|noida)\b/i.test(loc)) {
          indiaCount++;
        }
      }
    }

    const verified = jobCount >= 1;
    return {
      verified,
      status: 200,
      jobCount,
      indiaCount,
      remoteCount,
      companyName,
      error: verified ? undefined : 'Board returned 0 active jobs',
    };
  } catch (err: any) {
    const is404 = err.message?.includes('404');
    const is429 = err.message?.includes('429');
    const status = is404 ? 404 : is429 ? 429 : 500;
    return {
      verified: false,
      status,
      jobCount: 0,
      indiaCount: 0,
      remoteCount: 0,
      companyName: null,
      error: err.message,
    };
  }
}

/**
 * Runs the large-scale candidate verification pipeline with parallel per-host pacing.
 */
export async function runBoardVerifyAll(options: VerifyAllOptions = {}): Promise<{
  verifiedRecords: VerifiedCandidateRecord[];
  metrics: VerifyMetrics;
}> {
  const startTime = Date.now();
  const {
    limit = 500,
    offset = 0,
    resume = false,
    candidatesPath = path.resolve(__dirname, '../data/ats-candidates-all.json'),
    outputPath = path.resolve(__dirname, '../data/ats-candidates.json'),
    checkpointPath = path.resolve(__dirname, '../data/ats-verify-checkpoint.json'),
  } = options;

  console.log('\n======================================================');
  console.log('🚀 CareerMonke ATS Verification Engine (Resumable)');
  console.log('======================================================');
  console.log(`Candidates Source: ${candidatesPath}`);
  console.log(`Output Registry:   ${outputPath}`);
  console.log(`Checkpoint File:   ${checkpointPath}`);
  console.log(`Limit:             ${limit}`);
  console.log(`Resume Mode:       ${resume}`);
  console.log(`Parallel Pacing:   1 req/s per ATS host (Greenhouse, Lever, Ashby concurrent)`);
  console.log(`User-Agent:        CareerMonkeBot/1.0\n`);

  if (!fs.existsSync(candidatesPath)) {
    throw new Error(`Candidate dataset file not found at ${candidatesPath}`);
  }

  const allCandidates: RawCandidateEntry[] = JSON.parse(fs.readFileSync(candidatesPath, 'utf-8'));
  console.log(`Total candidate tokens in dataset: ${allCandidates.length}`);

  const checkpoint = loadCheckpoint(checkpointPath);

  // Resume scanning logic:
  // Store per-candidate completed keys only.
  // --resume must NEVER skip untested candidates: it iterates through all candidates and checks
  // each against checkpoint.completed and active checkpoint.failures.
  // Do NOT use a shared tested counter as offset.
  const now = Date.now();
  const queueToTest: RawCandidateEntry[] = [];
  const startScanIdx = resume ? 0 : offset;

  for (let i = startScanIdx; i < allCandidates.length; i++) {
    const c = allCandidates[i];
    const key = `${c.ats}:${c.token}`;

    // Skip if already completed and verified
    if (checkpoint.completed[key]?.verified) {
      continue;
    }

    // Skip if failure is still active within its TTL
    const existingFailure = checkpoint.failures[key];
    if (existingFailure && new Date(existingFailure.ttl_expires_at).getTime() > now) {
      continue;
    }

    // Candidate is untested or its transient failure expired -> eligible for test
    queueToTest.push(c);
    if (limit && limit > 0 && queueToTest.length >= limit) {
      break;
    }
  }

  console.log(`Runnable candidates selected for this run: ${queueToTest.length}\n`);

  // Partition candidates by ATS provider to run hosts concurrently (1 req/s per registrable domain)
  const ATS_PROVIDERS: AtsType[] = [
    'greenhouse',
    'lever',
    'ashby',
    'workable',
    'smartrecruiters',
    'recruitee',
    'breezy',
    'teamtailor',
    'personio',
    'bamboohr',
    'join',
  ];

  const queuesByAts = new Map<AtsType, RawCandidateEntry[]>();
  for (const ats of ATS_PROVIDERS) {
    queuesByAts.set(ats, []);
  }
  for (const c of queueToTest) {
    const q = queuesByAts.get(c.ats);
    if (q) q.push(c);
  }

  console.log(`Worker partition queues (1 req/s per registrable domain):`);
  for (const ats of ATS_PROVIDERS) {
    const qLen = queuesByAts.get(ats)?.length || 0;
    if (qLen > 0) {
      console.log(`  - ${ats}: ${qLen}`);
    }
  }
  console.log('');

  // Metrics trackers
  let testedCount = 0;
  let verifiedCount = 0;
  const verifiedPerAts: Record<string, number> = {};
  for (const ats of ATS_PROVIDERS) {
    verifiedPerAts[ats] = 0;
  }
  let rejected404 = 0;
  let rejectedZeroJobs = 0;
  let rejectedErrors = 0;
  let estimatedTotalJobs = 0;
  let indiaJobs = 0;
  let remoteJobs = 0;

  const newVerifiedRecords: VerifiedCandidateRecord[] = [];

  // Load existing verified records from output file to merge
  const existingOutputRecords: VerifiedCandidateRecord[] = fs.existsSync(outputPath)
    ? JSON.parse(fs.readFileSync(outputPath, 'utf-8'))
    : [];
  const existingOutputMap = new Map<string, VerifiedCandidateRecord>();
  for (const r of existingOutputRecords) {
    existingOutputMap.set(`${r.ats}:${r.token}`, r);
  }

  // Checkpoint counter across all workers (saves every 25 tokens)
  let processedSinceLastCheckpoint = 0;

  function triggerCheckpointCheck() {
    processedSinceLastCheckpoint++;
    if (processedSinceLastCheckpoint >= 25) {
      saveCheckpoint(checkpointPath, checkpoint);
      processedSinceLastCheckpoint = 0;
    }
  }

  // Worker implementation for a single ATS host
  async function runHostWorker(queue: RawCandidateEntry[], atsName: AtsType) {
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      const key = `${item.ats}:${item.token}`;
      testedCount++;

      try {
        const result = await verifyAtsTokenWithMetrics(item.ats, item.token);

        if (result.verified && result.jobCount >= 1) {
          verifiedCount++;
          verifiedPerAts[item.ats] = (verifiedPerAts[item.ats] || 0) + 1;
          estimatedTotalJobs += result.jobCount;
          indiaJobs += result.indiaCount;
          remoteJobs += result.remoteCount;

          const record: VerifiedCandidateRecord = {
            company: result.companyName || item.company || null,
            ats: item.ats,
            token: item.token,
            job_count: result.jobCount,
            india_job_count: result.indiaCount,
            remote_job_count: result.remoteCount,
            verified_at: new Date().toISOString(),
            discovery_source: item.discovery_source,
          };

          newVerifiedRecords.push(record);
          existingOutputMap.set(key, record);

          checkpoint.completed[key] = {
            verified: true,
            job_count: result.jobCount,
            india_jobs: result.indiaCount,
            remote_jobs: result.remoteCount,
            company: record.company,
            status: result.status,
            checked_at: new Date().toISOString(),
          };

          // Remove from failures if previously recorded
          delete checkpoint.failures[key];

          console.log(`   ✅ [${atsName.toUpperCase()}] ${record.company || item.token} (${item.token}): VERIFIED (${result.jobCount} jobs, ${result.indiaCount} IN, ${result.remoteCount} remote)`);
        } else {
          // Failure classification:
          // Only real 404 / 0 active jobs get the 7-day TTL.
          // Transient errors (network, 429, 5xx, timeout) get a 1-hour TTL and are retried.
          const isReal404 = result.status === 404;
          const isZeroJobs = result.status === 200 && result.jobCount === 0;
          const isPermanent = isReal404 || isZeroJobs;

          if (isReal404) rejected404++;
          else if (isZeroJobs) rejectedZeroJobs++;
          else rejectedErrors++;

          const ttlMs = isPermanent ? PERMANENT_FAILURE_TTL_MS : TRANSIENT_FAILURE_TTL_MS;
          const ttlExpiresAt = new Date(Date.now() + ttlMs).toISOString();

          checkpoint.failures[key] = {
            status: result.status,
            error: result.error || (isReal404 ? '404 Not Found' : isZeroJobs ? '0 active jobs' : 'Error'),
            checked_at: new Date().toISOString(),
            ttl_expires_at: ttlExpiresAt,
            transient: !isPermanent,
          };

          const reason = isReal404 ? '404' : isZeroJobs ? '0 jobs' : `${result.status || 'error'} (${result.error})`;
          console.log(`   ❌ [${atsName.toUpperCase()}] ${item.token}: REJECTED (${reason}) - TTL ${isPermanent ? '7d' : '1h'}`);
        }
      } catch (err: any) {
        rejectedErrors++;
        const ttlExpiresAt = new Date(Date.now() + TRANSIENT_FAILURE_TTL_MS).toISOString();
        checkpoint.failures[key] = {
          status: 500,
          error: err.message,
          checked_at: new Date().toISOString(),
          ttl_expires_at: ttlExpiresAt,
          transient: true,
        };
        console.warn(`   ⚠️ [${atsName.toUpperCase()}] ${item.token}: Error (${err.message}) - TTL 1h`);
      }

      triggerCheckpointCheck();
    }
  }

  // Execute per-host workers in parallel (each paced at 1 req/s per registrable domain)
  console.log(`🚀 Starting concurrent host workers...\n`);
  const activeWorkers = ATS_PROVIDERS
    .filter((ats) => (queuesByAts.get(ats)?.length || 0) > 0)
    .map((ats) => runHostWorker(queuesByAts.get(ats)!, ats));

  await Promise.all(activeWorkers);

  // Final checkpoint save (stores completed keys and failures only)
  saveCheckpoint(checkpointPath, checkpoint);

  // Write updated verified candidates to output file
  const finalVerifiedList = Array.from(existingOutputMap.values());
  fs.writeFileSync(outputPath, JSON.stringify(finalVerifiedList, null, 2), 'utf-8');

  const elapsedSeconds = Math.round((Date.now() - startTime) / 1000);
  const rejectedTotal = rejected404 + rejectedZeroJobs + rejectedErrors;

  const metrics: VerifyMetrics = {
    tested: testedCount,
    verified: verifiedCount,
    verifiedPerAts,
    rejectedTotal,
    rejected404,
    rejectedZeroJobs,
    rejectedErrors,
    estimatedTotalJobs,
    indiaJobs,
    remoteJobs,
    elapsedSeconds,
  };

  // Structured Final Summary Report
  console.log('\n======================================================');
  console.log('📊 ATS VERIFICATION BATCH SUMMARY REPORT');
  console.log('======================================================');
  console.log(`Candidates Tested:            ${metrics.tested}`);
  console.log(`Candidates Verified:          ${metrics.verified} (${metrics.tested > 0 ? Math.round((metrics.verified / metrics.tested) * 100) : 0}% success rate)`);
  console.log(`Verified per ATS:`);
  for (const [atsName, vCount] of Object.entries(metrics.verifiedPerAts)) {
    if (vCount > 0 || (queuesByAts.get(atsName as AtsType)?.length || 0) > 0) {
      console.log(`  - ${atsName.padEnd(16)}: ${vCount}`);
    }
  }
  console.log(`Rejected Total:               ${metrics.rejectedTotal}`);
  console.log(`  - 404 Not Found:            ${metrics.rejected404}`);
  console.log(`  - 0 Active Jobs:            ${metrics.rejectedZeroJobs}`);
  console.log(`  - Other Errors / Timeout:   ${metrics.rejectedErrors}`);
  console.log(`Estimated Total Jobs:         ${metrics.estimatedTotalJobs}`);
  console.log(`India Jobs:                   ${metrics.indiaJobs}`);
  console.log(`Remote Jobs:                  ${metrics.remoteJobs}`);
  console.log(`Time Taken:                   ${metrics.elapsedSeconds}s (${Math.round(metrics.elapsedSeconds / 60 * 10) / 10} min)`);
  console.log(`Total Verified in Registry:   ${finalVerifiedList.length} (${outputPath})`);
  console.log(`Completed Keys in Checkpoint: ${Object.keys(checkpoint.completed).length}`);
  console.log(`Active Failures in Checkpoint:${Object.keys(checkpoint.failures).length}`);
  console.log('======================================================\n');

  return { verifiedRecords: newVerifiedRecords, metrics };
}

// Direct CLI invocation
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const args = process.argv.slice(2);
  const limitIdx = args.findIndex((a) => a === '--limit');
  const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 500;

  const offsetIdx = args.findIndex((a) => a === '--offset');
  const offset = offsetIdx !== -1 ? parseInt(args[offsetIdx + 1], 10) : 0;

  const resume = args.includes('--resume');

  runBoardVerifyAll({ limit, offset, resume })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal Verification Error:', err);
      process.exit(1);
    });
}
