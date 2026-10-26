import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { GreenhouseAdapter } from './adapters/greenhouse';
import { AshbyAdapter } from './adapters/ashby';
import { LeverAdapter } from './adapters/lever';
import { NormalizedJob, SourceConfig } from './types';

// Load environment variables
dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}

export type SupportedSource = 'greenhouse' | 'ashby' | 'lever';

export interface SalaryFields {
  salary_min: number | null;
  salary_max: number | null;
  salary_text: string | null;
  currency: string | null;
  salary_period: 'yearly' | 'monthly' | 'hourly' | null;
}

export interface ExistingJobRecord extends SalaryFields {
  id: string;
  source: SupportedSource;
  source_job_id: string;
  company?: string;
  title?: string;
}

export interface SalaryUpdateCandidate {
  id: string;
  source: SupportedSource;
  source_job_id: string;
  company: string;
  title: string;
  existing: SalaryFields;
  computed: SalaryFields;
}

export interface SampleSalary {
  source: string;
  company: string;
  title: string;
  salary_min: number | null;
  salary_max: number | null;
  currency: string | null;
  salary_period: string | null;
  salary_text: string | null;
}

export interface InvalidSalaryRange {
  source: string;
  company: string;
  title: string;
  salary_min: number;
  salary_max: number;
}

export interface SourceBackfillStats {
  source: string;
  alreadyPopulated: number;
  wouldFill: number;
  noSalary: number;
  minGreaterThanMax: number;
  samples: SampleSalary[];
  invalidRanges: InvalidSalaryRange[];
}

export interface BackfillReport {
  statsBySource: Record<string, SourceBackfillStats>;
  totalAlreadyPopulated: number;
  totalWouldFill: number;
  totalNoSalary: number;
  totalMinGreaterThanMax: number;
  candidatesToUpdate: SalaryUpdateCandidate[];
  samples: SampleSalary[];
  invalidRanges: InvalidSalaryRange[];
}

/**
 * Returns a Supabase client if credentials exist in the environment.
 */
export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Strictly constructs the update payload containing ONLY the 5 salary columns.
 * Guaranteed zero non-salary columns touched.
 */
export function buildUpdatePayload(candidate: SalaryUpdateCandidate): SalaryFields {
  return {
    salary_min: candidate.computed.salary_min,
    salary_max: candidate.computed.salary_max,
    salary_text: candidate.computed.salary_text,
    currency: candidate.computed.currency || 'USD',
    salary_period: candidate.computed.salary_period,
  };
}

/**
 * Evaluates candidate rows for salary backfill with strict safety guards:
 * 1. If existing.salary_min IS NOT NULL, job is categorized as 'alreadyPopulated' and NEVER updated.
 * 2. If existing.salary_min IS NULL and reFetched.salary_min IS NOT NULL, job is categorized as 'wouldFill'.
 * 3. If reFetched.salary_min IS NULL, job is categorized as 'noSalary' and NEVER updated.
 * 4. Flags any min > max inconsistencies for auditing.
 */
export function evaluateBackfillCandidates(
  existingJobs: ExistingJobRecord[],
  reFetchedJobs: NormalizedJob[]
): BackfillReport {
  const sources: SupportedSource[] = ['greenhouse', 'ashby', 'lever'];
  const statsBySource: Record<string, SourceBackfillStats> = {};

  for (const src of sources) {
    statsBySource[src] = {
      source: src,
      alreadyPopulated: 0,
      wouldFill: 0,
      noSalary: 0,
      minGreaterThanMax: 0,
      samples: [],
      invalidRanges: [],
    };
  }

  // Index re-fetched jobs by composite key `${source}:${source_job_id}`
  const remoteMap = new Map<string, NormalizedJob>();
  for (const r of reFetchedJobs) {
    if (r.source && r.source_job_id) {
      remoteMap.set(`${r.source.toLowerCase()}:${r.source_job_id}`, r);
    }
  }

  const candidatesToUpdate: SalaryUpdateCandidate[] = [];
  const allSamples: SampleSalary[] = [];
  const allInvalidRanges: InvalidSalaryRange[] = [];

  for (const existing of existingJobs) {
    const src = (existing.source || '').toLowerCase() as SupportedSource;
    if (!statsBySource[src]) {
      statsBySource[src] = {
        source: src,
        alreadyPopulated: 0,
        wouldFill: 0,
        noSalary: 0,
        minGreaterThanMax: 0,
        samples: [],
        invalidRanges: [],
      };
    }
    const stat = statsBySource[src];

    // SAFETY GUARD 1: Existing salary must NEVER be overwritten
    if (existing.salary_min != null) {
      stat.alreadyPopulated++;
      continue;
    }

    // Look up re-fetched adapter result
    const remote = remoteMap.get(`${src}:${existing.source_job_id}`);
    const computedMin = remote?.salary_min != null ? remote.salary_min : null;
    const computedMax = remote?.salary_max != null ? remote.salary_max : null;
    const computedText = remote?.salary_text != null ? remote.salary_text : null;
    const computedCurrency = remote?.currency || 'USD';
    const computedPeriod = (remote?.salary_period as 'yearly' | 'monthly' | 'hourly') ?? null;

    // SAFETY GUARD 2: New salary must be non-null to qualify for update
    if (computedMin != null) {
      stat.wouldFill++;

      // Inconsistency detection: min > max
      if (computedMax != null && computedMin > computedMax) {
        stat.minGreaterThanMax++;
        const invalidRange: InvalidSalaryRange = {
          source: src,
          company: existing.company || remote?.company || 'Unknown',
          title: existing.title || remote?.title || 'Unknown',
          salary_min: computedMin,
          salary_max: computedMax,
        };
        stat.invalidRanges.push(invalidRange);
        allInvalidRanges.push(invalidRange);
      }

      const sample: SampleSalary = {
        source: src,
        company: existing.company || remote?.company || 'Unknown',
        title: existing.title || remote?.title || 'Unknown',
        salary_min: computedMin,
        salary_max: computedMax,
        currency: computedCurrency,
        salary_period: computedPeriod,
        salary_text: computedText,
      };

      if (stat.samples.length < 10) {
        stat.samples.push(sample);
      }
      if (allSamples.length < 10) {
        allSamples.push(sample);
      }

      candidatesToUpdate.push({
        id: existing.id,
        source: src,
        source_job_id: existing.source_job_id,
        company: existing.company || remote?.company || 'Unknown',
        title: existing.title || remote?.title || 'Unknown',
        existing: {
          salary_min: existing.salary_min,
          salary_max: existing.salary_max,
          salary_text: existing.salary_text,
          currency: existing.currency,
          salary_period: existing.salary_period,
        },
        computed: {
          salary_min: computedMin,
          salary_max: computedMax,
          salary_text: computedText,
          currency: computedCurrency,
          salary_period: computedPeriod,
        },
      });
    } else {
      stat.noSalary++;
    }
  }

  let totalAlreadyPopulated = 0;
  let totalWouldFill = 0;
  let totalNoSalary = 0;
  let totalMinGreaterThanMax = 0;

  for (const s of Object.values(statsBySource)) {
    totalAlreadyPopulated += s.alreadyPopulated;
    totalWouldFill += s.wouldFill;
    totalNoSalary += s.noSalary;
    totalMinGreaterThanMax += s.minGreaterThanMax;
  }

  return {
    statsBySource,
    totalAlreadyPopulated,
    totalWouldFill,
    totalNoSalary,
    totalMinGreaterThanMax,
    candidatesToUpdate,
    samples: allSamples,
    invalidRanges: allInvalidRanges,
  };
}

/**
 * Escapes a single CSV cell value according to RFC 4180.
 */
function escapeCsvCell(val: any): string {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates and saves a local CSV backup of affected rows before any update executes.
 * Headers: id,source,source_job_id,salary_min,salary_max,salary_text,currency,salary_period
 */
export function createCsvBackup(
  candidates: SalaryUpdateCandidate[],
  outputFilePath?: string
): { filePath: string; csvContent: string } {
  const header = ['id', 'source', 'source_job_id', 'salary_min', 'salary_max', 'salary_text', 'currency', 'salary_period'];
  const lines: string[] = [header.join(',')];

  for (const c of candidates) {
    const row = [
      escapeCsvCell(c.id),
      escapeCsvCell(c.source),
      escapeCsvCell(c.source_job_id),
      escapeCsvCell(c.existing.salary_min),
      escapeCsvCell(c.existing.salary_max),
      escapeCsvCell(c.existing.salary_text),
      escapeCsvCell(c.existing.currency),
      escapeCsvCell(c.existing.salary_period),
    ];
    lines.push(row.join(','));
  }

  const csvContent = lines.join('\n') + '\n';
  const targetPath =
    outputFilePath ||
    path.resolve(process.cwd(), `backups/salary-backfill-backup-${Date.now()}.csv`);

  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(targetPath, csvContent, 'utf-8');
  return { filePath: targetPath, csvContent };
}

/**
 * Parses a CSV backup file back into ExistingJobRecord objects.
 */
export function parseCsvBackup(csvContent: string): ExistingJobRecord[] {
  const lines = csvContent.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const records: ExistingJobRecord[] = [];
  // Parse simple CSV rows handling quoted values
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let c = 0; c < line.length; c++) {
      const char = line[c];
      if (char === '"') {
        if (inQuotes && line[c + 1] === '"') {
          current += '"';
          c++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        cells.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    cells.push(current);

    if (cells.length >= 8) {
      records.push({
        id: cells[0],
        source: cells[1] as SupportedSource,
        source_job_id: cells[2],
        salary_min: cells[3] ? Number(cells[3]) : null,
        salary_max: cells[4] ? Number(cells[4]) : null,
        salary_text: cells[5] || null,
        currency: cells[6] || null,
        salary_period: (cells[7] as any) || null,
      });
    }
  }

  return records;
}

/**
 * Returns documentation strings for the exact SQL, PostgREST update shape, and restore commands.
 */
export function getUpdateShapeDocumentation(): {
  sqlShape: string;
  postgrestShape: string;
  restoreSqlShape: string;
  restoreCliShape: string;
} {
  const sqlShape = `-- Exact SQL Update Shape (Batch of rows via VALUES CTE)
UPDATE public.jobs AS j
SET 
  salary_min    = v.salary_min,
  salary_max    = v.salary_max,
  salary_text   = v.salary_text,
  currency      = v.currency,
  salary_period = v.salary_period
FROM (
  VALUES 
    ('11111111-1111-1111-1111-111111111111'::uuid, 'greenhouse', 'stripe-101', 140000, 180000, '$140k–$180k', 'USD', 'yearly'),
    ('22222222-2222-2222-2222-222222222222'::uuid, 'ashby', 'ramp-202', 175000, 225000, '$175k–$225k', 'USD', 'yearly'),
    ('33333333-3333-3333-3333-333333333333'::uuid, 'lever', 'netflix-303', 190000, 240000, '$190k–$240k', 'USD', 'yearly')
) AS v(id, source, source_job_id, salary_min, salary_max, salary_text, currency, salary_period)
WHERE j.id = v.id
  AND j.source = v.source
  AND j.source_job_id = v.source_job_id
  AND j.salary_min IS NULL
  AND v.salary_min IS NOT NULL;`;

  const postgrestShape = `// Exact PostgREST Update Shape via Supabase JS
// Executed in sequential chunks of 200 items:
const { error } = await supabase
  .from('jobs')
  .update({
    salary_min: candidate.computed.salary_min,
    salary_max: candidate.computed.salary_max,
    salary_text: candidate.computed.salary_text,
    currency: candidate.computed.currency || 'USD',
    salary_period: candidate.computed.salary_period,
  })
  .eq('id', candidate.id)
  .eq('source', candidate.source)
  .eq('source_job_id', candidate.source_job_id)
  .is('salary_min', null); // Redundant wire-level guard ensuring no overwrite`;

  const restoreSqlShape = `-- Exact Restore SQL from local CSV backup
CREATE TEMP TABLE temp_salary_restore (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  source_job_id text NOT NULL,
  salary_min numeric,
  salary_max numeric,
  salary_text text,
  currency text,
  salary_period text
);

\\COPY temp_salary_restore FROM 'backups/salary-backfill-backup-<TIMESTAMP>.csv' WITH CSV HEADER;

UPDATE public.jobs AS j
SET 
  salary_min    = t.salary_min,
  salary_max    = t.salary_max,
  salary_text   = t.salary_text,
  currency      = t.currency,
  salary_period = t.salary_period
FROM temp_salary_restore AS t
WHERE j.id = t.id
  AND j.source = t.source
  AND j.source_job_id = t.source_job_id;`;

  const restoreCliShape = `# Exact Restore CLI Command:
npx tsx scripts/backfill-salaries.ts --restore backups/salary-backfill-backup-<TIMESTAMP>.csv --apply`;

  return { sqlShape, postgrestShape, restoreSqlShape, restoreCliShape };
}

/**
 * Restores salary data from a CSV backup file.
 */
export async function restoreFromCsv(
  csvFilePath: string,
  supabaseClient?: SupabaseClient | null,
  isApply = false
): Promise<{ restoredCount: number; errors: string[] }> {
  if (!fs.existsSync(csvFilePath)) {
    throw new Error(`CSV backup file not found at: ${csvFilePath}`);
  }

  const content = fs.readFileSync(csvFilePath, 'utf-8');
  const records = parseCsvBackup(content);
  console.log(`Loaded ${records.length} records from backup CSV: ${csvFilePath}`);

  const errors: string[] = [];
  let restoredCount = 0;

  if (!isApply) {
    console.log(`[DRY-RUN RESTORE] Would restore ${records.length} jobs to their pre-backfill salary state.`);
    return { restoredCount: records.length, errors: [] };
  }

  const supabase = supabaseClient || getSupabaseClient();
  if (!supabase) {
    throw new Error('Supabase client unavailable. Missing credentials.');
  }

  // Restore in batches of 200
  const BATCH_SIZE = 200;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    for (const record of batch) {
      const { error } = await supabase
        .from('jobs')
        .update({
          salary_min: record.salary_min,
          salary_max: record.salary_max,
          salary_text: record.salary_text,
          currency: record.currency,
          salary_period: record.salary_period,
        })
        .eq('id', record.id)
        .eq('source', record.source)
        .eq('source_job_id', record.source_job_id);

      if (error) {
        errors.push(`Failed restoring job ${record.id} (${record.source_job_id}): ${error.message}`);
      } else {
        restoredCount++;
      }
    }
  }

  return { restoredCount, errors };
}

/**
 * Cleans an ATS target/slug in case the config contained a full URL.
 */
function extractSlug(target: string): string {
  let cleaned = target.trim();
  if (cleaned.includes('job-board/')) {
    cleaned = cleaned.split('job-board/')[1];
  } else if (cleaned.includes('postings/')) {
    cleaned = cleaned.split('postings/')[1];
  } else if (cleaned.includes('boards.greenhouse.io/')) {
    cleaned = cleaned.split('boards.greenhouse.io/')[1];
  }
  return cleaned.split('?')[0].split('/')[0].trim().toLowerCase();
}

/**
 * Loads sources configuration from disk.
 */
export function loadSourcesForBackfill(customConfigPath?: string): SourceConfig[] {
  const candidateFiles = [
    customConfigPath,
    path.resolve(__dirname, 'config/companies-seed.json'),
    path.resolve(__dirname, 'config/companies-phase2.json'),
    path.resolve(__dirname, 'config/sources.json'),
  ].filter(Boolean) as string[];

  const sources: SourceConfig[] = [];
  const seenTargets = new Set<string>();

  for (const file of candidateFiles) {
    if (fs.existsSync(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf-8');
        const list: SourceConfig[] = JSON.parse(raw);
        for (const s of list) {
          if (
            s.enabled &&
            ['greenhouse', 'ashby', 'lever'].includes(s.type.toLowerCase())
          ) {
            const cleanSlug = extractSlug(s.target);
            const key = `${s.type.toLowerCase()}:${cleanSlug}`;
            if (!seenTargets.has(key)) {
              seenTargets.add(key);
              sources.push({
                ...s,
                target: cleanSlug,
              });
            }
          }
        }
      } catch {
        // Skip unparseable files
      }
    }
  }

  return sources;
}

/**
 * Main backfill orchestration runner.
 */
export async function runSalaryBackfill(options?: {
  isApply?: boolean;
  sourceFilter?: string;
  configPath?: string;
  limit?: number;
  mockExistingJobs?: ExistingJobRecord[];
  mockReFetchedJobs?: NormalizedJob[];
  supabaseClient?: SupabaseClient | null;
}): Promise<BackfillReport> {
  const isApply = options?.isApply ?? false;
  console.log('================================================================================');
  console.log(`   CAREERMONKE SALARY BACKFILL RUNNER [MODE: ${isApply ? 'LIVE APPLY' : 'DRY-RUN'}]`);
  console.log('================================================================================');
  console.log(`Safety Protocol: UPDATE only salary fields WHERE salary_min IS NULL.`);
  console.log(`Guaranteed: Never touches non-salary columns. Never overwrites existing data with null.\n`);

  let existingJobs: ExistingJobRecord[] = [];
  let reFetchedJobs: NormalizedJob[] = [];

  if (options?.mockExistingJobs && options?.mockReFetchedJobs) {
    existingJobs = options.mockExistingJobs;
    reFetchedJobs = options.mockReFetchedJobs;
  } else {
    const supabase = options?.supabaseClient || getSupabaseClient();
    if (!supabase) {
      console.warn('⚠️ No active Supabase client. Running evaluation against available configs/samples.');
    } else {
      console.log('Fetching existing jobs with source IN (greenhouse, ashby, lever) from database...');
      let offset = 0;
      const pageSize = 1000;
      while (true) {
        let query = supabase
          .from('jobs')
          .select('id, source, source_job_id, company, title, salary_min, salary_max, salary_text, currency, salary_period')
          .in('source', ['greenhouse', 'ashby', 'lever'])
          .range(offset, offset + pageSize - 1);

        if (options?.sourceFilter) {
          query = query.eq('source', options.sourceFilter);
        }

        const { data, error } = await query;
        if (error) {
          console.error('Error querying existing jobs:', error.message);
          break;
        }
        if (!data || data.length === 0) break;
        existingJobs.push(...(data as ExistingJobRecord[]));
        offset += data.length;
        if (data.length < pageSize) break;
      }
      console.log(`Retrieved ${existingJobs.length} matching jobs from database.`);
    }

    // Re-fetch from ATS boards using new adapters
    const adapters = {
      greenhouse: new GreenhouseAdapter(),
      ashby: new AshbyAdapter(),
      lever: new LeverAdapter(),
    };

    const sources = loadSourcesForBackfill(options?.configPath);
    const filteredSources = options?.sourceFilter
      ? sources.filter((s) => s.type.toLowerCase() === options.sourceFilter?.toLowerCase())
      : sources;

    const sourcesToProcess = options?.limit
      ? filteredSources.slice(0, options.limit)
      : filteredSources;

    console.log(`Re-fetching from ${sourcesToProcess.length} ATS boards with updated adapters...`);

    for (const source of sourcesToProcess) {
      const adapter = adapters[source.type.toLowerCase() as SupportedSource];
      if (!adapter) continue;
      try {
        const fetched = await adapter.fetchJobs(source);
        reFetchedJobs.push(...fetched);
      } catch (err: any) {
        console.warn(`  ⚠️ Skipped ${source.name} (${source.type}): ${err.message}`);
      }
    }
  }

  // Evaluate candidates
  const report = evaluateBackfillCandidates(existingJobs, reFetchedJobs);

  // Print Summary Table
  console.log('\n--- SALARY BACKFILL EVALUATION SUMMARY ---');
  console.log('Source        | Would-Fill | Already-Populated | No-Salary | Min > Max');
  console.log('--------------+------------+-------------------+-----------+----------');
  for (const src of ['greenhouse', 'ashby', 'lever']) {
    const s = report.statsBySource[src] || { wouldFill: 0, alreadyPopulated: 0, noSalary: 0, minGreaterThanMax: 0 };
    console.log(
      `${s.source.padEnd(13)} | ${String(s.wouldFill).padStart(10)} | ${String(s.alreadyPopulated).padStart(17)} | ${String(s.noSalary).padStart(9)} | ${String(s.minGreaterThanMax).padStart(9)}`
    );
  }
  console.log('--------------+------------+-------------------+-----------+----------');
  console.log(
    `TOTAL         | ${String(report.totalWouldFill).padStart(10)} | ${String(report.totalAlreadyPopulated).padStart(17)} | ${String(report.totalNoSalary).padStart(9)} | ${String(report.totalMinGreaterThanMax).padStart(9)}\n`
  );

  // Print 10 Samples
  console.log(`--- 10 SAMPLE PARSED SALARIES (${report.samples.length} collected) ---`);
  report.samples.slice(0, 10).forEach((sample, idx) => {
    console.log(
      ` ${idx + 1}. [${sample.source.toUpperCase()}] ${sample.company} — "${sample.title}": ${sample.salary_text || 'No text'} ` +
      `(min: ${sample.salary_min}, max: ${sample.salary_max}, curr: ${sample.currency}, period: ${sample.salary_period})`
    );
  });
  if (report.samples.length === 0) {
    console.log('  (No parsed salary samples found in current evaluation slice)');
  }

  // Print any Min > Max cases
  if (report.invalidRanges.length > 0) {
    console.log(`\n⚠️  WARNING: Found ${report.invalidRanges.length} cases where min > max:`);
    report.invalidRanges.forEach((inv, i) => {
      console.log(`   ${i + 1}. [${inv.source}] ${inv.company} — "${inv.title}": min=${inv.salary_min} > max=${inv.salary_max}`);
    });
  } else {
    console.log('\n✅ Zero min > max inconsistencies detected.');
  }

  // Print Documented Shapes
  const docShapes = getUpdateShapeDocumentation();
  console.log('\n--- DOCUMENTED SQL & POSTGREST UPDATE SHAPES ---');
  console.log(docShapes.sqlShape);
  console.log('\n' + docShapes.postgrestShape);
  console.log('\n--- RESTORE SCRIPT INSTRUCTIONS ---');
  console.log(docShapes.restoreSqlShape);
  console.log('\n' + docShapes.restoreCliShape);

  // Apply Phase (Only when explicit --apply flag is provided)
  if (isApply) {
    if (report.candidatesToUpdate.length === 0) {
      console.log('\nNo candidates qualify for update. Exiting apply phase.');
      return report;
    }

    // Step 1: Write CSV backup before modifying anything
    console.log(`\n[STEP 1] Writing pre-update CSV backup of ${report.candidatesToUpdate.length} affected rows...`);
    const backup = createCsvBackup(report.candidatesToUpdate);
    console.log(`✅ Backup successfully saved to: ${backup.filePath}`);

    // Step 2: Perform batch updates in chunks of 200
    const supabase = options?.supabaseClient || getSupabaseClient();
    if (!supabase) {
      throw new Error('Supabase client unavailable for apply phase.');
    }

    console.log(`\n[STEP 2] Updating ${report.candidatesToUpdate.length} rows in batches of 200...`);
    const BATCH_SIZE = 200;
    let updatedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < report.candidatesToUpdate.length; i += BATCH_SIZE) {
      const batch = report.candidatesToUpdate.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (candidate) => {
          const payload = buildUpdatePayload(candidate);
          const { error } = await supabase
            .from('jobs')
            .update(payload)
            .eq('id', candidate.id)
            .eq('source', candidate.source)
            .eq('source_job_id', candidate.source_job_id)
            .is('salary_min', null); // Wire-level check ensuring salary_min is still NULL

          if (!error) {
            updatedCount++;
          } else {
            failedCount++;
            console.error(`Error updating job ${candidate.id}:`, error.message);
          }
        })
      );
      console.log(`  Processed ${Math.min(i + BATCH_SIZE, report.candidatesToUpdate.length)}/${report.candidatesToUpdate.length} items...`);
    }

    console.log(`\n✅ Apply complete: ${updatedCount} jobs updated, ${failedCount} failures.`);
  } else {
    console.log('\n💡 To apply updates to database, execute with explicit --apply flag.');
    console.log('   (CSV backup will be created automatically before any update).');
  }

  return report;
}

// Direct CLI entry point
const scriptName = process.argv[1] ? path.basename(process.argv[1]) : '';
if (scriptName === 'backfill-salaries.ts' || scriptName === 'backfill-salaries.js') {
  const args = process.argv.slice(2);
  const isApply = args.includes('--apply');
  const restoreIdx = args.findIndex((a) => a === '--restore');
  const restoreFile = restoreIdx !== -1 && args[restoreIdx + 1] ? args[restoreIdx + 1] : null;
  const sourceIdx = args.findIndex((a) => a === '--source');
  const sourceFilter = sourceIdx !== -1 ? args[sourceIdx + 1] : undefined;
  const limitIdx = args.findIndex((a) => a === '--limit');
  const limit = limitIdx !== -1 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : undefined;
  const configIdx = args.findIndex((a) => a === '--config');
  const configPath = configIdx !== -1 && args[configIdx + 1] ? args[configIdx + 1] : undefined;

  if (restoreFile) {
    restoreFromCsv(restoreFile, null, isApply)
      .then((res) => {
        console.log(`Restore completed: ${res.restoredCount} records restored, ${res.errors.length} errors.`);
        process.exit(res.errors.length > 0 ? 1 : 0);
      })
      .catch((err) => {
        console.error('Fatal restore failure:', err);
        process.exit(1);
      });
  } else {
    runSalaryBackfill({ isApply, sourceFilter, configPath, limit })
      .then(() => process.exit(0))
      .catch((err) => {
        console.error('Fatal backfill failure:', err);
        process.exit(1);
      });
  }
}
