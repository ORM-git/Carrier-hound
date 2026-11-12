import { SupabaseClient } from '@supabase/supabase-js';
import { extractRunCoverage } from '../src/lib/observability/sourceHealth';

export interface UnseenCleanupSafetyCheckParams {
  isScheduled: boolean;
  isSeed: boolean;
  sourceFilter: string | null;
  capArgPresent: boolean;
  capValue: number;
  expectedShards?: number;
  runs?: readonly any[];
  cycleId?: string | null;
}

/**
 * Determines whether destructive unseen expiration cleanup is safe to perform.
 * Per reviewer rules: Only do global unseen cleanup for a complete scheduled corpus
 * run (all 6 shards, no source filter, no cap, scheduled mode). Otherwise skip unseen cleanup.
 */
export function shouldPerformUnseenCleanup(params: UnseenCleanupSafetyCheckParams): {
  allowed: boolean;
  reason: string;
} {
  // 1. Scheduled mode: must be scheduled, not seed
  if (params.isSeed) {
    return { allowed: false, reason: "Partial manual run: mode is 'seed' (not scheduled)." };
  }
  if (!params.isScheduled) {
    return { allowed: false, reason: "Partial manual run: mode is not 'scheduled'." };
  }

  // 2. No source filter
  if (params.sourceFilter) {
    return { allowed: false, reason: `Partial manual run: source filter active ('${params.sourceFilter}').` };
  }

  // 3. No cap: low cap (< 50000)
  if (params.capArgPresent && params.capValue < 50000) {
    return { allowed: false, reason: `Partial manual run: low job cap active (${params.capValue} < 50000).` };
  }

  // 4. All 6 shards complete and successful
  const expectedShards = params.expectedShards ?? 6;
  if (!params.runs || params.runs.length === 0) {
    return { allowed: false, reason: "Incomplete run: no ingest_runs recorded for cycle." };
  }

  // Filter runs for the given cycleId if specified
  const cycleRuns = params.cycleId
    ? params.runs.filter((r) => {
        const cov = extractRunCoverage(r);
        return cov?.cycle_id === params.cycleId;
      })
    : params.runs;

  const shardMap = new Map<number, any>();
  for (const r of cycleRuns) {
    const cov = extractRunCoverage(r);
    const sId = typeof cov?.shard_id === "number" ? cov.shard_id : 0;
    const existing = shardMap.get(sId);
    if (!existing || r.status === "success") {
      shardMap.set(sId, r);
    }
  }

  const missingShards: number[] = [];
  for (let s = 0; s < expectedShards; s++) {
    if (!shardMap.has(s)) {
      missingShards.push(s);
    }
  }
  if (missingShards.length > 0) {
    return {
      allowed: false,
      reason: `Incomplete scheduled run: expected ${expectedShards} shards, received ${shardMap.size} (missing shard(s): ${missingShards.join(", ")}).`,
    };
  }

  const nonSuccessShards: number[] = [];
  shardMap.forEach((r, sId) => {
    if (r.status !== "success") {
      nonSuccessShards.push(sId);
    }
  });
  if (nonSuccessShards.length > 0) {
    return {
      allowed: false,
      reason: `Incomplete scheduled run: non-success or failing shard(s): ${nonSuccessShards.join(", ")}.`,
    };
  }

  return {
    allowed: true,
    reason: `Complete scheduled corpus run verified (${expectedShards}/${expectedShards} shards successful).`,
  };
}

export interface CleanupConfig {
  unseenExpiryDays?: number; // default: 7 days
  maxPostedDays?: number; // default: 45 days
  permanentDeleteDays?: number; // default: 14 days
  dryRun?: boolean;
  skipUnseenCheck?: boolean; // destructive safety: skips last_seen_at expiration during seed/partial runs
}

export interface CleanupResult {
  markedExpired: number;
  permanentlyDeleted: number;
  preservedBoardJobs?: number;
}

const ATS_SOURCES = new Set([
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
  'greenhouse-board',
  'lever-board',
  'ashby-board',
  'workable-board',
  'smartrecruiters-board',
  'recruitee-board',
  'breezy-board',
  'teamtailor-board',
  'personio-board',
  'bamboohr-board',
  'join-board',
]);

/**
 * Determines whether a job originates from an official employer ATS board.
 */
export function isAtsJob(job: { source?: string; source_type?: string }): boolean {
  if (job.source_type === 'ats') return true;
  if (!job.source) return false;
  const s = job.source.toLowerCase();
  if (ATS_SOURCES.has(s)) return true;
  if (s.endsWith('-board')) {
    const base = s.slice(0, -6);
    if (ATS_SOURCES.has(base)) return true;
  }
  return false;
}

/**
 * Runs cleanup rules:
 * 1. Mark jobs inactive/expired if expires_at < now OR last_seen_at < 7d ago OR posted_at < 45d ago.
 *    Special rule for ATS board jobs: Open board jobs that are still actively listed on the employer's
 *    board (last_seen_at >= unseenCutoff) are preserved and NOT wrongly expired by the 45-day rule.
 * 2. Permanently delete inactive jobs where last_seen_at < 14d ago.
 */
export async function runJobCleanup(
  supabase: SupabaseClient,
  config: CleanupConfig = {}
): Promise<CleanupResult> {
  const {
    unseenExpiryDays = 7,
    maxPostedDays = 45,
    permanentDeleteDays = 14,
    dryRun = false,
    skipUnseenCheck = false,
  } = config;

  const now = new Date();
  const unseenCutoff = new Date(now.getTime() - unseenExpiryDays * 24 * 60 * 60 * 1000).toISOString();
  const postedCutoff = new Date(now.getTime() - maxPostedDays * 24 * 60 * 60 * 1000).toISOString();
  const deleteCutoff = new Date(now.getTime() - permanentDeleteDays * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  console.log(`\n🧹 [Cleanup] Running expiration & retention checks...`);
  if (skipUnseenCheck) {
    console.log(`   - Unseen cutoff: SKIPPED (destructive safety active: partial/seed/incomplete run)`);
  } else {
    console.log(`   - Unseen cutoff: ${unseenCutoff} (${unseenExpiryDays} days)`);
  }
  console.log(`   - Max age cutoff: ${postedCutoff} (${maxPostedDays} days)`);
  console.log(`   - Permanent purge cutoff: ${deleteCutoff} (${permanentDeleteDays} days)`);

  let markedExpired = 0;
  let permanentlyDeleted = 0;

  // Find active jobs that meet expiration criteria
  let expiredJobs: any[] | null = null;
  let selectExpiredError: any = null;

  const orFilter = skipUnseenCheck
    ? `expires_at.lt.${nowIso},posted_at.lt.${postedCutoff}`
    : `expires_at.lt.${nowIso},last_seen_at.lt.${unseenCutoff},posted_at.lt.${postedCutoff}`;

  const res = await supabase
    .from('jobs')
    .select('id, title, company, source, source_type, last_seen_at, posted_at, expires_at')
    .eq('is_active', true)
    .or(orFilter)
    .limit(1000);

  if (res.error && res.error.message.includes('does not exist')) {
    console.warn(`   ⚠️ [Cleanup] Notice: 'is_active' or 'posted_at' column not yet migrated. Falling back to status='active'.`);
    if (skipUnseenCheck) {
      console.log(`   ✨ [Cleanup] Unseen check skipped under destructive safety.`);
      expiredJobs = [];
      selectExpiredError = null;
    } else {
      const fallbackRes = await supabase
        .from('jobs')
        .select('id, title, company, source, source_type, last_seen_at')
        .eq('status', 'active')
        .lt('last_seen_at', unseenCutoff)
        .limit(1000);
      expiredJobs = fallbackRes.data;
      selectExpiredError = fallbackRes.error;
    }
  } else {
    expiredJobs = res.data;
    selectExpiredError = res.error;
  }

  const jobsToExpire: any[] = [];
  const preservedBoardJobs: any[] = [];

  if (selectExpiredError) {
    console.error(`❌ [Cleanup] Failed to query expired jobs:`, selectExpiredError.message);
  } else if (expiredJobs && expiredJobs.length > 0) {
    for (const job of expiredJobs) {
      const isAts = isAtsJob(job);
      let shouldExpire = false;
      let reason = '';

      // 1. Explicit expiration timestamp passed
      if (job.expires_at && job.expires_at < nowIso) {
        shouldExpire = true;
        reason = `expires_at (${job.expires_at}) < now`;
      }
      // 2. Unseen for unseenExpiryDays (vanished from source / board)
      else if (!skipUnseenCheck && job.last_seen_at && job.last_seen_at < unseenCutoff) {
        shouldExpire = true;
        reason = `last_seen_at (${job.last_seen_at}) < ${unseenCutoff} (${unseenExpiryDays}d unseen)`;
      }
      // 3. posted_at older than maxPostedDays
      else if (job.posted_at && job.posted_at < postedCutoff) {
        if (isAts) {
          // Open ATS board job protection: If this job was seen recently on the employer's board,
          // it is an active opening that the employer chose to keep live. Do not expire it!
          if (!skipUnseenCheck && job.last_seen_at && job.last_seen_at >= unseenCutoff) {
            preservedBoardJobs.push({
              id: job.id,
              title: job.title,
              company: job.company,
              source: job.source,
              posted_at: job.posted_at,
              last_seen_at: job.last_seen_at,
              reason: `Active open board job (last seen ${job.last_seen_at} >= cutoff; employer still listing role)`,
            });
            continue;
          }
        }
        // Non-ATS sources (or unseen ATS): apply 45-day rule
        shouldExpire = true;
        reason = `posted_at (${job.posted_at}) < ${postedCutoff} (${maxPostedDays}d max age)`;
      }

      if (shouldExpire) {
        jobsToExpire.push({ ...job, expiration_reason: reason });
      }
    }

    if (preservedBoardJobs.length > 0) {
      console.log(`\n🛡️ [Cleanup] Protected ${preservedBoardJobs.length} open board jobs from 45-day posted_at expiration:`);
      for (const p of preservedBoardJobs) {
        console.log(`   - [PRESERVED] "${p.title}" at ${p.company} (${p.source}) | posted: ${p.posted_at} | last_seen: ${p.last_seen_at}`);
      }
    }

    if (jobsToExpire.length > 0) {
      console.log(`\n📋 [Cleanup] Listing ${jobsToExpire.length} active jobs to be deactivated/expired:`);
      for (const j of jobsToExpire) {
        console.log(`   - [EXPIRE] "${j.title}" at ${j.company} (${j.source}) | reason: ${j.expiration_reason}`);
      }

      markedExpired = jobsToExpire.length;

      if (!dryRun) {
        const idsToExpire = jobsToExpire.map((j) => j.id);
        const chunkSize = 200;
        for (let i = 0; i < idsToExpire.length; i += chunkSize) {
          const chunk = idsToExpire.slice(i, i + chunkSize);
          const updatePayload: Record<string, any> = { status: 'expired' };
          if (!res.error) updatePayload.is_active = false;

          const { error: updateError } = await supabase
            .from('jobs')
            .update(updatePayload)
            .in('id', chunk);

          if (updateError) {
            console.error(`❌ [Cleanup] Failed marking batch inactive:`, updateError.message);
          }
        }
        console.log(`   ✅ Marked ${markedExpired} jobs as is_active = false / expired.`);
      } else {
        console.log(`   [DRY RUN] Would mark ${markedExpired} jobs as is_active = false.`);
      }
    } else {
      console.log(`   ✨ No active jobs found matching expiration criteria.`);
    }
  } else {
    console.log(`   ✨ No active jobs found matching expiration criteria.`);
  }

  // Find inactive jobs eligible for permanent deletion
  let purgeJobs: any[] | null = null;
  let selectPurgeError: any = null;

  const purgeRes = await supabase
    .from('jobs')
    .select('id, title, company, source, last_seen_at, status')
    .or(`is_active.eq.false,status.eq.expired`)
    .lt('last_seen_at', deleteCutoff)
    .limit(1000);

  if (purgeRes.error && purgeRes.error.message.includes('does not exist')) {
    const fallbackPurge = await supabase
      .from('jobs')
      .select('id, title, company, source, last_seen_at, status')
      .eq('status', 'expired')
      .lt('last_seen_at', deleteCutoff)
      .limit(1000);
    purgeJobs = fallbackPurge.data;
    selectPurgeError = fallbackPurge.error;
  } else {
    purgeJobs = purgeRes.data;
    selectPurgeError = purgeRes.error;
  }

  if (selectPurgeError) {
    console.error(`❌ [Cleanup] Failed to query purge candidates:`, selectPurgeError.message);
  } else if (purgeJobs && purgeJobs.length > 0) {
    permanentlyDeleted = purgeJobs.length;
    console.log(`\n🗑️ [Cleanup] Listing ${permanentlyDeleted} inactive/expired jobs eligible for permanent deletion (unseen > ${permanentDeleteDays}d):`);
    for (const p of purgeJobs) {
      console.log(`   - [PURGE] "${p.title || p.id}" at ${p.company || 'Unknown'} (${p.source || 'N/A'}) | status: ${p.status} | last_seen: ${p.last_seen_at}`);
    }

    if (!dryRun) {
      const idsToPurge = purgeJobs.map((j) => j.id);
      const chunkSize = 200;
      for (let i = 0; i < idsToPurge.length; i += chunkSize) {
        const chunk = idsToPurge.slice(i, i + chunkSize);
        const { error: deleteError } = await supabase.from('jobs').delete().in('id', chunk);
        if (deleteError) {
          console.error(`❌ [Cleanup] Failed deleting purge batch:`, deleteError.message);
        }
      }
      console.log(`   🗑️ Permanently deleted ${permanentlyDeleted} expired records.`);
    } else {
      console.log(`   [DRY RUN] Would permanently delete ${permanentlyDeleted} records.`);
    }
  } else {
    console.log(`   ✨ No old inactive jobs need permanent purging.`);
  }

  return { markedExpired, permanentlyDeleted, preservedBoardJobs: preservedBoardJobs.length };
}
