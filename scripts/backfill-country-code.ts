/**
 * scripts/backfill-country-code.ts
 *
 * Safe Null-Only Country Code Backfill Tool for CareerMonke.
 *
 * Operational & Safety Guarantees:
 * 1. NULL-ONLY: Strictly selects and updates rows WHERE country_code IS NULL.
 * 2. DRY-RUN BY DEFAULT: Does not perform any database writes unless explicit --apply is passed.
 * 3. BACKUP BEFORE WRITE: With --apply, generates a pre-update CSV backup first before executing any update.
 * 4. BATCHED WRITES: Updates in chunks of 50 rows, guarded with .is('country_code', null).
 * 5. COMPREHENSIVE AUDIT: Prints counts per country, 30 sample changes, and full ambiguous case count breakdown.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { detectCountryCode } from './utils/sanitizer';

// Load environment variables
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, '../.env.local');
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath, override: true });
}
dotenv.config();

export interface NullCountryJobRow {
  id: string;
  company: string | null;
  title: string | null;
  location: string | null;
  country: string | null;
  country_code: string | null;
  created_at?: string | null;
}

export interface CandidateCountryUpdate {
  id: string;
  company: string;
  title: string;
  location: string;
  country: string | null;
  detectedCountryCode: string;
}

export interface AmbiguousCase {
  id: string;
  company: string;
  title: string;
  location: string;
  country: string | null;
  reason: string;
}

export interface BackfillCountryReport {
  totalEvaluated: number;
  totalWouldFill: number;
  totalAmbiguous: number;
  countsByCountry: Record<string, number>;
  sample30Changes: CandidateCountryUpdate[];
  ambiguousCountsByCategory: Record<string, number>;
  candidatesToUpdate: CandidateCountryUpdate[];
  ambiguousCases: AmbiguousCase[];
}

export function getSupabaseClient(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return null;
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Returns documented exact SQL and PostgREST update statements that the script runs.
 */
export function getUpdateShapeDescription(): { sqlShape: string; postgrestShape: string } {
  const sqlShape = `-- Exact SQL Update Shape (Batch execution per country code):
UPDATE public.jobs
SET country_code = 'US'
WHERE id IN (
  '11111111-1111-1111-1111-111111111111'::uuid,
  '22222222-2222-2222-2222-222222222222'::uuid
  -- ... up to batch size 50
)
AND country_code IS NULL;

-- Or multi-country batch via CTE:
UPDATE public.jobs AS j
SET country_code = v.detected_country_code
FROM (
  VALUES
    ('11111111-1111-1111-1111-111111111111'::uuid, 'US'),
    ('22222222-2222-2222-2222-222222222222'::uuid, 'GB'),
    ('33333333-3333-3333-3333-333333333333'::uuid, 'IN')
) AS v(id, detected_country_code)
WHERE j.id = v.id
  AND j.country_code IS NULL;`;

  const postgrestShape = `// Exact PostgREST Update Shape via Supabase JS SDK:
// Executed in sequential chunks of 50 items grouped by detected country_code:
const { error } = await supabase
  .from('jobs')
  .update({ country_code: targetCountryCode })
  .in('id', batchIds)
  .is('country_code', null); // Redundant wire-level guard ensuring only null rows are touched`;

  return { sqlShape, postgrestShape };
}

/**
 * Classifies the specific reason a location remained ambiguous (null).
 */
export function classifyAmbiguousReason(location: string = '', country: string = ''): string {
  const loc = (location || '').trim();
  const c = (country || '').trim();
  const lower = loc.toLowerCase();

  if (!loc && !c) return 'Empty / Unspecified Location';
  if (/^remote$/i.test(lower)) return 'Pure "Remote" (no region specified)';
  if (/^hybrid$/i.test(lower)) return 'Pure "Hybrid" (no region specified)';
  if (/^(?:in-office|onsite)$/i.test(lower)) return 'Pure "In-Office / Onsite" (no region specified)';
  if (/^(?:worldwide|global|anywhere|work from anywhere|distributed)$/i.test(lower)) return 'Global / Worldwide Remote';
  if (/^(?:emea|apac|latam|americas|europe|asia|africa|middle east)$/i.test(lower)) return 'Broad Multi-Country Region';
  if (/\b(?:us|usa|ca|uk|gb|eu)\b.*(?:\/|\||\bor\b|,).*?\b(?:us|usa|ca|uk|gb|eu)\b/i.test(lower)) return 'Multi-Country Options (e.g. US or Canada)';
  if (/^(?:remote\s*[-–—:]\s*)?in$/i.test(lower)) return 'Ambiguous State/Country "IN"';
  if (/^(?:remote\s*[-–—:]\s*)?georgia$/i.test(lower)) return 'Ambiguous "Georgia" (State vs Country)';
  if (/^(?:remote\s*[-–—:]\s*)?jersey$/i.test(lower)) return 'Ambiguous "Jersey" (NJ vs Channel Island)';
  return 'Unrecognized / Ambiguous Pattern';
}

/**
 * Evaluates null country_code jobs offline or against an array of rows.
 */
export function evaluateNullCountryJobs(rows: NullCountryJobRow[]): BackfillCountryReport {
  const candidatesToUpdate: CandidateCountryUpdate[] = [];
  const ambiguousCases: AmbiguousCase[] = [];
  const countsByCountry: Record<string, number> = {};
  const ambiguousCountsByCategory: Record<string, number> = {};

  for (const row of rows) {
    // Safety guard: only process if existing country_code is strictly null or empty
    if (row.country_code != null && row.country_code.trim() !== '') {
      continue;
    }

    const detected = detectCountryCode(row.location || '', row.country || null);

    if (detected) {
      countsByCountry[detected] = (countsByCountry[detected] || 0) + 1;
      candidatesToUpdate.push({
        id: row.id,
        company: row.company || 'Unknown',
        title: row.title || 'Unknown',
        location: row.location || 'Unspecified',
        country: row.country || null,
        detectedCountryCode: detected,
      });
    } else {
      const reason = classifyAmbiguousReason(row.location || '', row.country || '');
      ambiguousCountsByCategory[reason] = (ambiguousCountsByCategory[reason] || 0) + 1;
      ambiguousCases.push({
        id: row.id,
        company: row.company || 'Unknown',
        title: row.title || 'Unknown',
        location: row.location || 'Unspecified',
        country: row.country || null,
        reason,
      });
    }
  }

  return {
    totalEvaluated: rows.length,
    totalWouldFill: candidatesToUpdate.length,
    totalAmbiguous: ambiguousCases.length,
    countsByCountry,
    sample30Changes: candidatesToUpdate.slice(0, 30),
    ambiguousCountsByCategory,
    candidatesToUpdate,
    ambiguousCases,
  };
}

/**
 * Generates CSV content and saves pre-update backup of affected rows.
 */
export function createCountryBackupCsv(
  candidates: CandidateCountryUpdate[],
  outputDir: string = path.resolve(process.cwd(), 'backups')
): { filePath: string; recordCount: number } {
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(outputDir, `country-code-backfill-backup-${timestamp}.csv`);

  const escapeCell = (val: any): string => {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const headers = ['id', 'company', 'title', 'location', 'country', 'country_code', 'detected_country_code'];
  const lines = [headers.join(',')];

  for (const c of candidates) {
    lines.push([
      escapeCell(c.id),
      escapeCell(c.company),
      escapeCell(c.title),
      escapeCell(c.location),
      escapeCell(c.country),
      '', // Existing country_code is strictly null
      escapeCell(c.detectedCountryCode),
    ].join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  return { filePath, recordCount: candidates.length };
}

/**
 * Main execution runner
 */
export async function runCountryBackfill(options?: {
  isApply?: boolean;
  mockRows?: NullCountryJobRow[];
}): Promise<BackfillCountryReport> {
  const isApply = options?.isApply ?? process.argv.includes('--apply');

  console.log('================================================================================');
  console.log(`   CAREERMONKE NULL-ONLY COUNTRY CODE BACKFILL [MODE: ${isApply ? 'LIVE APPLY' : 'DRY-RUN'}]`);
  console.log('================================================================================');
  console.log('Safety Protocol: Strictly queries and updates rows WHERE country_code IS NULL.');
  console.log('Ambiguity Discipline: Never guesses. Ambiguous locations strictly remain null.');
  console.log('');

  let rows: NullCountryJobRow[] = [];

  if (options?.mockRows) {
    rows = options.mockRows;
  } else {
    const supabase = getSupabaseClient();
    if (!supabase) {
      console.error('❌ Supabase credentials missing from environment (.env.local).');
      process.exit(1);
    }

    console.log('Fetching all database records where country_code IS NULL...');
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('jobs')
        .select('id, company, title, location, country, country_code, created_at')
        .is('country_code', null)
        .range(offset, offset + pageSize - 1);

      if (error) {
        console.error('Error fetching jobs batch:', error.message);
        break;
      }
      if (!data || data.length === 0) break;
      rows.push(...data);
      offset += data.length;
      if (data.length < pageSize) break;
    }
    console.log(`Total database records fetched with country_code IS NULL: ${rows.length}\n`);
  }

  const report = evaluateNullCountryJobs(rows);

  // 1. Summary Statistics
  console.log('--- 1. BACKFILL EVALUATION SUMMARY ---');
  console.log(`Total rows evaluated (country_code IS NULL): ${report.totalEvaluated}`);
  const fillPct = report.totalEvaluated > 0 ? ((report.totalWouldFill / report.totalEvaluated) * 100).toFixed(1) : '0';
  const ambPct = report.totalEvaluated > 0 ? ((report.totalAmbiguous / report.totalEvaluated) * 100).toFixed(1) : '0';
  console.log(`Total that WOULD FILL:                       ${report.totalWouldFill} (${fillPct}%)`);
  console.log(`Total that REMAIN NULL (Ambiguous):          ${report.totalAmbiguous} (${ambPct}%)\n`);

  // 2. Counts per Country
  console.log('--- 2. COUNTS PER DETECTED COUNTRY ---');
  console.log('Country Code | Job Count | Percentage of Would-Fill');
  console.log('-------------+-----------+-------------------------');
  const sortedCountries = Object.entries(report.countsByCountry).sort((a, b) => b[1] - a[1]);
  for (const [code, count] of sortedCountries) {
    const pct = report.totalWouldFill > 0 ? ((count / report.totalWouldFill) * 100).toFixed(1) : '0';
    console.log(`${code.padEnd(12)} | ${String(count).padStart(9)} | ${pct.padStart(5)}%`);
  }
  console.log('-------------+-----------+-------------------------');
  console.log(`TOTAL        | ${String(report.totalWouldFill).padStart(9)} | 100.0%\n`);

  // 3. Sample of 30 Changes
  console.log('--- 3. SAMPLE OF 30 CHANGES ---');
  report.sample30Changes.forEach((sample, idx) => {
    const num = String(idx + 1).padStart(2);
    const co = (sample.company || 'Unknown').slice(0, 20).padEnd(20);
    const loc = (sample.location || 'Unspecified').slice(0, 32).padEnd(32);
    console.log(`[${num}] ${co} | Loc: "${loc}" -> Code: [${sample.detectedCountryCode}] | Title: "${sample.title.slice(0, 35)}"`);
  });
  console.log('');

  // 4. Ambiguous Cases Count Breakdown
  console.log('--- 4. AMBIGUOUS CASES COUNT BREAKDOWN (STAYS NULL) ---');
  console.log('Ambiguity Category                           | Count     | Percentage');
  console.log('---------------------------------------------+-----------+-----------');
  const sortedAmbiguous = Object.entries(report.ambiguousCountsByCategory).sort((a, b) => b[1] - a[1]);
  for (const [cat, count] of sortedAmbiguous) {
    const pct = report.totalAmbiguous > 0 ? ((count / report.totalAmbiguous) * 100).toFixed(1) : '0';
    console.log(`${cat.padEnd(44)} | ${String(count).padStart(9)} | ${pct.padStart(5)}%`);
  }
  console.log('---------------------------------------------+-----------+-----------');
  console.log(`TOTAL AMBIGUOUS (SAFE NULL)                  | ${String(report.totalAmbiguous).padStart(9)} | 100.0%\n`);

  // 5. Documented SQL & PostgREST Updates
  const { sqlShape, postgrestShape } = getUpdateShapeDescription();
  console.log('--- 5. EXACT SQL / UPDATES THE SCRIPT WOULD RUN ---');
  console.log(sqlShape);
  console.log('\n' + postgrestShape + '\n');

  // 6. Apply Phase (Strictly guarded by --apply)
  if (isApply) {
    console.log('--- LIVE APPLY EXECUTION ---');
    if (report.candidatesToUpdate.length === 0) {
      console.log('No candidates qualify for update. Exiting.');
      return report;
    }

    console.log(`[STEP 1] Generating CSV pre-update backup of ${report.candidatesToUpdate.length} rows...`);
    const backup = createCountryBackupCsv(report.candidatesToUpdate);
    console.log(`✅ Backup successfully created at: ${backup.filePath}`);

    console.log(`[STEP 2] Updating ${report.candidatesToUpdate.length} rows in batches of 50...`);
    const supabase = getSupabaseClient();
    if (!supabase) {
      throw new Error('Supabase client unavailable for apply phase.');
    }

    // Group candidates by country code to minimize query operations
    const groupsByCode = new Map<string, string[]>();
    for (const c of report.candidatesToUpdate) {
      const list = groupsByCode.get(c.detectedCountryCode) || [];
      list.push(c.id);
      groupsByCode.set(c.detectedCountryCode, list);
    }

    let updatedCount = 0;
    const batchSize = 50;

    for (const [code, ids] of groupsByCode.entries()) {
      for (let i = 0; i < ids.length; i += batchSize) {
        const batchIds = ids.slice(i, i + batchSize);
        const { error } = await supabase
          .from('jobs')
          .update({ country_code: code })
          .in('id', batchIds)
          .is('country_code', null);

        if (error) {
          console.error(`Error updating batch for country ${code}:`, error.message);
        } else {
          updatedCount += batchIds.length;
        }
      }
    }
    console.log(`✅ Successfully backfilled ${updatedCount} rows to their detected country_code!`);
  } else {
    console.log('💡 Note: Running in DRY-RUN mode. No database records were modified.');
    console.log('   To apply updates with backup CSV and batched writes, supply --apply flag.');
  }

  return report;
}

// Direct CLI invocation
if (process.argv[1] && process.argv[1].endsWith('backfill-country-code.ts')) {
  runCountryBackfill().catch((err) => {
    console.error('Backfill script error:', err);
    process.exit(1);
  });
}
