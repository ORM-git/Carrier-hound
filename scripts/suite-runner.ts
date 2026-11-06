import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

const {
  classifySuite,
  isDbCapable,
  checkTargetAuthorization,
  stripCredentials,
  redactOutput,
  executeSuiteList,
  EXIT_CODES,
  DENIED_PROJECT_REFS: GUARD_DENIED_REFS,
  DEFAULT_TEST_PROJECT_ALLOWLIST: GUARD_DEFAULT_ALLOWLIST,
} = require("./lib/test-guard.cjs");

// Load .env.local if present in normal local workflow
const envLocalPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envLocalPath)) {
  dotenv.config({ path: envLocalPath });
}

export interface SuiteSpec {
  name: string;
  command: string;
  classification?: "offline" | "db-read" | "db-write" | "db-anon-write-attempt";
  requiresSupabase?: boolean; // Maintained for backward compatibility
}

// In-source documented test-project allowlist. Strictly EMPTY by default.
// Only non-production project refs explicitly listed here can authorize DB-capable suites.
export const TEST_PROJECT_ALLOWLIST: string[] = [...GUARD_DEFAULT_ALLOWLIST,
  { name: "scripts/test-rpc-retry.ts", command: "npx tsx scripts/test-rpc-retry.ts", classification: "offline" },
];

// Production project reference ID that is strictly denied under all circumstances.
export const DENIED_PROJECT_REFS: string[] = [...GUARD_DENIED_REFS];

export { executeSuiteList };

export const SUITES: SuiteSpec[] = [
  // Pure offline unit & regression suites (always safe to run locally and in CI)
  { name: "scripts/test-country-eligibility-and-currency.ts", command: "npx tsx scripts/test-country-eligibility-and-currency.ts", classification: "offline" },
  { name: "scripts/test-trust-acceptance.ts", command: "npx tsx scripts/test-trust-acceptance.ts", classification: "offline" },
  { name: "scripts/test-salary-parser.ts", command: "npx tsx scripts/test-salary-parser.ts", classification: "offline" },
  { name: "scripts/test-ingestion-safety.ts", command: "npx tsx scripts/test-ingestion-safety.ts", classification: "offline" },
  { name: "scripts/test-ingest-regressions.ts", command: "npx tsx scripts/test-ingest-regressions.ts", classification: "offline" },
  { name: "scripts/verify-careerops-port.ts", command: "npx tsx scripts/verify-careerops-port.ts", classification: "offline" },
  { name: "scripts/test-scrape.mjs", command: "node scripts/test-scrape.mjs", classification: "offline" },
  { name: "scripts/test-admin-analytics-reads.ts", command: "npx tsx scripts/test-admin-analytics-reads.ts", classification: "offline" },
  { name: "scripts/test-radar-concurrency.ts", command: "npx tsx scripts/test-radar-concurrency.ts", classification: "offline" },
  { name: "scripts/test-account-delete-parallel.ts", command: "npx tsx scripts/test-account-delete-parallel.ts", classification: "offline" },
  { name: "scripts/test-account-export.ts", command: "npx tsx scripts/test-account-export.ts", classification: "offline" },
  { name: "scripts/test-rate-limits.ts", command: "npx tsx scripts/test-rate-limits.ts", classification: "offline" },
  { name: "scripts/test-route-budget.ts", command: "npx tsx scripts/test-route-budget.ts", classification: "offline" },
  { name: "scripts/test-worldwide-view.ts", command: "npx tsx scripts/test-worldwide-view.ts", classification: "offline" },
  { name: "scripts/test-domain-resolution.ts", command: "npx tsx scripts/test-domain-resolution.ts", classification: "offline" },
  { name: "scripts/test-env-guards.ts", command: "npx tsx scripts/test-env-guards.ts", classification: "offline" },
  { name: "scripts/test-sentry-config.ts", command: "npx tsx scripts/test-sentry-config.ts", classification: "offline" },
  { name: "scripts/test-no-hardcoded-stats.ts", command: "npx tsx scripts/test-no-hardcoded-stats.ts", classification: "offline" },
  { name: "scripts/test-cookie-notice.ts", command: "npx tsx scripts/test-cookie-notice.ts", classification: "offline" },
  { name: "scripts/test-admin-audit-log.ts", command: "npx tsx scripts/test-admin-audit-log.ts", classification: "offline" },
  { name: "scripts/test-xss-csp-ai-uploads.ts", command: "npx tsx scripts/test-xss-csp-ai-uploads.ts", classification: "offline" },
  { name: "scripts/test-design-tokens.ts", command: "npx tsx scripts/test-design-tokens.ts", classification: "offline" },
  { name: "scripts/test-redesign-jobs-page.ts", command: "npx tsx scripts/test-redesign-jobs-page.ts", classification: "offline" },
  { name: "scripts/test-jobs-match-percentage.ts", command: "npx tsx scripts/test-jobs-match-percentage.ts", classification: "offline" },
  { name: "scripts/test-public-shell.ts", command: "npx tsx scripts/test-public-shell.ts", classification: "offline" },
  { name: "scripts/test-loggedin-shell.ts", command: "npx tsx scripts/test-loggedin-shell.ts", classification: "offline" },
  { name: "scripts/test-jobs-list-detail.ts", command: "npx tsx scripts/test-jobs-list-detail.ts", classification: "offline" },
  { name: "scripts/test-card-hover-match.ts", command: "npx tsx scripts/test-card-hover-match.ts", classification: "offline" },
  { name: "scripts/test-razorpay-billing.ts", command: "npx tsx scripts/test-razorpay-billing.ts", classification: "offline" },
  { name: "scripts/test-profile-rebuild.ts", command: "npx tsx scripts/test-profile-rebuild.ts", classification: "offline" },
  { name: "scripts/test-auth-presentation.ts", command: "npx tsx scripts/test-auth-presentation.ts", classification: "offline" },
  { name: "scripts/test-tracker-resume-rebuild.ts", command: "npx tsx scripts/test-tracker-resume-rebuild.ts", classification: "offline" },
  { name: "scripts/test-tracker-isolation.ts", command: "npx tsx scripts/test-tracker-isolation.ts", classification: "offline" },
  { name: "scripts/test-url-state-assertions.ts", command: "npx tsx scripts/test-url-state-assertions.ts", classification: "offline" },
  { name: "scripts/test-production-fixes.ts", command: "npx tsx scripts/test-production-fixes.ts", classification: "offline" },
  { name: "scripts/test-structured-data-validation.ts", command: "npx tsx scripts/test-structured-data-validation.ts", classification: "offline" },
  { name: "scripts/test-openapi-spec.ts", command: "npx tsx scripts/test-openapi-spec.ts", classification: "offline" },
  { name: "scripts/test-filter-predicates.ts", command: "npx tsx scripts/test-filter-predicates.ts", classification: "offline" },
  { name: "scripts/test-keyset-pagination.ts", command: "npx tsx scripts/test-keyset-pagination.ts", classification: "offline" },
  { name: "scripts/test-jobs-detail-polish.ts", command: "npx tsx scripts/test-jobs-detail-polish.ts", classification: "offline" },
  { name: "scripts/test-jobs-service-degraded.ts", command: "npx tsx scripts/test-jobs-service-degraded.ts", classification: "offline" },
  { name: "scripts/test-no-dummy-jobs.ts", command: "npx tsx scripts/test-no-dummy-jobs.ts", classification: "offline" },
  { name: "scripts/test-auth-guard.ts", command: "npx tsx scripts/test-auth-guard.ts", classification: "offline" },
  { name: "scripts/test-request-id.ts", command: "npx tsx scripts/test-request-id.ts", classification: "offline" },
  { name: "scripts/test-prompt5-base.cjs", command: "node scripts/test-prompt5-base.cjs", classification: "offline" },
  { name: "scripts/test-admin-bypass-removal.ts", command: "npx tsx scripts/test-admin-bypass-removal.ts", classification: "offline" },
  { name: "scripts/test-hide-empty-feed-card.ts", command: "npx tsx scripts/test-hide-empty-feed-card.ts", classification: "offline" },
  { name: "scripts/test-pro-unlock-errors.ts", command: "npx tsx scripts/test-pro-unlock-errors.ts", classification: "offline" },
  { name: "scripts/test-job-detail-redesign.ts", command: "npx tsx scripts/test-job-detail-redesign.ts", classification: "offline" },
  { name: "scripts/test-early-applicant-badge.ts", command: "npx tsx scripts/test-early-applicant-badge.ts", classification: "offline" },
  { name: "scripts/test-adapter-structured-salaries.ts", command: "npx tsx scripts/test-adapter-structured-salaries.ts", classification: "offline" },
  { name: "scripts/test-hide-empty-titles-heading.ts", command: "npx tsx scripts/test-hide-empty-titles-heading.ts", classification: "offline" },
  { name: "scripts/test-radar-drawer-retry-error.ts", command: "npx tsx scripts/test-radar-drawer-retry-error.ts", classification: "offline" },
  { name: "scripts/test-pricing-header-first-render.ts", command: "npx tsx scripts/test-pricing-header-first-render.ts", classification: "offline" },
  { name: "scripts/test-backfill-salaries.ts", command: "npx tsx scripts/test-backfill-salaries.ts", classification: "offline" },
  { name: "scripts/test-location-country-filter.ts", command: "npx tsx scripts/test-location-country-filter.ts", classification: "offline" },
  { name: "scripts/test-country-detection.ts", command: "npx tsx scripts/test-country-detection.ts", classification: "offline" },
  { name: "scripts/test-top10-why-match.ts", command: "npx tsx scripts/test-top10-why-match.ts", classification: "offline" },
  { name: "scripts/test-free-paywall-ai-gating.ts", command: "npx tsx scripts/test-free-paywall-ai-gating.ts", classification: "offline" },
  { name: "scripts/test-compact-spacing.ts", command: "npx tsx scripts/test-compact-spacing.ts", classification: "offline" },
  { name: "scripts/test-card-menu.ts", command: "npx tsx scripts/test-card-menu.ts", classification: "offline" },
  { name: "scripts/test-interview-pack.ts", command: "npx tsx scripts/test-interview-pack.ts", classification: "offline" },
  { name: "scripts/test-skill-what-if.ts", command: "npx tsx scripts/test-skill-what-if.ts", classification: "offline" },
  { name: "scripts/test-board-ingestion.ts", command: "npx tsx scripts/test-board-ingestion.ts", classification: "offline" },
  { name: "scripts/test-board-discovery.ts", command: "npx tsx scripts/test-board-discovery.ts", classification: "offline" },
  { name: "scripts/test-ats-adapters.ts", command: "npx tsx scripts/test-ats-adapters.ts", classification: "offline" },
  { name: "scripts/test-ats-pipeline-repair.ts", command: "npx tsx scripts/test-ats-pipeline-repair.ts", classification: "offline" },
  { name: "scripts/test-null-posted-at-ordering.ts", command: "npx tsx scripts/test-null-posted-at-ordering.ts", classification: "offline" },
  { name: "scripts/test-ai-tools-panel.ts", command: "npx tsx scripts/test-ai-tools-panel.ts", classification: "offline" },
  { name: "scripts/test-search-track-rate-limits.ts", command: "npx tsx scripts/test-search-track-rate-limits.ts", classification: "offline" },
  { name: "scripts/test-early-access.ts", command: "npx tsx scripts/test-early-access.ts", classification: "offline" },
  { name: "scripts/test-attribution.ts", command: "npx tsx scripts/test-attribution.ts", classification: "offline" },
  { name: "scripts/test-admin-early-access.ts", command: "npx tsx scripts/test-admin-early-access.ts", classification: "offline" },
  { name: "scripts/test-admin-early-access-frontend.ts", command: "npx tsx scripts/test-admin-early-access-frontend.ts", classification: "offline" },
  { name: "scripts/test-stats-and-invite-gate.ts", command: "npx tsx scripts/test-stats-and-invite-gate.ts", classification: "offline" },
  { name: "scripts/test-plan-picker.ts", command: "npx tsx scripts/test-plan-picker.ts", classification: "offline" },
  { name: "scripts/test-plan-quota.ts", command: "npx tsx scripts/test-plan-quota.ts", classification: "offline" },
  { name: "scripts/test-landing-top-artifact.ts", command: "npx tsx scripts/test-landing-top-artifact.ts", classification: "offline" },
  { name: "scripts/test-quota-consume-razorpay.ts", command: "npx tsx scripts/test-quota-consume-razorpay.ts", classification: "offline" },
  { name: "scripts/test-billing-money-path.ts", command: "npx tsx scripts/test-billing-money-path.ts", classification: "offline" },
  { name: "scripts/test-plan-price-sync.ts", command: "npx tsx scripts/test-plan-price-sync.ts", classification: "offline" },
  { name: "scripts/test-netlify-billing.ts", command: "npx tsx scripts/test-netlify-billing.ts", classification: "offline" },
  { name: "scripts/test-razorpay-mode-isolation.ts", command: "npx tsx scripts/test-razorpay-mode-isolation.ts", classification: "offline" },
  { name: "scripts/test-policy-pages.ts", command: "npx tsx scripts/test-policy-pages.ts", classification: "offline" },
  { name: "scripts/test-ticker-paging-and-strip.ts", command: "npx tsx scripts/test-ticker-paging-and-strip.ts", classification: "offline" },
  { name: "scripts/test-lock-page-views-insert.ts", command: "npx tsx scripts/test-lock-page-views-insert.ts", classification: "offline" },
  { name: "scripts/test-admin-secret-bypass.ts", command: "npx tsx scripts/test-admin-secret-bypass.ts", classification: "offline" },
  { name: "scripts/test-landing-feature-visuals.ts", command: "npx tsx scripts/test-landing-feature-visuals.ts", classification: "offline" },
  { name: "scripts/test-landing-job-hub-stats.ts", command: "npx tsx scripts/test-landing-job-hub-stats.ts", classification: "offline" },
  { name: "scripts/test-landing-comparison-section.ts", command: "npx tsx scripts/test-landing-comparison-section.ts", classification: "offline" },
  { name: "scripts/test-backfill-company-logos.ts", command: "npx tsx scripts/test-backfill-company-logos.ts", classification: "offline" },
  { name: "scripts/test-company-logos-and-caps.ts", command: "npx tsx scripts/test-company-logos-and-caps.ts", classification: "offline" },
  { name: "scripts/test-logo-resolver-ssrf.ts", command: "npx tsx scripts/test-logo-resolver-ssrf.ts", classification: "offline" },
  { name: "scripts/test-ai-fallback-and-cover-letter.ts", command: "npx tsx scripts/test-ai-fallback-and-cover-letter.ts", classification: "offline" },
  { name: "scripts/test-ai-idempotency-replay.ts", command: "npx tsx scripts/test-ai-idempotency-replay.ts", classification: "offline" },
  { name: "scripts/test-global-ai-budget.ts", command: "npx tsx scripts/test-global-ai-budget.ts", classification: "offline" },
  { name: "scripts/test-error-boundaries.ts", command: "npx tsx scripts/test-error-boundaries.ts", classification: "offline" },
  { name: "scripts/test-cover-letter-cache-versioning.ts", command: "npx tsx scripts/test-cover-letter-cache-versioning.ts", classification: "offline" },
  { name: "scripts/test-groq-timeout-circuit-breaker.ts", command: "npx tsx scripts/test-groq-timeout-circuit-breaker.ts", classification: "offline" },
  { name: "scripts/test-web-vitals-analytics.ts", command: "npx tsx scripts/test-web-vitals-analytics.ts", classification: "offline" },
  { name: "scripts/test-failed-events-dead-letter.ts", command: "npx tsx scripts/test-failed-events-dead-letter.ts", classification: "offline" },
  { name: "scripts/test-lint-config.ts", command: "npx tsx scripts/test-lint-config.ts", classification: "offline" },
  { name: "scripts/test-security-audit-baseline.ts", command: "npx tsx scripts/test-security-audit-baseline.ts", classification: "offline" },
  { name: "scripts/test-database-safety.ts", command: "npx tsx scripts/test-database-safety.ts", classification: "offline" },
  { name: "scripts/test-seo-structured-data.ts", command: "npx tsx scripts/test-seo-structured-data.ts", classification: "offline" },
  { name: "scripts/test-email-unsubscribe.ts", command: "npx tsx scripts/test-email-unsubscribe.ts", classification: "offline" },

  // DB-capable suites: read operations (BLOCKED by default unless authorized on test project)
  { name: "scripts/test-enhanced-scoring.ts", command: "npx tsx scripts/test-enhanced-scoring.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-senior-scoring.ts", command: "npx tsx scripts/test-senior-scoring.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/daily-digest-cron.ts --dry", command: "npx tsx scripts/daily-digest-cron.ts --dry", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-counts.ts", command: "npx tsx scripts/test-counts.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-company-search.js", command: "node scripts/test-company-search.js", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-search-clauses.js", command: "node scripts/test-search-clauses.js", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-multiword-search.ts", command: "npx tsx scripts/test-multiword-search.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-radar-api.ts", command: "npx tsx scripts/test-radar-api.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-top10-ranking.ts", command: "npx tsx scripts/test-top10-ranking.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/test-task1-top10-complete.ts", command: "npx tsx scripts/test-task1-top10-complete.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/verify-guest-jobs-listing.js", command: "node scripts/verify-guest-jobs-listing.js", classification: "db-read", requiresSupabase: true },
  { name: "scripts/verify-paid-data-lock.js", command: "node scripts/verify-paid-data-lock.js", classification: "db-read", requiresSupabase: true },
  { name: "scripts/verify-salaries-clean.ts", command: "npx tsx scripts/verify-salaries-clean.ts", classification: "db-read", requiresSupabase: true },
  { name: "scripts/verify-search-worldwide.js", command: "node scripts/verify-search-worldwide.js", classification: "db-read", requiresSupabase: true },
  { name: "scripts/verify-top10-score-consistency.js", command: "node scripts/verify-top10-score-consistency.js", classification: "db-read", requiresSupabase: true },

  // DB-capable suites: write operations (BLOCKED by default unless authorized on test project)
  { name: "scripts/test-insert.ts", command: "npx tsx scripts/test-insert.ts", classification: "db-write", requiresSupabase: true },
  { name: "scripts/test-admin-suite.ts", command: "npx tsx scripts/test-admin-suite.ts", classification: "db-write", requiresSupabase: true },
  { name: "scripts/verify-account-stats-payment.js", command: "node scripts/verify-account-stats-payment.js", classification: "db-write", requiresSupabase: true },
  { name: "scripts/verify-security-critical2-3.ts", command: "npx tsx scripts/verify-security-critical2-3.ts", classification: "db-write", requiresSupabase: true },

  // DB-capable suites: anonymous write attempt (tests RLS denial; attempts insert/update)
  { name: "scripts/test-filters.ts", command: "npx tsx scripts/test-filters.ts", classification: "db-anon-write-attempt", requiresSupabase: true },
  { name: "scripts/check-plan-regression.mjs --selftest", command: "node scripts/check-plan-regression.mjs --selftest", classification: "offline" },
  { name: "scripts/test-pii-access-log.ts", command: "npx tsx scripts/test-pii-access-log.ts", classification: "offline" },
  { name: "scripts/test-dunning-dispatcher.ts", command: "npx tsx scripts/test-dunning-dispatcher.ts", classification: "offline" },
  { name: "scripts/test-matview-staleness.ts", command: "npx tsx scripts/test-matview-staleness.ts", classification: "offline" },
  { name: "scripts/test-data-classification.ts", command: "npx tsx scripts/test-data-classification.ts", classification: "offline" },
];

export interface RunSummary {
  passed: number;
  failed: number;
  skipped: number;
  blocked: number;
  skippedSuites: Array<{ name: string; reason: string }>;
  blockedSuites: Array<{ name: string; reason: string }>;
}

function main() {
  const summary: RunSummary = executeSuiteList(SUITES, {
    allowlist: TEST_PROJECT_ALLOWLIST,
    customDenied: DENIED_PROJECT_REFS,
  });
  if (summary.failed > 0) {
    process.exit(1);
  }
}

// Only invoke main when executed directly as script entrypoint
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main();
}
