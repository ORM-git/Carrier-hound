#!/usr/bin/env node
/**
 * scripts/check-ops-runbook.cjs
 *
 * Standalone offline reference guard for docs/ops-runbook.md.
 * Verifies:
 *   1. docs/ops-runbook.md exists and is non-empty.
 *   2. Required operational sections (Deploy, Rollback, Cron, Migration, Env, Incident) exist.
 *   3. All markdown link targets resolve document-relative from docs/ without root fallback.
 *   4. All backtick file paths and script invocations resolve to existing repository files.
 *   5. Narrow guards against reversed flags, fake Groq digest requirements, and blanket claims.
 *   6. Negative control (--negative-control) runs real validator on mutated runbooks and asserts failure.
 *
 * Usage:
 *   node scripts/check-ops-runbook.cjs
 *   node scripts/check-ops-runbook.cjs --negative-control
 */

"use strict";

const fs = require("fs");
const path = require("path");

const REPO_ROOT = path.resolve(__dirname, "..");
const DOCS_DIR = path.join(REPO_ROOT, "docs");
const RUNBOOK_PATH = path.join(DOCS_DIR, "ops-runbook.md");

const REQUIRED_SECTIONS = [
  "Deploy",
  "Rollback",
  "Cron",
  "Migration",
  "Env",
  "Incident",
];

/**
 * Validates runbook content string against repository files, required sections,
 * and semantic consistency guards.
 * @param {string} content
 * @returns {{ valid: boolean, errors: string[], verified: string[] }}
 */
function validateRunbookContent(content) {
  const errors = [];
  const verified = [];

  if (!content || !content.trim()) {
    errors.push("Runbook content is empty");
    return { valid: false, errors, verified };
  }

  // 1. Verify required operational sections
  for (const sec of REQUIRED_SECTIONS) {
    const reg = new RegExp(`(^|\\n)#{1,4}\\s+.*${sec}`, "i");
    if (!reg.test(content)) {
      errors.push(`Missing required operational section: ${sec}`);
    }
  }

  // 2. Validate markdown link targets document-relative from DOCS_DIR (no root fallback)
  const linkRegex = /\[[^\]]+\]\(([^)]+)\)/g;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(content)) !== null) {
    let target = linkMatch[1].trim();
    if (
      target.startsWith("http://") ||
      target.startsWith("https://") ||
      target.startsWith("#") ||
      target.startsWith("mailto:")
    ) {
      continue;
    }
    // Remove query params or anchors
    target = target.split("#")[0].split("?")[0].trim();
    if (!target) continue;

    // Must resolve relative to docs/ops-runbook.md
    const resolvedPath = path.resolve(DOCS_DIR, target);
    if (fs.existsSync(resolvedPath)) {
      const relToRepo = path.relative(REPO_ROOT, resolvedPath).replace(/\\/g, "/");
      verified.push(relToRepo);
    } else {
      errors.push(`Broken markdown link: [${target}] resolved to non-existent path: ${resolvedPath}`);
    }
  }

  // 3. Extract backtick code references: `target`
  const codeRegex = /`([^`\n]+)`/g;
  let codeMatch;
  while ((codeMatch = codeRegex.exec(content)) !== null) {
    const text = codeMatch[1].trim();

    // Script invocations: `node scripts/...`, `npx tsx scripts/...`
    const execMatches = text.matchAll(/(?:node|npx\s+tsx|cat|bash)\s+([a-zA-Z0-9_\-\.\/]+\.[a-zA-Z0-9]+)/g);
    for (const em of execMatches) {
      const scriptPath = em[1].replace(/^[.\/]+/, "");
      if (scriptPath.includes("/") || /\.(ts|cjs|mjs|js|sql)$/.test(scriptPath)) {
        const absPath = path.resolve(REPO_ROOT, scriptPath);
        if (fs.existsSync(absPath)) {
          verified.push(scriptPath);
        } else {
          errors.push(`Referenced script invocation does not exist: ${scriptPath}`);
        }
      }
    }

    // Direct path candidates
    const tokens = text.split(/[\s,]+/);
    for (let token of tokens) {
      token = token.replace(/^[('"`]+|[)'"`:;,]+$/g, "");
      if (!token || token.includes("<") || token.includes(">") || token.includes("*")) continue;
      if (token.startsWith("http://") || token.startsWith("https://")) continue;

      const isKnownDir =
        token.startsWith("scripts/") ||
        token.startsWith("docs/") ||
        token.startsWith(".github/workflows/") ||
        token.startsWith("supabase/") ||
        token.startsWith("src/") ||
        token.startsWith("public/") ||
        token.startsWith("budgets/") ||
        token.startsWith("netlify/");

      const isKnownRootFile = [
        "next.config.mjs",
        "netlify.toml",
        "package.json",
        ".node-version",
        ".env.example",
      ].includes(token);

      const hasFileExt = /\.(ts|tsx|cjs|mjs|js|json|sql|yml|yaml|md|toml)$/.test(token);

      if (isKnownDir || isKnownRootFile || (hasFileExt && token.includes("/"))) {
        const absPath = path.resolve(REPO_ROOT, token);
        if (fs.existsSync(absPath)) {
          verified.push(token);
        } else {
          errors.push(`Referenced repository path does not exist: ${token}`);
        }
      }
    }
  }

  // 4. Semantic Guard: Flag reversal checks for backfill scripts
  if (/backfill-job-descriptions\.ts[^\n|]*\|[^\n|]*Default:\s*DRY\s*RUN/i.test(content)) {
    errors.push("Invalid backfill flag: backfill-job-descriptions.ts must not be marked Default: DRY RUN (it writes by default)");
  }
  if (/backfill-job-descriptions\.ts[^\n|]*\|[^\n|]*--apply/i.test(content)) {
    errors.push("Invalid backfill flag: backfill-job-descriptions.ts writes by default and uses --dry/-d to simulate, not --apply");
  }
  if (/backfill-company-logos\.ts[^\n|]*\|[^\n|]*\|[^\n|]*--apply/i.test(content)) {
    errors.push("Invalid backfill flag: backfill-company-logos.ts uses --write to commit, not --apply");
  }
  if (/backfill-internships\.ts[^\n|]*\|[^\n|]*--dry/i.test(content)) {
    errors.push("Invalid backfill flag: backfill-internships.ts has no dry-run flag");
  }

  // 5. Semantic Guard: Daily digest cron must not claim Groq requirement
  if (/(?:daily-digest-cron|Daily Candidate Matching)[^\n]*\bGROQ\b/i.test(content) ||
      /GROQ_API_KEY[^\n]*(?:daily-digest-cron|Daily Candidate Matching)/i.test(content)) {
    errors.push("Invalid requirement: daily-digest-cron uses deterministic computeFitDiagnostics and must not claim a Groq requirement");
  }

  // 6. Semantic Guard: Disallow blanket ungrounded claims
  const blanketClaims = [
    { pattern: /every operational procedure verified/i, msg: "Blanket ungrounded claim: 'every operational procedure verified'" },
    { pattern: /\ball admin 401\b/i, msg: "Blanket ungrounded claim: 'all admin 401'" },
    { pattern: /\ball server 500\b/i, msg: "Blanket ungrounded claim: 'all server 500'" },
    { pattern: /zero table lock/i, msg: "Blanket ungrounded claim: 'zero table lock'" },
  ];
  for (const { pattern, msg } of blanketClaims) {
    if (pattern.test(content)) {
      errors.push(msg);
    }
  }

  // 7. Semantic Guard: schema_migrations column name & record-migration extension
  if (/SELECT\s+name\s*,\s*checksum\s*,\s*applied_at\s+FROM\s+public\.schema_migrations/i.test(content)) {
    errors.push("Invalid SQL: schema_migrations column is filename, not name");
  }
  if (/record-migration\.cjs\s+<timestamp>_<name>(?!\.sql)/i.test(content)) {
    errors.push("Invalid migration record syntax: record-migration.cjs requires .sql extension");
  }

  // 8. Semantic Guard: Database purge function name
  if (/purge_soft_deleted_accounts\b/i.test(content)) {
    errors.push("Invalid function name: purge_soft_deleted_accounts() does not exist; the actual database function is public.purge_soft_deleted_account_data()");
  }

  // 9. Semantic Guard: country_code backfill invalid ISO repair claim
  if (/backfill-country-code\.ts[^\n]*invalid\s+ISO/i.test(content)) {
    errors.push("Invalid backfill claim: backfill-country-code.ts strictly selects and updates rows where country_code IS NULL; it does not repair invalid ISO-2 format");
  }

  // 10. Semantic Guard: company-logos backfill manifest & storage key claims
  if (/(?:reviewed\s+)?(?:json\s+)?manifest\s+(?:file\s+)?required\s+for\s+(?:live\s+)?write/i.test(content)) {
    errors.push("Invalid manifest claim: manifest is optional in backfill-company-logos.ts; --write writes regardless");
  }
  if (/prevent\s+DB\s+overwrites/i.test(content) || /preserve\s+old\s+DB\s+values/i.test(content)) {
    errors.push("Invalid storage claim: versioned keys in storage bucket preserve old storage objects, not old DB values (DB logo_url replacement is intentional)");
  }

  // 11. Semantic Guard: UI paywall is not an API endpoint
  if (/paywall[^\n]*\b503\b/i.test(content)) {
    errors.push("Invalid API claim: UI paywall is not an API endpoint; billing order and verify endpoints return 503");
  }

  // 12. Semantic Guard: GROQ_API_KEY alone does not guarantee 500
  if (/\bGROQ_API_KEY\b[^\n]*returns\s+500[^\n]*before\s+quota/i.test(content) && !/AI_PROVIDER_KEY/i.test(content)) {
    errors.push("Invalid AI env claim: missing GROQ_API_KEY alone does not guarantee 500; AI_PROVIDER_KEY and GROQ_KEY are also accepted");
  }

  // 13. Semantic Guard: Razorpay routes breakdown & mode handling
  if (!/Order Creation/i.test(content) || !/Payment Verification/i.test(content) || !/Webhook Handler/i.test(content)) {
    errors.push("Missing billing breakdown: billing order creation, payment verification, and webhook handlers must be split into separate rows");
  }
  if (!/accepts?\s+known\s+live\s+\(?`?rzp_live_`?\)?\s+OR\s+test\s+\(?`?rzp_test_`?\)?\s+mode/i.test(content)) {
    errors.push("Invalid billing mode claim: verify/webhook handlers must document accepting known live OR test mode and rejecting unknown mode");
  }

  // 14. Semantic Guard: Webhook 404 condition accuracy
  if (/Webhook[^\n]*Order row lookup in payment_orders missing returns 404/i.test(content)) {
    errors.push("Invalid webhook claim: missing payment_orders row does not directly return 404; 404 occurs only when userId cannot be resolved from notes or DB row");
  }

  const uniqueVerified = Array.from(new Set(verified)).sort();
  return {
    valid: errors.length === 0,
    errors,
    verified: uniqueVerified,
  };
}

function runNegativeControl(realContent) {
  console.log("=== Running --negative-control test on real validator ===");

  // Mutation 1: Mutated runbook with a broken relative markdown link
  const mutatedLinkContent = realContent + "\n\n[Broken Link Test](../scripts/non_existent_fake_script_xyz.ts)\n";
  const resLink = validateRunbookContent(mutatedLinkContent);
  if (resLink.valid || !resLink.errors.some((e) => e.includes("non_existent_fake_script_xyz.ts"))) {
    console.error("[FAIL] Real validator failed to reject mutated runbook with broken link.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught mutated invalid link");

  // Mutation 2: Mutated runbook with missing required operational section
  const mutatedSectionContent = realContent.replace(/##\s+6\.\s+Incident[\s\S]*$/, "");
  const resSec = validateRunbookContent(mutatedSectionContent);
  if (resSec.valid || !resSec.errors.some((e) => e.includes("Incident"))) {
    console.error("[FAIL] Real validator failed to reject mutated runbook with missing section.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught missing operational section");

  // Mutation 3: Mutated runbook with reversed backfill flag (claiming job descriptions is dry-run by default)
  const mutatedFlagContent = realContent.replace(
    /`scripts\/backfill-job-descriptions\.ts`\s*\|\s*`--dry`[^\n|]*\|\s*\*\*LIVE WRITE BY DEFAULT\*\*/,
    "`scripts/backfill-job-descriptions.ts` | **Default: DRY RUN** | `--apply`"
  );
  const resFlag = validateRunbookContent(mutatedFlagContent);
  if (resFlag.valid || !resFlag.errors.some((e) => e.includes("backfill-job-descriptions.ts"))) {
    console.error("[FAIL] Real validator failed to reject reversed backfill flags.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught reversed backfill flag");

  // Mutation 4: Mutated runbook with fake Groq requirement for daily digest
  const mutatedGroqContent = realContent.replace(
    /`computeFitDiagnostics`[^\n|]*/,
    "Groq LLM API candidate scoring"
  );
  const resGroq = validateRunbookContent(mutatedGroqContent);
  if (resGroq.valid || !resGroq.errors.some((e) => e.includes("Groq requirement"))) {
    console.error("[FAIL] Real validator failed to reject fake Groq requirement for digest cron.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught fake Groq requirement for digest cron");

  // Mutation 5: Mutated runbook with blanket claim
  const mutatedBlanketContent = realContent + "\n\nNote: every operational procedure verified across all hosts.\n";
  const resBlanket = validateRunbookContent(mutatedBlanketContent);
  if (resBlanket.valid || !resBlanket.errors.some((e) => e.includes("Blanket ungrounded claim"))) {
    console.error("[FAIL] Real validator failed to reject blanket ungrounded claim.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught blanket ungrounded claim");

  // Mutation 6: Mutated runbook with invented function name purge_soft_deleted_accounts
  const mutatedPurgeContent = realContent.replace(
    "public.purge_soft_deleted_account_data()",
    "public.purge_soft_deleted_accounts()"
  );
  const resPurge = validateRunbookContent(mutatedPurgeContent);
  if (resPurge.valid || !resPurge.errors.some((e) => e.includes("purge_soft_deleted_accounts() does not exist"))) {
    console.error("[FAIL] Real validator failed to reject invented function name purge_soft_deleted_accounts.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught invented function name purge_soft_deleted_accounts");

  // Mutation 7: Mutated runbook claiming country_code backfill repairs invalid ISO-2
  const mutatedIsoContent = realContent.replace(
    "Writes only where `country_code IS NULL`",
    "Writes only where `country_code IS NULL` or invalid ISO-2 format"
  );
  const resIso = validateRunbookContent(mutatedIsoContent);
  if (resIso.valid || !resIso.errors.some((e) => e.includes("repair invalid ISO-2"))) {
    console.error("[FAIL] Real validator failed to reject invalid ISO-2 repair claim in country-code backfill.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught invalid ISO-2 repair claim in country-code backfill");

  // Mutation 8: Mutated runbook claiming manifest is required for logo write
  const mutatedManifestContent = realContent.replace(
    "manifest is not required for write",
    "Reviewed JSON manifest file required for write"
  );
  const resManifest = validateRunbookContent(mutatedManifestContent);
  if (resManifest.valid || !resManifest.errors.some((e) => e.includes("manifest is optional"))) {
    console.error("[FAIL] Real validator failed to reject manifest required claim for company logos.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught manifest required claim for company logos");

  // Mutation 9: Mutated runbook claiming storage keys prevent DB overwrites
  const mutatedStorageContent = realContent.replace(
    "Versioned keys in storage bucket preserve old storage objects, not old DB values.",
    "Versioned storage keys prevent DB overwrites."
  );
  const resStorage = validateRunbookContent(mutatedStorageContent);
  if (resStorage.valid || !resStorage.errors.some((e) => e.includes("preserve old storage objects, not old DB values"))) {
    console.error("[FAIL] Real validator failed to reject storage keys prevent DB overwrites claim.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught storage keys prevent DB overwrites claim");

  // Mutation 10: Mutated runbook claiming UI paywall returns 503
  const mutatedPaywallContent = realContent.replace(
    "billing API endpoints (`/api/billing/razorpay/order`, `/api/billing/razorpay/verify`, and Netlify billing functions) return 503",
    "paywall and checkout routes return 503"
  );
  const resPaywall = validateRunbookContent(mutatedPaywallContent);
  if (resPaywall.valid || !resPaywall.errors.some((e) => e.includes("UI paywall is not an API endpoint"))) {
    console.error("[FAIL] Real validator failed to reject UI paywall returns 503 claim.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught UI paywall returns 503 claim");

  // Mutation 11: Mutated runbook claiming missing GROQ_API_KEY alone guarantees 500
  const mutatedGroqAloneContent = realContent.replace(
    /`GROQ_API_KEY`[^\n]*Check executes before debiting user quota[^\n]*/,
    "`GROQ_API_KEY` | Edge AI Routes | When missing, returns 500 before quota debit"
  );
  const resGroqAlone = validateRunbookContent(mutatedGroqAloneContent);
  if (resGroqAlone.valid || !resGroqAlone.errors.some((e) => e.includes("missing GROQ_API_KEY alone does not guarantee 500"))) {
    console.error("[FAIL] Real validator failed to reject missing GROQ_API_KEY alone guarantees 500 claim.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught GROQ_API_KEY alone claim");

  // Mutation 12: Mutated runbook claiming missing payment_orders row directly returns 404 in webhook
  const mutatedWebhook404Content = realContent.replace(
    /`userId` unresolvable from payload notes[^\n]*fulfil_payment_order` RPC\);/,
    "Order row lookup in payment_orders missing returns 404 ORDER_NOT_FOUND;"
  );
  const resWebhook404 = validateRunbookContent(mutatedWebhook404Content);
  if (resWebhook404.valid || !resWebhook404.errors.some((e) => e.includes("missing payment_orders row does not directly return 404"))) {
    console.error("[FAIL] Real validator failed to reject false webhook 404 claim.");
    process.exit(1);
  }
  console.log("  ✓ Real validator correctly caught false webhook 404 claim");

  console.log("[PASS] Negative control verified: real validator fails on mutated runbooks across all 12 checks.");
  process.exit(0);
}

function main() {
  console.log("=== Checking Operational Runbook Guard ===");

  if (!fs.existsSync(RUNBOOK_PATH)) {
    console.error(`[FAIL] docs/ops-runbook.md not found at ${RUNBOOK_PATH}`);
    process.exit(1);
  }

  const content = fs.readFileSync(RUNBOOK_PATH, "utf8");

  if (process.argv.includes("--negative-control")) {
    runNegativeControl(content);
    return;
  }

  const result = validateRunbookContent(content);

  console.log(`Discovered ${result.verified.length} unique file & script references.`);

  if (!result.valid) {
    console.error(`\n[FAIL] Found ${result.errors.length} validation errors in docs/ops-runbook.md:`);
    for (const err of result.errors) {
      console.error(`  ✗ ${err}`);
    }
    process.exit(1);
  }

  if (result.verified.length < 25) {
    console.error(`\n[FAIL] Expected at least 25 verified file citations, found only ${result.verified.length}.`);
    process.exit(1);
  }

  console.log(`[PASS] Verified ${result.verified.length} existing files & scripts:`);
  for (const f of result.verified) {
    console.log(`  ✓ ${f}`);
  }

  console.log(`\n[SUCCESS] docs/ops-runbook.md passed all checks (${result.verified.length} verified references, 0 errors).`);
}

main();
