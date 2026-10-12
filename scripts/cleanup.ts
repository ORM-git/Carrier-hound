import { SupabaseClient } from '@supabase/supabase-js';

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
}

/**
 * Runs cleanup rules:
 * 1. Mark jobs inactive/expired if expires_at < now OR last_seen_at < 7d ago OR posted_at < 45d ago
 * 2. Permanently delete inactive jobs where last_seen_at < 14d ago
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
  // Condition: is_active = true AND (expires_at < now OR (last_seen_at < unseenCutoff IF not skipped) OR posted_at < postedCutoff)
  let expiredJobs: any[] | null = null;
  let selectExpiredError: any = null;

  const orFilter = skipUnseenCheck
    ? `expires_at.lt.${nowIso},posted_at.lt.${postedCutoff}`
    : `expires_at.lt.${nowIso},last_seen_at.lt.${unseenCutoff},posted_at.lt.${postedCutoff}`;

  const res = await supabase
    .from('jobs')
    .select('id, title, company, last_seen_at, posted_at, expires_at')
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
        .select('id, title, company, last_seen_at')
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

  if (selectExpiredError) {
    console.error(`❌ [Cleanup] Failed to query expired jobs:`, selectExpiredError.message);
  } else if (expiredJobs && expiredJobs.length > 0) {
    markedExpired = expiredJobs.length;
    console.log(`   Found ${markedExpired} active jobs eligible for expiration.`);

    if (!dryRun) {
      const idsToExpire = expiredJobs.map((j) => j.id);
      const chunkSize = 200;
      for (let i = 0; i < idsToExpire.length; i += chunkSize) {
        const chunk = idsToExpire.slice(i, i + chunkSize);
        // Update both is_active and status for complete compatibility
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

  // Find inactive jobs eligible for permanent deletion
  let purgeJobs: any[] | null = null;
  let selectPurgeError: any = null;

  const purgeRes = await supabase
    .from('jobs')
    .select('id')
    .or(`is_active.eq.false,status.eq.expired`)
    .lt('last_seen_at', deleteCutoff)
    .limit(1000);

  if (purgeRes.error && purgeRes.error.message.includes('does not exist')) {
    const fallbackPurge = await supabase
      .from('jobs')
      .select('id')
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
    console.log(`   Found ${permanentlyDeleted} inactive jobs older than retention window.`);

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

  return { markedExpired, permanentlyDeleted };
}
