import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

// Load .env.local if present
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
}

interface SuiteSpec {
  name: string;
  command: string;
  requiresSupabase?: boolean;
}

const SUITES: SuiteSpec[] = [
  // Pure offline unit & regression suites (always run in CI and locally)
  { name: "scripts/test-enhanced-scoring.ts", command: "npx tsx scripts/test-enhanced-scoring.ts", requiresSupabase: true },
  { name: "scripts/test-senior-scoring.ts", command: "npx tsx scripts/test-senior-scoring.ts", requiresSupabase: true },
  { name: "scripts/test-trust-acceptance.ts", command: "npx tsx scripts/test-trust-acceptance.ts" },
  { name: "scripts/test-salary-parser.ts", command: "npx tsx scripts/test-salary-parser.ts" },
  { name: "scripts/test-ingestion-safety.ts", command: "npx tsx scripts/test-ingestion-safety.ts" },
  { name: "scripts/test-ingest-regressions.ts", command: "npx tsx scripts/test-ingest-regressions.ts" },
  { name: "scripts/verify-careerops-port.ts", command: "npx tsx scripts/verify-careerops-port.ts" },
  { name: "scripts/daily-digest-cron.ts --dry", command: "npx tsx scripts/daily-digest-cron.ts --dry" },
  { name: "scripts/test-scrape.mjs", command: "node scripts/test-scrape.mjs" },
  { name: "scripts/test-insert.ts", command: "npx tsx scripts/test-insert.ts" },
  { name: "scripts/test-admin-analytics-reads.ts", command: "npx tsx scripts/test-admin-analytics-reads.ts" },
  { name: "scripts/test-radar-concurrency.ts", command: "npx tsx scripts/test-radar-concurrency.ts" },
  { name: "scripts/test-account-delete-parallel.ts", command: "npx tsx scripts/test-account-delete-parallel.ts" },
  { name: "scripts/test-rate-limits.ts", command: "npx tsx scripts/test-rate-limits.ts" },
  { name: "scripts/test-worldwide-view.ts", command: "npx tsx scripts/test-worldwide-view.ts" },
  { name: "scripts/test-domain-resolution.ts", command: "npx tsx scripts/test-domain-resolution.ts" },
  { name: "scripts/test-env-guards.ts", command: "npx tsx scripts/test-env-guards.ts" },
  { name: "scripts/test-sentry-config.ts", command: "npx tsx scripts/test-sentry-config.ts" },
  { name: "scripts/test-no-hardcoded-stats.ts", command: "npx tsx scripts/test-no-hardcoded-stats.ts" },
  { name: "scripts/test-cookie-notice.ts", command: "npx tsx scripts/test-cookie-notice.ts" },
  { name: "scripts/test-admin-audit-log.ts", command: "npx tsx scripts/test-admin-audit-log.ts" },
  { name: "scripts/test-xss-csp-ai-uploads.ts", command: "npx tsx scripts/test-xss-csp-ai-uploads.ts" },
  { name: "scripts/test-design-tokens.ts", command: "npx tsx scripts/test-design-tokens.ts" },
  { name: "scripts/test-redesign-jobs-page.ts", command: "npx tsx scripts/test-redesign-jobs-page.ts" },
  { name: "scripts/test-jobs-match-percentage.ts", command: "npx tsx scripts/test-jobs-match-percentage.ts" },
  { name: "scripts/test-public-shell.ts", command: "npx tsx scripts/test-public-shell.ts" },
  { name: "scripts/test-loggedin-shell.ts", command: "npx tsx scripts/test-loggedin-shell.ts" },
  { name: "scripts/test-jobs-list-detail.ts", command: "npx tsx scripts/test-jobs-list-detail.ts" },
  { name: "scripts/test-card-hover-match.ts", command: "npx tsx scripts/test-card-hover-match.ts" },
  { name: "scripts/test-razorpay-billing.ts", command: "npx tsx scripts/test-razorpay-billing.ts" },
  { name: "scripts/test-profile-rebuild.ts", command: "npx tsx scripts/test-profile-rebuild.ts" },
  { name: "scripts/test-auth-presentation.ts", command: "npx tsx scripts/test-auth-presentation.ts" },

  // Supabase read/safe-cleanup verification suites (run whenever Supabase credentials exist)
  { name: "scripts/test-filters.ts", command: "npx tsx scripts/test-filters.ts", requiresSupabase: true },
  { name: "scripts/test-counts.ts", command: "npx tsx scripts/test-counts.ts", requiresSupabase: true },
  { name: "scripts/test-company-search.js", command: "node scripts/test-company-search.js", requiresSupabase: true },
  { name: "scripts/test-search-clauses.js", command: "node scripts/test-search-clauses.js", requiresSupabase: true },
  { name: "scripts/test-multiword-search.ts", command: "npx tsx scripts/test-multiword-search.ts", requiresSupabase: true },
  { name: "scripts/test-radar-api.ts", command: "npx tsx scripts/test-radar-api.ts", requiresSupabase: true },
  { name: "scripts/test-top10-ranking.ts", command: "npx tsx scripts/test-top10-ranking.ts", requiresSupabase: true },
  { name: "scripts/test-task1-top10-complete.ts", command: "npx tsx scripts/test-task1-top10-complete.ts", requiresSupabase: true },
  { name: "scripts/test-admin-suite.ts", command: "npx tsx scripts/test-admin-suite.ts", requiresSupabase: true },
  { name: "scripts/verify-account-stats-payment.js", command: "npx tsx scripts/verify-account-stats-payment.js", requiresSupabase: true },
  { name: "scripts/verify-guest-jobs-listing.js", command: "node scripts/verify-guest-jobs-listing.js", requiresSupabase: true },
  { name: "scripts/verify-paid-data-lock.js", command: "node scripts/verify-paid-data-lock.js", requiresSupabase: true },
  { name: "scripts/verify-salaries-clean.ts", command: "npx tsx scripts/verify-salaries-clean.ts", requiresSupabase: true },
  { name: "scripts/verify-search-worldwide.js", command: "node scripts/verify-search-worldwide.js", requiresSupabase: true },
  { name: "scripts/verify-security-critical2-3.ts", command: "npx tsx scripts/verify-security-critical2-3.ts", requiresSupabase: true },
  { name: "scripts/verify-top10-score-consistency.js", command: "node scripts/verify-top10-score-consistency.js", requiresSupabase: true },
];

function hasSupabaseCredentials(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  return Boolean(
    url &&
    anon &&
    service &&
    !url.includes("placeholder.supabase.co") &&
    !url.includes("dummy") &&
    !anon.includes("dummy")
  );
}

function main() {
  const hasDb = hasSupabaseCredentials();
  console.log("================================================================================");
  console.log(`CAREERMONKE TEST SUITE RUNNER (Supabase credentials detected: ${hasDb ? "YES" : "NO — running offline suites"})`);
  console.log("================================================================================\n");

  let passed = 0;
  let failed = 0;
  let blocked = 0;

  for (const suite of SUITES) {
    if (suite.requiresSupabase && !hasDb) {
      console.log(`⏸️  [BLOCKED] ${suite.name} — Skipped (SUPABASE credentials not set in environment)`);
      blocked++;
      continue;
    }

    const start = Date.now();
    const res = spawnSync(suite.command, {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: true,
      timeout: 120000,
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(2) + "s";
    const output = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
    const hasFailureMarker = /(?:^|\n)\s*(?:❌\s*FAIL|FAIL:|⚠️ SOME VERIFICATION TESTS FAILED|TEST SUITE FAILED)/i.test(output);

    if (res.status === 0 && !hasFailureMarker) {
      console.log(`✅ [PASS]    ${suite.name} (${elapsed})`);
      passed++;
    } else {
      console.error(`❌ [FAIL]    ${suite.name} (${elapsed}) — exit code ${res.status}`);
      const tail = output
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-5)
        .join("\n             ");
      if (tail) {
        console.error(`             ${tail}`);
      }
      failed++;
    }
  }

  console.log("\n================================================================================");
  console.log(`SUMMARY: ${passed} passed, ${failed} failed, ${blocked} blocked/skipped`);
  console.log("================================================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main();
