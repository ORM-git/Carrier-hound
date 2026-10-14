import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { extractSkillsFromJob } from '../src/lib/matcher/scoring';
import { cleanAndTruncateDescription, slugify } from './utils/sanitizer';
import { politeFetchJson } from './utils/polite-fetch';
import { SourceConfig } from './types';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry') || args.includes('-d');
const limitIdx = args.findIndex((a) => a === '--limit' || a === '-l');
const MAX_LIMIT = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;
const BATCH_SIZE = 100;

function getSupabaseClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.error('❌ Supabase credentials missing in environment.');
    process.exit(1);
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Checks if a description text is a short placeholder/stub.
 */
function isStubDescription(desc: string | null | undefined): boolean {
  if (!desc || desc.trim().length === 0) return true;
  if (desc.includes('Apply directly via employer careers portal')) return true;
  if (desc.trim().length < 150) return true;
  return false;
}

/**
 * Stage 1: Ingestion Deduplication on Existing DB Records
 * Normalizes title + company + location and deactivates duplicate rows.
 */
async function deduplicateExistingJobs(supabase: SupabaseClient): Promise<number> {
  console.log('\n--- STAGE 1: Database Ingestion Deduplication ---');
  let dedupedCount = 0;

  // Fetch all active jobs in batches to group by normalized title+company+location
  let offset = 0;
  const pageSize = 1000;
  const roleGroups = new Map<string, Array<{ id: string; last_seen_at: string; descLen: number }>>();

  while (true) {
    const { data: batch, error } = await supabase
      .from('jobs')
      .select('id, company, title, location, last_seen_at, description')
      .eq('is_active', true)
      .range(offset, offset + pageSize - 1);

    if (error) {
      console.error(`Failed reading jobs batch at offset ${offset}:`, error.message);
      break;
    }
    if (!batch || batch.length === 0) break;

    for (const j of batch) {
      const key = `${slugify(j.company)}::${slugify(j.title)}::${slugify(j.location || 'unspecified')}`;
      const list = roleGroups.get(key) || [];
      list.push({
        id: j.id,
        last_seen_at: j.last_seen_at || '',
        descLen: j.description ? j.description.length : 0,
      });
      roleGroups.set(key, list);
    }

    offset += batch.length;
    if (batch.length < pageSize) break;
  }

  const duplicatesToDeactivate: string[] = [];
  for (const [key, group] of roleGroups.entries()) {
    if (group.length > 1) {
      // Sort group: prefer row with full description, then latest last_seen_at
      group.sort((a, b) => {
        if (b.descLen !== a.descLen) return b.descLen - a.descLen;
        return b.last_seen_at.localeCompare(a.last_seen_at);
      });
      // Keep first (primary), mark rest as duplicates
      for (let i = 1; i < group.length; i++) {
        duplicatesToDeactivate.push(group[i].id);
      }
    }
  }

  console.log(`Found ${duplicatesToDeactivate.length} duplicate active rows across ${roleGroups.size} unique roles.`);

  if (duplicatesToDeactivate.length > 0) {
    dedupedCount = duplicatesToDeactivate.length;
    if (isDryRun) {
      console.log(`[DRY RUN] Would mark ${dedupedCount} duplicate rows as is_active = false / expired.`);
    } else {
      for (let i = 0; i < duplicatesToDeactivate.length; i += BATCH_SIZE) {
        const chunk = duplicatesToDeactivate.slice(i, i + BATCH_SIZE);
        const { error } = await supabase
          .from('jobs')
          .update({
            is_active: false,
            status: 'expired',
            expires_at: new Date().toISOString(),
          })
          .in('id', chunk);

        if (error) {
          console.error(`Error deactivating duplicates chunk:`, error.message);
        }
      }
      console.log(`✅ Deactivated ${dedupedCount} duplicate jobs.`);
    }
  }

  return dedupedCount;
}

/**
 * Stage 2: Backfill from job_descriptions table
 * Thousands of jobs already have full description text in job_descriptions table,
 * but were not copied to jobs.description due to historical offloading.
 */
async function backfillFromJobDescriptionsTable(supabase: SupabaseClient): Promise<number> {
  console.log('\n--- STAGE 2: Backfill from job_descriptions table ---');
  let backfilledCount = 0;
  let offset = 0;

  while (true) {
    if (MAX_LIMIT && backfilledCount >= MAX_LIMIT) break;

    // Fetch batch of jobs with null or stub descriptions
    const { data: stubJobs, error } = await supabase
      .from('jobs')
      .select('id, title, company, category, description')
      .or('description.is.null,description.ilike.%Apply directly via employer careers portal%')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error('Error fetching stub jobs:', error.message);
      break;
    }
    if (!stubJobs || stubJobs.length === 0) break;

    const jobIds = stubJobs.map((j) => j.id);
    const { data: descRows } = await supabase
      .from('job_descriptions')
      .select('job_id, description_text')
      .in('job_id', jobIds);

    const descMap = new Map((descRows || []).map((d) => [d.job_id, d.description_text]));
    let batchUpdates = 0;

    for (const job of stubJobs) {
      const fullText = descMap.get(job.id);
      if (fullText && !isStubDescription(fullText)) {
        const cleanedDesc = cleanAndTruncateDescription(fullText, 4000) || fullText.slice(0, 4000);
        const skills = extractSkillsFromJob({
          title: job.title,
          description: cleanedDesc,
          category: job.category,
        });

        if (!isDryRun) {
          const { error: updErr } = await supabase
            .from('jobs')
            .update({
              description: cleanedDesc,
              skills: skills,
            })
            .eq('id', job.id);

          if (!updErr) {
            backfilledCount++;
            batchUpdates++;
          }
        } else {
          backfilledCount++;
          batchUpdates++;
        }
      }
    }

    console.log(`Processed batch ${offset / BATCH_SIZE + 1}: ${batchUpdates} jobs backfilled from job_descriptions.`);
    offset += BATCH_SIZE;
    if (stubJobs.length < BATCH_SIZE) break;
  }

  console.log(`✅ Stage 2 complete: ${backfilledCount} jobs backfilled from job_descriptions table.`);
  return backfilledCount;
}

/**
 * Stage 3: Backfill from Live ATS APIs for Verified Seed Companies
 */
async function backfillFromAtsApis(supabase: SupabaseClient): Promise<number> {
  console.log('\n--- STAGE 3: Backfill from Live ATS Source APIs ---');
  let atsBackfilledCount = 0;

  // Load seed companies
  const seedConfigPath = path.resolve(__dirname, 'config/companies-seed.json');
  if (!fs.existsSync(seedConfigPath)) {
    console.warn('companies-seed.json not found, skipping Stage 3.');
    return 0;
  }

  const seedSources: SourceConfig[] = JSON.parse(fs.readFileSync(seedConfigPath, 'utf-8')).filter(
    (s: SourceConfig) => s.enabled
  );

  for (const source of seedSources) {
    if (MAX_LIMIT && atsBackfilledCount >= MAX_LIMIT) break;

    try {
      let remoteJobsWithDesc: Array<{
        title: string;
        location: string;
        description: string;
        apply_url: string;
        source_job_id: string;
      }> = [];

      const slug = source.target.trim().toLowerCase();

      if (source.type === 'greenhouse') {
        const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
        const data = await politeFetchJson<any>(url);
        if (Array.isArray(data?.jobs)) {
          remoteJobsWithDesc = data.jobs.map((j: any) => ({
            title: j.title,
            location: j.location?.name || '',
            description: cleanAndTruncateDescription(j.content, 4000) || '',
            apply_url: j.absolute_url,
            source_job_id: `${slug}-${j.id}`,
          }));
        }
      } else if (source.type === 'ashby') {
        const url = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
        const data = await politeFetchJson<any>(url);
        if (Array.isArray(data?.jobs)) {
          remoteJobsWithDesc = data.jobs.map((j: any) => ({
            title: j.title,
            location: j.location || '',
            description: cleanAndTruncateDescription(j.descriptionPlain || j.descriptionHtml, 4000) || '',
            apply_url: j.applyUrl || j.jobUrl || `https://jobs.ashbyhq.com/${slug}/${j.id}`,
            source_job_id: `${slug}-${j.id}`,
          }));
        }
      } else if (source.type === 'lever') {
        const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
        const data = await politeFetchJson<any>(url);
        if (Array.isArray(data)) {
          remoteJobsWithDesc = data.map((j: any) => ({
            title: j.text,
            location: j.categories?.location || '',
            description: cleanAndTruncateDescription(j.descriptionPlain || j.description, 4000) || '',
            apply_url: j.applyUrl || j.hostedUrl,
            source_job_id: `${slug}-${j.id}`,
          }));
        }
      }

      if (remoteJobsWithDesc.length === 0) continue;

      const cleanCompName = source.name.replace(/\s*\((?:Greenhouse|Lever|Ashby|Workable)\)$/i, '').trim();

      // Query active jobs in DB for this company that have stub/null descriptions
      const { data: dbJobs } = await supabase
        .from('jobs')
        .select('id, title, location, category, apply_url, source_job_id, description')
        .ilike('company', cleanCompName)
        .or('description.is.null,description.ilike.%Apply directly via employer careers portal%');

      if (!dbJobs || dbJobs.length === 0) continue;

      // Match DB jobs against remote ATS jobs
      const urlMap = new Map(remoteJobsWithDesc.map((r) => [r.apply_url, r.description]));
      const idMap = new Map(remoteJobsWithDesc.map((r) => [r.source_job_id, r.description]));
      const roleMap = new Map(
        remoteJobsWithDesc.map((r) => [`${slugify(r.title)}::${slugify(r.location)}`, r.description])
      );

      let companyUpdated = 0;
      for (const dj of dbJobs) {
        const matchedDesc =
          urlMap.get(dj.apply_url) ||
          idMap.get(dj.source_job_id) ||
          roleMap.get(`${slugify(dj.title)}::${slugify(dj.location)}`);

        if (matchedDesc && !isStubDescription(matchedDesc)) {
          const skills = extractSkillsFromJob({
            title: dj.title,
            description: matchedDesc,
            category: dj.category,
          });

          if (!isDryRun) {
            await supabase
              .from('jobs')
              .update({
                description: matchedDesc,
                skills: skills,
              })
              .eq('id', dj.id);

            await supabase
              .from('job_descriptions')
              .upsert({
                job_id: dj.id,
                description_text: matchedDesc,
                updated_at: new Date().toISOString(),
              }, { onConflict: 'job_id' });
          }

          companyUpdated++;
          atsBackfilledCount++;
        }
      }

      if (companyUpdated > 0) {
        console.log(`   [${source.type.toUpperCase()}] ${source.name}: backfilled ${companyUpdated} job descriptions.`);
      }
    } catch (err: any) {
      // Polite handling: skip sources that block or error
      console.warn(`   ⚠️ [ATS Backfill] Skipping ${source.name}: ${err.message}`);
    }
  }

  console.log(`✅ Stage 3 complete: ${atsBackfilledCount} jobs backfilled from live ATS APIs.`);
  return atsBackfilledCount;
}

/**
 * Stage 4: Mark remaining blocked / dead source stubs clearly
 * Skip sources that block fetching; mark those rows clearly instead of leaving stubs.
 */
async function markRemainingStubsClearly(supabase: SupabaseClient): Promise<number> {
  console.log('\n--- STAGE 4: Clear Marking for Remaining Stubs ---');
  let markedCount = 0;

  const CLEAR_MARKER = '[Direct apply via employer portal] Full description available at official posting.';

  let offset = 0;
  while (true) {
    if (MAX_LIMIT && markedCount >= MAX_LIMIT) break;

    const { data: stubs, error } = await supabase
      .from('jobs')
      .select('id, title, category, description')
      .or('description.is.null,description.ilike.%Apply directly via employer careers portal%')
      .range(offset, offset + BATCH_SIZE - 1);

    if (error) {
      console.error('Error querying remaining stubs:', error.message);
      break;
    }
    if (!stubs || stubs.length === 0) break;

    const toMarkIds: string[] = [];
    for (const j of stubs) {
      if (isStubDescription(j.description)) {
        toMarkIds.push(j.id);
      }
    }

    if (toMarkIds.length > 0) {
      if (!isDryRun) {
        for (const j of stubs) {
          const skills = extractSkillsFromJob({
            title: j.title,
            description: CLEAR_MARKER,
            category: j.category,
          });

          await supabase
            .from('jobs')
            .update({
              description: CLEAR_MARKER,
              skills: skills,
            })
            .eq('id', j.id);

          await supabase
            .from('job_descriptions')
            .upsert({
              job_id: j.id,
              description_text: CLEAR_MARKER,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'job_id' });
        }
      }
      markedCount += toMarkIds.length;
    }

    offset += BATCH_SIZE;
    if (stubs.length < BATCH_SIZE) break;
  }

  console.log(`✅ Stage 4 complete: ${markedCount} stub rows clearly marked.`);
  return markedCount;
}

async function main() {
  const startTime = Date.now();
  console.log('======================================================');
  console.log('🔄 CareerMonke Job Description Upgrade & Backfill Runner');
  console.log('======================================================');
  console.log(`Mode: ${isDryRun ? 'DRY RUN (No database writes)' : 'LIVE PRODUCTION'}`);
  if (MAX_LIMIT) console.log(`Limit: Processing up to ${MAX_LIMIT} rows per stage`);
  console.log(`Batch Size: ${BATCH_SIZE}\n`);

  const supabase = getSupabaseClient();

  const deduped = await deduplicateExistingJobs(supabase);
  const backfilledFromTable = await backfillFromJobDescriptionsTable(supabase);
  const backfilledFromAts = await backfillFromAtsApis(supabase);
  const markedStubs = await markRemainingStubsClearly(supabase);

  const durationSec = Math.round((Date.now() - startTime) / 1000);
  console.log('\n======================================================');
  console.log('📊 BACKFILL & DEDUPE SUMMARY REPORT');
  console.log('======================================================');
  console.log(`Duplicate Rows Deactivated:      ${deduped}`);
  console.log(`Backfilled from job_descriptions: ${backfilledFromTable}`);
  console.log(`Backfilled from Live ATS APIs:   ${backfilledFromAts}`);
  console.log(`Blocked Rows Clearly Marked:     ${markedStubs}`);
  console.log(`Duration:                         ${durationSec}s`);
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('Fatal Backfill Failure:', err);
  process.exit(1);
});
