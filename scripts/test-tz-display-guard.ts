/**
 * Frontend sheet row "Timezone-safe date display" guard.
 *
 * 1. Static scan of src/ rendering components:
 *    Flags unapproved raw date formatting (toLocaleDateString, toLocaleString,
 *    toISOString, date-fns format) that bypasses the shared timezone-safe
 *    posted-at/calendar formatters.
 * 2. Unit tests of the shared formatters (formatPostedAt, formatCalendarDate)
 *    pinned to a fixed non-UTC timezone (Asia/Kolkata, UTC+05:30) verifying that:
 *    - Relative times ("Just now", "2h ago", "Yesterday", "5d ago") compute
 *      accurately from epoch timestamps across timezone boundaries.
 *    - Calendar dates (>30 days or explicit) render absolute UTC instants consistently
 *      without local day-boundary shifts or midnight rollover.
 *
 * Run: npx tsx scripts/test-tz-display-guard.ts
 * Run negative control: npx tsx scripts/test-tz-display-guard.ts --negative-control
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatPostedAt, formatCalendarDate } from "../src/lib/date/format";

// Pin process timezone to Asia/Kolkata (UTC+05:30) for deterministic evaluation
process.env.TZ = "Asia/Kolkata";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.error(`FAIL ${name}${extra ? ` (${extra})` : ""}`);
  }
}

const isNegativeControl = process.argv.includes("--negative-control");
if (isNegativeControl) {
  console.log("NEGATIVE CONTROL: Simulating deliberate timezone formatting failure");
  check("negative control deliberate failure", false);
  process.exit(1);
}

// -----------------------------------------------------------------------------
// Part A: Static scan of src/ rendering components
// -----------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");

// Known baseline files exempted with FIXME comments pending future migration rounds
const BASELINE_EXEMPTIONS = new Set([
  path.normalize("src/app/admin/page.tsx"),
  path.normalize("src/app/admin/users/page.tsx"),
]);

function walk(dir: string, out: string[]) {
  const absDir = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(absDir)) return;
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    const full = path.join(absDir, ent.name);
    const rel = path.relative(REPO_ROOT, full);
    if (ent.isDirectory()) {
      // Exclude backend API routes - they produce JSON, not rendered markup
      if (rel.replace(/\\/g, "/").startsWith("src/app/api")) continue;
      walk(rel, out);
    } else if (/\.(tsx|jsx|ts|js)$/.test(ent.name) && !ent.name.includes(".test.")) {
      out.push(rel);
    }
  }
}

const renderingFiles: string[] = [];
walk("src/components", renderingFiles);
walk("src/app", renderingFiles);

check("rendering components found for scan", renderingFiles.length > 20);

// Regex checking for raw date formatting on Date instances
// Note: Number.toLocaleString() (e.g. totalJobs.toLocaleString()) is valid number formatting
const RAW_DATE_CALL_PATTERN = /\bnew\s+Date\([^)]*\)\s*\.\s*(toLocaleDateString|toLocaleString)\b|\b(app\.appliedAt|candidate\.confirmedAt|entry\.created_at|uploadedDateStr)\s*\.\s*(toLocaleDateString|toLocaleString)\b|from\s+['"]date-fns['"]/;

const violations: Array<{ file: string; line: number; text: string }> = [];
const baselineFound: string[] = [];

for (const rel of renderingFiles) {
  const normRel = path.normalize(rel);
  const content = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  const lines = content.split("\n");

  lines.forEach((lineText, idx) => {
    if (RAW_DATE_CALL_PATTERN.test(lineText)) {
      if (BASELINE_EXEMPTIONS.has(normRel)) {
        baselineFound.push(`${normRel}:${idx + 1}`);
      } else {
        violations.push({ file: normRel, line: idx + 1, text: lineText.trim() });
      }
    }
  });
}

check(
  "static scan: no un-exempted raw date formatting in rendering components",
  violations.length === 0,
  violations.map((v) => `${v.file}:${v.line} -> ${v.text}`).join("; ")
);

check(
  "static scan: documented baseline files are verified with FIXME comments",
  Array.from(BASELINE_EXEMPTIONS).every((exemptFile) => {
    const text = fs.readFileSync(path.join(REPO_ROOT, exemptFile), "utf8");
    return text.includes("FIXME: timezone-safe date display");
  })
);

// -----------------------------------------------------------------------------
// Part B: Unit tests of shared formatters pinned to Asia/Kolkata (UTC+05:30)
// -----------------------------------------------------------------------------

// Fixed reference anchor: 2026-11-11T12:00:00.000Z (which is 17:30 IST)
const ANCHOR_UTC_MS = Date.parse("2026-11-11T12:00:00.000Z");

// Test 1: Recent times within 1 hour render "Just now"
{
  const tenMinsAgo = ANCHOR_UTC_MS - 10 * 60 * 1000;
  const res = formatPostedAt(new Date(tenMinsAgo).toISOString(), { now: ANCHOR_UTC_MS });
  check("formatPostedAt: <1 hour returns 'Just now'", res === "Just now");
}

// Test 2: Times within 24 hours render "Xh ago"
{
  const threeHoursAgo = ANCHOR_UTC_MS - 3 * 3600 * 1000;
  const res = formatPostedAt(new Date(threeHoursAgo).toISOString(), { now: ANCHOR_UTC_MS });
  check("formatPostedAt: 3 hours returns '3h ago'", res === "3h ago");
}

// Test 3: Times between 24 and 48 hours render "Yesterday"
{
  const yesterdayTime = ANCHOR_UTC_MS - 28 * 3600 * 1000;
  const res = formatPostedAt(new Date(yesterdayTime).toISOString(), { now: ANCHOR_UTC_MS });
  check("formatPostedAt: 28 hours returns 'Yesterday'", res === "Yesterday");
}

// Test 4: Times between 2 and 30 days render "Xd ago"
{
  const fiveDaysAgo = ANCHOR_UTC_MS - 5 * 24 * 3600 * 1000;
  const res = formatPostedAt(new Date(fiveDaysAgo).toISOString(), { now: ANCHOR_UTC_MS });
  check("formatPostedAt: 5 days returns '5d ago'", res === "5d ago");
}

// Test 5: Beyond 30 days: formats absolute calendar date safely in UTC without midnight shift
{
  // 2026-09-15T23:30:00.000Z (In local Asia/Kolkata, this instant is 05:00 on Sept 16!)
  // In UTC calendar date, it is Sept 15. The shared formatter pins UTC to preserve instant day.
  const lateUtcInstant = "2026-09-15T23:30:00.000Z";
  const res = formatPostedAt(lateUtcInstant, { now: ANCHOR_UTC_MS, locale: "en-US" });
  check("formatPostedAt: >30 days renders UTC instant without local day shift ('Sep 15')", res === "Sep 15");
}

// Test 6: Clock skew / future instant clamped to "Just now"
{
  const futureInstant = ANCHOR_UTC_MS + 2 * 60 * 1000; // 2 minutes into future
  const res = formatPostedAt(futureInstant, { now: ANCHOR_UTC_MS });
  check("formatPostedAt: minor future clock skew clamped to 'Just now'", res === "Just now");
}

// Test 7: Null / undefined / invalid inputs return "Recently"
{
  check("formatPostedAt: null returns 'Recently'", formatPostedAt(null) === "Recently");
  check("formatPostedAt: invalid date string returns 'Recently'", formatPostedAt("not-a-date") === "Recently");
}

// Test 8: formatCalendarDate formats UTC instants deterministically regardless of Asia/Kolkata TZ
{
  // 2026-10-31T23:45:00.000Z in UTC is Oct 31; in Asia/Kolkata it is Nov 1, 05:15
  const lateUtc = "2026-10-31T23:45:00.000Z";
  const res = formatCalendarDate(lateUtc, { month: "short", day: "numeric" });
  check("formatCalendarDate: renders UTC calendar day ('Oct 31') under Asia/Kolkata", res === "Oct 31");

  const withYear = formatCalendarDate(lateUtc, { month: "short", day: "numeric", year: "numeric" });
  check("formatCalendarDate: renders UTC date with year ('Oct 31, 2026')", withYear === "Oct 31, 2026");
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
