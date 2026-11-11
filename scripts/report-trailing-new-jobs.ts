/**
 * scripts/report-trailing-new-jobs.ts
 *
 * Read-only operational report: prints trailing 7-day new direct jobs per day
 * labeled by Indian Standard Time (IST, Asia/Kolkata) date.
 *
 * Direct jobs are defined as employer direct ATS / career page postings:
 * - source_type in ('ats', 'direct')
 * - source in known ATS providers ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable')
 * - verified = true
 *
 * Usage:
 *   npx tsx scripts/report-trailing-new-jobs.ts
 *   npx tsx scripts/report-trailing-new-jobs.ts --json
 *   npx tsx scripts/report-trailing-new-jobs.ts --days 14
 *   npx tsx scripts/report-trailing-new-jobs.ts --fixture path/to/fixture.json
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

export const ATS_SOURCES = new Set([
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "recruitee",
  "workable",
]);

export interface DirectJobRow {
  id: string | number;
  title?: string;
  company?: string;
  source?: string;
  source_type?: string;
  verified?: boolean;
  first_seen_at: string;
}

export interface DayBucket {
  dateLabel: string; // e.g. "2026-11-11 IST"
  dateKey: string;   // e.g. "2026-11-11"
  newDirectJobs: number;
  newVerifiedJobs: number;
  totalNewJobs: number;
}

export interface TrailingReport {
  generatedAt: string;
  timezone: string;
  trailingDays: number;
  startDate: string;
  endDate: string;
  totalDirectJobs: number;
  totalNewJobs: number;
  buckets: DayBucket[];
}

export function isDirectJob(job: Partial<DirectJobRow>): boolean {
  if (job.source_type === "direct" || job.source_type === "ats") return true;
  if (job.verified === true) return true;
  if (job.source && ATS_SOURCES.has(job.source.toLowerCase())) return true;
  return false;
}

export function toIstDateKey(dateInput: string | Date | number): string {
  const d = typeof dateInput === "object" ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(d); // YYYY-MM-DD
}

export function toIstDateLabel(dateInput: string | Date | number): string {
  const key = toIstDateKey(dateInput);
  return key ? `${key} IST` : "";
}

export function computeTrailingDirectJobs(
  jobs: readonly DirectJobRow[],
  options: {
    now?: Date | string;
    days?: number;
  } = {}
): TrailingReport {
  const refDate = options.now ? new Date(options.now) : new Date();
  const daysCount = options.days && options.days > 0 ? options.days : 7;

  // Build the list of trailing IST dates (chronological order)
  const buckets: DayBucket[] = [];
  const bucketMap = new Map<string, DayBucket>();

  for (let i = daysCount - 1; i >= 0; i--) {
    const d = new Date(refDate.getTime() - i * 24 * 60 * 60 * 1000);
    const key = toIstDateKey(d);
    if (!bucketMap.has(key)) {
      const bucket: DayBucket = {
        dateKey: key,
        dateLabel: `${key} IST`,
        newDirectJobs: 0,
        newVerifiedJobs: 0,
        totalNewJobs: 0,
      };
      bucketMap.set(key, bucket);
      buckets.push(bucket);
    }
  }

  let totalDirectJobs = 0;
  let totalNewJobs = 0;

  for (const job of jobs) {
    if (!job.first_seen_at) continue;
    const dateKey = toIstDateKey(job.first_seen_at);
    const bucket = bucketMap.get(dateKey);
    if (!bucket) continue; // outside the trailing window

    bucket.totalNewJobs++;
    totalNewJobs++;

    if (isDirectJob(job)) {
      bucket.newDirectJobs++;
      totalDirectJobs++;
    }

    if (job.verified) {
      bucket.newVerifiedJobs++;
    }
  }

  return {
    generatedAt: refDate.toISOString(),
    timezone: "Asia/Kolkata (IST)",
    trailingDays: daysCount,
    startDate: buckets[0]?.dateLabel || "",
    endDate: buckets[buckets.length - 1]?.dateLabel || "",
    totalDirectJobs,
    totalNewJobs,
    buckets,
  };
}

export function formatTrailingJobsReport(report: TrailingReport): string {
  const lines: string[] = [
    `================================================================================`,
    `📊 TRAILING ${report.trailingDays}-DAY NEW DIRECT JOBS SUPPLY REPORT (IST)`,
    `================================================================================`,
    `Timezone:    ${report.timezone}`,
    `Window:      ${report.startDate} -> ${report.endDate}`,
    `Generated:   ${report.generatedAt}`,
    `--------------------------------------------------------------------------------`,
    `Date (IST)       | New Direct Jobs | Verified ATS | Total New Jobs`,
    `--------------------------------------------------------------------------------`,
  ];

  for (const b of report.buckets) {
    const directStr = String(b.newDirectJobs).padStart(15, " ");
    const verStr = String(b.newVerifiedJobs).padStart(12, " ");
    const totalStr = String(b.totalNewJobs).padStart(14, " ");
    lines.push(`${b.dateLabel.padEnd(16, " ")} | ${directStr} | ${verStr} | ${totalStr}`);
  }

  lines.push(`--------------------------------------------------------------------------------`);
  lines.push(
    `TOTAL (${report.trailingDays}d)      | ${String(report.totalDirectJobs).padStart(15, " ")} |              | ${String(report.totalNewJobs).padStart(14, " ")}`
  );
  lines.push(`================================================================================`);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isJson = args.includes("--json");
  const daysIdx = args.findIndex((a) => a === "--days");
  const daysCount = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 7;

  const fixtureIdx = args.findIndex((a) => a === "--fixture");
  const fixturePath = fixtureIdx !== -1 && args[fixtureIdx + 1] ? args[fixtureIdx + 1] : null;

  let jobs: DirectJobRow[] = [];

  if (fixturePath) {
    const fullPath = path.isAbsolute(fixturePath) ? fixturePath : path.resolve(process.cwd(), fixturePath);
    if (!fs.existsSync(fullPath)) {
      console.error(`Fixture file not found: ${fullPath}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(fullPath, "utf8");
    jobs = JSON.parse(raw);
  } else {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    if (!url || !key) {
      console.log(`⚠️ Supabase credentials not found in env and no --fixture supplied.`);
      console.log(`   Printing empty placeholder report for ${daysCount} trailing days.`);
      const emptyReport = computeTrailingDirectJobs([], { days: daysCount });
      if (isJson) {
        console.log(JSON.stringify(emptyReport, null, 2));
      } else {
        console.log(formatTrailingJobsReport(emptyReport));
      }
      return;
    }

    const client = createClient(url, key, { auth: { persistSession: false } });
    const cutoff = new Date(Date.now() - (daysCount + 1) * 24 * 60 * 60 * 1000).toISOString();

    const { data, error } = await client
      .from("jobs")
      .select("id, title, company, source, source_type, verified, first_seen_at")
      .gte("first_seen_at", cutoff)
      .order("first_seen_at", { ascending: false });

    if (error) {
      console.error(`Query failed: ${error.message}`);
      process.exit(1);
    }

    jobs = (data as DirectJobRow[]) || [];
  }

  const report = computeTrailingDirectJobs(jobs, { days: daysCount });

  if (isJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatTrailingJobsReport(report));
  }
}

if (process.argv[1] && process.argv[1].endsWith("report-trailing-new-jobs.ts")) {
  main().catch((err) => {
    console.error("Fatal report failure:", err);
    process.exit(1);
  });
}
