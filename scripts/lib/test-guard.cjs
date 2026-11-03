/**
 * scripts/lib/test-guard.cjs
 *
 * Core test containment and security guard for CareerMonke test suites.
 * Enforces:
 * - Strict suite classification (offline, db-read, db-write, db-anon-write-attempt; unknown = db-write)
 * - Explicit test-project allowlist (currently strictly EMPTY)
 * - Absolute production ref denial (szakevhxhwpeskidvtfs always denied)
 * - Child environment credential stripping (removes secret variables, never prints values)
 * - Output redaction for sensitive patterns
 * - Exit code definitions (0 = PASS, 1 = FAIL, 3 = BLOCKED)
 * - Safe suite list executor with network-denied child boundary
 */

"use strict";

const path = require("path");
const { spawnSync } = require("child_process");

const DENIED_PROJECT_REFS = Object.freeze(["szakevhxhwpeskidvtfs"]);

// Documented test-project allowlist. Strictly EMPTY by default.
// Must contain explicit non-production test project reference IDs to authorize execution.
const DEFAULT_TEST_PROJECT_ALLOWLIST = Object.freeze([]);

const SUITE_CLASSIFICATIONS = Object.freeze({
  // Pure offline unit & regression suites
  "scripts/test-admin-secret-bypass.ts": "offline",
  "scripts/test-lock-page-views-insert.ts": "offline",
  "scripts/test-ticker-paging-and-strip.ts": "offline",
  "scripts/test-country-eligibility-and-currency.ts": "offline",
  "scripts/test-trust-acceptance.ts": "offline",
  "scripts/test-salary-parser.ts": "offline",
  "scripts/test-ingestion-safety.ts": "offline",
  "scripts/test-ingest-regressions.ts": "offline",
  "scripts/verify-careerops-port.ts": "offline",
  "scripts/test-scrape.mjs": "offline",
  "scripts/test-admin-analytics-reads.ts": "offline",
  "scripts/test-radar-concurrency.ts": "offline",
  "scripts/test-account-delete-parallel.ts": "offline",
  "scripts/test-rate-limits.ts": "offline",
  "scripts/test-worldwide-view.ts": "offline",
  "scripts/test-domain-resolution.ts": "offline",
  "scripts/test-env-guards.ts": "offline",
  "scripts/test-sentry-config.ts": "offline",
  "scripts/test-no-hardcoded-stats.ts": "offline",
  "scripts/test-cookie-notice.ts": "offline",
  "scripts/test-admin-audit-log.ts": "offline",
  "scripts/test-xss-csp-ai-uploads.ts": "offline",
  "scripts/test-design-tokens.ts": "offline",
  "scripts/test-redesign-jobs-page.ts": "offline",
  "scripts/test-jobs-match-percentage.ts": "offline",
  "scripts/test-public-shell.ts": "offline",
  "scripts/test-loggedin-shell.ts": "offline",
  "scripts/test-jobs-list-detail.ts": "offline",
  "scripts/test-card-hover-match.ts": "offline",
  "scripts/test-razorpay-billing.ts": "offline",
  "scripts/test-profile-rebuild.ts": "offline",
  "scripts/test-auth-presentation.ts": "offline",
  "scripts/test-tracker-resume-rebuild.ts": "offline",
  "scripts/test-tracker-isolation.ts": "offline",
  "scripts/test-url-state-assertions.ts": "offline",
  "scripts/test-country-detection.ts": "offline",
  "scripts/test-compact-spacing.ts": "offline",
  "scripts/test-card-menu.ts": "offline",
  "scripts/test-search-track-rate-limits.ts": "offline",
  "scripts/test-early-access.ts": "offline",
  "scripts/test-stats-and-invite-gate.ts": "offline",
  "scripts/test-plan-picker.ts": "offline",
  "scripts/test-plan-quota.ts": "offline",
  "scripts/test-landing-top-artifact.ts": "offline",
  "scripts/test-landing-feature-visuals.ts": "offline",
  "scripts/test-landing-job-hub-stats.ts": "offline",
  "scripts/test-landing-comparison-section.ts": "offline",
  "scripts/test-quota-consume-razorpay.ts": "offline",
  "scripts/test-billing-money-path.ts": "offline",
  "scripts/test-plan-price-sync.ts": "offline",
  "scripts/test-netlify-billing.ts": "offline",
  "scripts/test-policy-pages.ts": "offline",
  "scripts/test-backfill-company-logos.ts": "offline",
  "scripts/test-company-logos-and-caps.ts": "offline",
  "scripts/test-logo-resolver-ssrf.ts": "offline",
  "scripts/test-ai-fallback-and-cover-letter.ts": "offline",
  "scripts/test-ai-idempotency-replay.ts": "offline",

  // DB-capable suites: read operations
  "scripts/test-enhanced-scoring.ts": "db-read",
  "scripts/test-senior-scoring.ts": "db-read",
  "scripts/daily-digest-cron.ts --dry": "db-read",
  "scripts/daily-digest-cron.ts": "db-read",
  "scripts/test-counts.ts": "db-read",
  "scripts/test-company-search.js": "db-read",
  "scripts/test-search-clauses.js": "db-read",
  "scripts/test-multiword-search.ts": "db-read",
  "scripts/test-radar-api.ts": "db-read",
  "scripts/test-top10-ranking.ts": "db-read",
  "scripts/test-task1-top10-complete.ts": "db-read",
  "scripts/verify-guest-jobs-listing.js": "db-read",
  "scripts/verify-paid-data-lock.js": "db-read",
  "scripts/verify-salaries-clean.ts": "db-read",
  "scripts/verify-search-worldwide.js": "db-read",
  "scripts/verify-top10-score-consistency.js": "db-read",

  // DB-capable suites: write operations
  "scripts/test-insert.ts": "db-write",
  "scripts/test-admin-suite.ts": "db-write",
  "scripts/verify-account-stats-payment.js": "db-write",
  "scripts/verify-security-critical2-3.ts": "db-write",

  // DB-capable suites: anonymous write attempt (tests RLS denial, attempts insert/update)
  "scripts/test-filters.ts": "db-anon-write-attempt",
});

const CREDENTIAL_ENV_VARS = Object.freeze([
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_KEY",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
  "RAZORPAY_KEY_ID",
  "RAZORPAY_KEY_SECRET",
  "GROQ_API_KEY",
  "GROQ_API_KEYS",
  "ADMIN_SECRET",
  "SENTRY_AUTH_TOKEN",
  "RESEND_API_KEY",
  "CRON_SECRET",
]);

const EXIT_CODES = Object.freeze({
  PASSED: 0,
  FAILED: 1,
  BLOCKED: 3,
});

/**
 * Normalizes suite path / name and returns its classification.
 * If unknown or unlisted, defaults strictly to "db-write".
 */
function classifySuite(suiteName) {
  if (!suiteName || typeof suiteName !== "string") {
    return "db-write";
  }
  const clean = suiteName.trim().replace(/^node\s+|^npx tsx\s+/, "");
  if (SUITE_CLASSIFICATIONS[clean]) {
    return SUITE_CLASSIFICATIONS[clean];
  }
  // Check without arguments if clean contains flags (e.g. daily-digest-cron.ts)
  const baseScript = clean.split(/\s+/)[0];
  if (SUITE_CLASSIFICATIONS[baseScript]) {
    return SUITE_CLASSIFICATIONS[baseScript];
  }
  // Unknown suite -> fail closed to db-write
  return "db-write";
}

/**
 * Returns true if the classification represents any DB-capable suite.
 */
function isDbCapable(classification) {
  return classification !== "offline";
}

/**
 * Extracts a Supabase project reference id from a URL or connection string.
 */
function extractProjectRef(urlOrString) {
  if (!urlOrString || typeof urlOrString !== "string") {
    return null;
  }
  const str = urlOrString.trim();

  // 1. Direct project ref pattern (15-30 lowercase alphanumeric characters)
  if (/^[a-z0-9_-]{15,30}$/.test(str)) {
    return str.toLowerCase();
  }

  // 2. https://<ref>.supabase.co
  const httpMatch = str.match(/https?:\/\/([a-z0-9_-]+)\.supabase\.co/i);
  if (httpMatch && httpMatch[1]) {
    return httpMatch[1].toLowerCase();
  }

  // 3. postgres://...@[db.]<ref>.supabase.co
  const pgMatch = str.match(/@(?:db\.)?([a-z0-9_-]+)\.supabase\.co/i);
  if (pgMatch && pgMatch[1]) {
    return pgMatch[1].toLowerCase();
  }

  return null;
}

/**
 * Validates whether the target project reference is authorized to run DB suites.
 * Strict rules:
 * 1. Production ref (szakevhxhwpeskidvtfs) is ALWAYS denied, even if present in allowlist.
 * 2. Missing, unknown, or empty target = BLOCKED before spawn.
 * 3. Empty allowlist = BLOCKED before spawn.
 * 4. Target ref not in allowlist = BLOCKED before spawn.
 */
function checkTargetAuthorization(options) {
  const opts = options || {};
  const target = opts.url || process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const allowlist = opts.allowlist || DEFAULT_TEST_PROJECT_ALLOWLIST;
  const customDenied = opts.customDenied || [];
  const allDenied = [...DENIED_PROJECT_REFS, ...customDenied];

  // 1. Check for production ref or denied substrings in target URL or custom ref
  const projectRef = extractProjectRef(target) || (typeof opts.projectRef === "string" ? opts.projectRef.trim().toLowerCase() : null);

  for (const denied of allDenied) {
    if (
      target.toLowerCase().includes(denied.toLowerCase()) ||
      (projectRef && projectRef.toLowerCase() === denied.toLowerCase())
    ) {
      return {
        authorized: false,
        reason: `Target matches strictly denied production ref '${denied}'`,
        projectRef,
        isProductionDeny: true,
      };
    }
  }

  // 2. Missing or unknown target project configuration
  if (!target || !projectRef) {
    return {
      authorized: false,
      reason: "Missing or unknown Supabase target URL / project reference",
      projectRef: null,
      isProductionDeny: false,
    };
  }

  // 3. Test project allowlist is empty
  if (!allowlist || allowlist.length === 0) {
    return {
      authorized: false,
      reason: "Test-project allowlist is empty; no test database configured",
      projectRef,
      isProductionDeny: false,
    };
  }

  // 4. Target ref not present in allowlist
  if (!allowlist.includes(projectRef)) {
    return {
      authorized: false,
      reason: `Target ref '${projectRef}' is not in test-project allowlist [${allowlist.join(", ")}]`,
      projectRef,
      isProductionDeny: false,
    };
  }

  // 5. Authorized for test database
  return {
    authorized: true,
    reason: `Target ref '${projectRef}' authorized in test allowlist`,
    projectRef,
    isProductionDeny: false,
  };
}

/**
 * Strips all credential-bearing variables from the environment object.
 * Returns { cleanEnv, strippedNames }.
 * NEVER outputs secret values.
 */
function stripCredentials(env) {
  const source = env || process.env;
  const cleanEnv = { ...source };
  const strippedNames = [];

  for (const key of Object.keys(cleanEnv)) {
    const isDirectMatch = CREDENTIAL_ENV_VARS.includes(key);
    const isPatternMatch =
      /^(?:NEXT_PUBLIC_)?SUPABASE.*(?:KEY|SECRET|URL)/i.test(key) ||
      /^STRIPE.*(?:KEY|SECRET)/i.test(key) ||
      /^RAZORPAY.*(?:ID|SECRET|KEY)/i.test(key) ||
      /^GROQ.*(?:KEY)/i.test(key) ||
      /^(?:DATABASE|POSTGRES)_URL/i.test(key) ||
      /^(?:ADMIN_SECRET|CRON_SECRET|RESEND_API_KEY|SENTRY_AUTH_TOKEN)$/i.test(key);

    if (isDirectMatch || isPatternMatch) {
      delete cleanEnv[key];
      strippedNames.push(key);
    }
  }

  return { cleanEnv, strippedNames };
}

/**
 * Masks sensitive tokens or credentials in logs/error messages.
 */
function redactOutput(text) {
  if (!text || typeof text !== "string") {
    return "";
  }
  return text
    .replace(/eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .replace(/sbp_[a-zA-Z0-9]{20,}/g, "[REDACTED_SUPABASE_TOKEN]")
    .replace(/(?:sk|pk)_(?:test|live)_[a-zA-Z0-9]{20,}/g, "[REDACTED_STRIPE_KEY]")
    .replace(/rzp_(?:test|live)_[a-zA-Z0-9]{14,}/g, "[REDACTED_RAZORPAY_KEY]")
    .replace(/gsk_[a-zA-Z0-9]{20,}/g, "[REDACTED_GROQ_KEY]");
}

/**
 * Executes a list of test suites within the containment sandbox.
 */
function executeSuiteList(suitesToRun, options) {
  const opts = options || {};
  const allowlist = opts.allowlist || DEFAULT_TEST_PROJECT_ALLOWLIST;
  const customDenied = opts.customDenied || DENIED_PROJECT_REFS;
  const baseEnv = opts.env || process.env;
  const quiet = opts.quiet ?? false;

  const auth = checkTargetAuthorization({
    allowlist,
    customDenied,
    url: baseEnv.NEXT_PUBLIC_SUPABASE_URL || baseEnv.SUPABASE_URL || "",
  });

  const { cleanEnv, strippedNames } = stripCredentials(baseEnv);

  if (!quiet) {
    console.log("================================================================================");
    console.log("CAREERMONKE TEST SUITE RUNNER");
    console.log(
      `Database Target: ${auth.authorized ? `AUTHORIZED [${auth.projectRef}]` : `BLOCKED (${auth.reason})`}`
    );
    if (strippedNames.length > 0) {
      console.log(
        `Environment Sanitization: Stripped ${strippedNames.length} credential variables from child boundary`
      );
    }
    console.log("================================================================================\n");
  }

  let passed = 0;
  let failed = 0;
  let blocked = 0;
  let skipped = 0;
  const skippedSuites = [];
  const blockedSuites = [];

  const denyNetworkPath = path.resolve(__dirname, "deny-network.cjs").replace(/\\/g, "/");
  const preloadArg = `--require "${denyNetworkPath}"`;

  for (const suite of suitesToRun) {
    const classification = suite.classification || classifySuite(suite.name);
    const needsDb = isDbCapable(classification);

    // Block DB-capable suites before spawning if not explicitly authorized
    if (needsDb && !auth.authorized) {
      if (!quiet) {
        console.log(`⏸️  [BLOCKED] ${suite.name} — ${auth.reason}`);
      }
      blocked++;
      blockedSuites.push({ name: suite.name, reason: auth.reason });
      continue;
    }

    const start = Date.now();
    const childEnv = {
      ...cleanEnv,
      NODE_OPTIONS: preloadArg,
      TEST_DB: "0",
    };

    const res = spawnSync(suite.command, {
      cwd: process.cwd(),
      encoding: "utf8",
      shell: true,
      timeout: 120000,
      env: childEnv,
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(2) + "s";
    const rawOutput = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
    const output = redactOutput(rawOutput);

    const isBlockedInChild = res.status === EXIT_CODES.BLOCKED || /(?:^|\n)\s*\[BLOCKED\]/i.test(output);
    const hasFailureMarker = /(?:^|\n)\s*(?:❌\s*FAIL|FAIL:|⚠️ SOME VERIFICATION TESTS FAILED|TEST SUITE FAILED)/i.test(output);
    const skipMatch = output.match(/(?:^|\n)\s*\[SKIPPED\]\s*(.*)/i);

    if (isBlockedInChild) {
      const blockReason =
        output.match(/(?:^|\n)\s*\[BLOCKED\]\s*(.*)/i)?.[1]?.trim() || "Blocked by test safety guard";
      if (!quiet) {
        console.log(`⏸️  [BLOCKED] ${suite.name} (${elapsed}) — ${blockReason}`);
      }
      blocked++;
      blockedSuites.push({ name: suite.name, reason: blockReason });
    } else if (skipMatch && res.status === 0) {
      const reason = skipMatch[1]?.trim() || "Skipped by safety gate";
      if (!quiet) {
        console.log(`⏸️  [SKIP]    ${suite.name} (${elapsed}) — ${reason}`);
      }
      skipped++;
      skippedSuites.push({ name: suite.name, reason });
    } else if (res.status === 0 && !hasFailureMarker) {
      if (!quiet) {
        console.log(`✅ [PASS]    ${suite.name} (${elapsed})`);
      }
      passed++;
    } else {
      if (!quiet) {
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
      }
      failed++;
    }
  }

  if (!quiet) {
    console.log("\n================================================================================");
    console.log(`SUMMARY: ${passed} passed, ${failed} failed, ${skipped} skipped, ${blocked} blocked`);
    if (skippedSuites.length > 0) {
      console.log("\nSKIPPED SUITES:");
      for (const s of skippedSuites) {
        console.log(`  - ${s.name}: ${s.reason}`);
      }
    }
    if (blockedSuites.length > 0) {
      console.log("\nBLOCKED SUITES:");
      for (const b of blockedSuites) {
        console.log(`  - ${b.name}: ${b.reason}`);
      }
    }
    console.log("================================================================================");
  }

  return {
    passed,
    failed,
    skipped,
    blocked,
    skippedSuites,
    blockedSuites,
  };
}

module.exports = {
  DENIED_PROJECT_REFS,
  DEFAULT_TEST_PROJECT_ALLOWLIST,
  SUITE_CLASSIFICATIONS,
  CREDENTIAL_ENV_VARS,
  EXIT_CODES,
  classifySuite,
  isDbCapable,
  extractProjectRef,
  checkTargetAuthorization,
  stripCredentials,
  redactOutput,
  executeSuiteList,
};
