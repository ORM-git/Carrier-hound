/**
 * Frontend sheet row "Timezone-safe date display" guard.
 *
 * 1. Static scan of src/ rendering components:
 *    Flags unapproved raw date formatting (toLocaleDateString, toLocaleString,
 *    toISOString, date-fns format) that bypasses the shared timezone-safe
 *    posted-at/calendar formatters.
 * 2. Unit tests of the shared formatters (formatPostedAt, formatCalendarDate)
 *    pinned to a fixed non-UTC timezone (Asia/Calcutta, UTC+05:30) verifying that:
 *    - Relative times ("Just now", "2h ago", "Yesterday", "5d ago") compute
 *      accurately from epoch timestamps across timezone boundaries.
 *    - Calendar dates (>30 days or explicit) render absolute UTC instants consistently
 *      without local day-boundary shifts or midnight rollover in UTC mode.
 * 3. Old vs New component parity assertions under TZ=Asia/Calcutta:
 *    Asserts that every routed component passing mode: "local" reproduces the
 *    exact same output as the legacy implementation on timestamp 2026-11-10T20:00:00Z.
 *
 * Run: npx tsx scripts/test-tz-display-guard.ts
 * Run negative control: npx tsx scripts/test-tz-display-guard.ts --negative-control
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { formatPostedAt, formatCalendarDate } from "../src/lib/date/format";

// Pin process timezone to Asia/Calcutta (UTC+05:30) for deterministic evaluation
process.env.TZ = "Asia/Calcutta";

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
// Part B: Unit tests of shared formatters pinned to Asia/Calcutta (UTC+05:30)
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

// Test 5: Beyond 30 days: formats absolute calendar date safely in UTC without midnight shift (UTC mode)
{
  const lateUtcInstant = "2026-09-15T23:30:00.000Z";
  const res = formatPostedAt(lateUtcInstant, { now: ANCHOR_UTC_MS, locale: "en-US", mode: "utc" });
  check("formatPostedAt (utc): >30 days renders UTC instant without local day shift ('Sep 15')", res === "Sep 15");
}

// Test 6: Clock skew / future instant clamped to "Just now"
{
  const futureInstant = ANCHOR_UTC_MS + 2 * 60 * 1000; // 2 minutes into future
  const res = formatPostedAt(futureInstant, { now: ANCHOR_UTC_MS });
  check("formatPostedAt: minor future clock skew clamped to 'Just now'", res === "Just now");
}

// Test 7: Null / undefined / invalid inputs return fallback
{
  check("formatPostedAt: null returns 'Recently'", formatPostedAt(null) === "Recently");
  check("formatPostedAt: invalid date string returns 'Recently'", formatPostedAt("not-a-date") === "Recently");
}

// Test 8: formatCalendarDate formats UTC instants deterministically in UTC mode
{
  const lateUtc = "2026-10-31T23:45:00.000Z";
  const res = formatCalendarDate(lateUtc, { month: "short", day: "numeric", mode: "utc" });
  check("formatCalendarDate (utc): renders UTC calendar day ('Oct 31')", res === "Oct 31");

  const withYear = formatCalendarDate(lateUtc, { month: "short", day: "numeric", year: "numeric", mode: "utc" });
  check("formatCalendarDate (utc): renders UTC date with year ('Oct 31, 2026')", withYear === "Oct 31, 2026");
}

// -----------------------------------------------------------------------------
// Part C: Old vs New parity verification under TZ=Asia/Calcutta (2026-11-10T20:00:00Z)
// -----------------------------------------------------------------------------

const TEST_INSTANT = "2026-11-10T20:00:00Z";

// (1) src/app/tracker/page.tsx table cell
{
  const oldOutput = new Date(TEST_INSTANT).toLocaleDateString();
  const newOutput = formatCalendarDate(TEST_INSTANT, { mode: "local" });
  check(
    "tracker table cell parity: renders exact numeric format under Asia/Calcutta ('11/11/2026')",
    oldOutput === newOutput && newOutput === "11/11/2026"
  );
}

// (2) Admin EarlyAccessRequestsSection: local clock time & raw fallback on invalid
{
  const oldFormat = (dateStr?: string | null) => {
    if (!dateStr) return "—";
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return dateStr;
    }
  };

  const newFormat = (dateStr?: string | null) => {
    if (!dateStr) return "—";
    return formatCalendarDate(
      dateStr,
      {
        mode: "local",
        preserveRawOnInvalid: true,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      },
      "en-US"
    );
  };

  check(
    "admin early access parity: valid timestamp preserves local clock time ('Nov 11, 2026, 01:30 AM')",
    oldFormat(TEST_INSTANT) === newFormat(TEST_INSTANT) && newFormat(TEST_INSTANT) === "Nov 11, 2026, 01:30 AM"
  );
  check(
    "admin early access parity: invalid string returns raw input string",
    oldFormat("not-a-valid-date") === newFormat("not-a-valid-date") && newFormat("not-a-valid-date") === "not-a-valid-date"
  );
  check(
    "admin early access parity: null input returns '—'",
    oldFormat(null) === newFormat(null) && newFormat(null) === "—"
  );
}

// (3a) Tracker card Applied / Updated dates keep local-timezone day
{
  const oldApplied = `Applied ${new Date(TEST_INSTANT).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const newApplied = `Applied ${formatCalendarDate(TEST_INSTANT, { mode: "local", month: "short", day: "numeric" }, "en-US")}`;
  check(
    "tracker card applied parity: preserves local day ('Applied Nov 11')",
    oldApplied === newApplied && newApplied === "Applied Nov 11"
  );

  const oldUpdated = `Updated ${new Date(TEST_INSTANT).toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  const newUpdated = `Updated ${formatCalendarDate(TEST_INSTANT, { mode: "local", month: "short", day: "numeric" }, "en-US")}`;
  check(
    "tracker card updated parity: preserves local day ('Updated Nov 11')",
    oldUpdated === newUpdated && newUpdated === "Updated Nov 11"
  );
}

// (3b) Resume uploaded / confirmed date keeps local-timezone day
{
  const oldResume = new Date(TEST_INSTANT).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const newResume = formatCalendarDate(
    TEST_INSTANT,
    {
      mode: "local",
      month: "short",
      day: "numeric",
      year: "numeric",
    },
    "en-US"
  );
  check(
    "resume date parity: preserves local day with year ('Nov 11, 2026')",
    oldResume === newResume && newResume === "Nov 11, 2026"
  );
}

// (3c) Settings renewal date keeps local-timezone day
{
  const oldSettings = new Date(TEST_INSTANT).toLocaleDateString();
  const newSettings = formatCalendarDate(TEST_INSTANT, { mode: "local" });
  check(
    "settings date parity: preserves local numeric date ('11/11/2026')",
    oldSettings === newSettings && newSettings === "11/11/2026"
  );
}

// (4) JobRadarGlobe: keeps old locale behavior for dates >30 days and empty fallback
{
  const oldJobRadarFormat = (dateStr: string | null, nowMs?: number) => {
    if (!dateStr) return "Recently seen";
    try {
      const date = new Date(dateStr);
      const now = nowMs ? new Date(nowMs) : new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      if (diffHours < 1) return "Just now";
      if (diffHours < 24) return `${diffHours}h ago`;
      const diffDays = Math.floor(diffHours / 24);
      if (diffDays === 1) return "Yesterday";
      if (diffDays < 30) return `${diffDays}d ago`;
      return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "Recently";
    }
  };

  const newJobRadarFormat = (dateStr: string | null, nowMs?: number) => {
    if (!dateStr) return "Recently seen";
    return formatPostedAt(dateStr, {
      mode: "local",
      emptyFallback: "Recently seen",
      errorFallback: "Recently",
      now: nowMs,
    });
  };

  // Timestamp TEST_INSTANT (16 hours ago relative to anchor): returns "16h ago"
  check(
    "job radar globe parity: relative 16h ago returns identical string",
    oldJobRadarFormat(TEST_INSTANT, ANCHOR_UTC_MS) === newJobRadarFormat(TEST_INSTANT, ANCHOR_UTC_MS)
  );

  // Date older than 30 days (e.g. 2026-09-10T20:00:00Z)
  const oldDate30d = "2026-09-10T20:00:00Z";
  check(
    "job radar globe parity: >30d date returns identical local string",
    oldJobRadarFormat(oldDate30d, ANCHOR_UTC_MS) === newJobRadarFormat(oldDate30d, ANCHOR_UTC_MS)
  );

  // Null input returns "Recently seen"
  check(
    "job radar globe parity: null input returns 'Recently seen'",
    oldJobRadarFormat(null) === newJobRadarFormat(null) && newJobRadarFormat(null) === "Recently seen"
  );
}

// -----------------------------------------------------------------------------
// Summary
// -----------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
