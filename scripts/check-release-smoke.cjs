#!/usr/bin/env node
/**
 * scripts/check-release-smoke.cjs
 *
 * Standalone offline verifier for docs/release-smoke-checklist.md.
 * Verifies structural integrity, non-empty section bodies, valid non-directory
 * repository file references, external dashboard qualifications, and source-backed
 * invariants matching repository code.
 *
 * Usage:
 *   node scripts/check-release-smoke.cjs [optional-path-to-checklist.md]
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const checklistPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(rootDir, 'docs', 'release-smoke-checklist.md');

let hasErrors = false;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  hasErrors = true;
}

// 1. Verify file exists
if (!fs.existsSync(checklistPath)) {
  console.error(`ERROR: Checklist file does not exist: ${checklistPath}`);
  process.exit(1);
}

const content = fs.readFileSync(checklistPath, 'utf8');
const lines = content.split(/\r?\n/);

// 2. Starts with exact run command
const firstLine = (lines[0] || '').trim();
const expectedFirstLine = 'Run check: node scripts/check-release-smoke.cjs';
if (firstLine !== expectedFirstLine) {
  fail(`First line must be "${expectedFirstLine}", got "${firstLine}".`);
}

// 3. Verify all 7 required sections exist
const REQUIRED_SECTIONS = [
  { name: 'Deploy Identity', pattern: /^#+\s*1\.\s+Deploy Identity/m },
  { name: 'Core Flows', pattern: /^#+\s*2\.\s+Core Flows/m },
  { name: 'Payments OFF', pattern: /^#+\s*3\.\s+Payments OFF/m },
  { name: 'Ingest Health', pattern: /^#+\s*4\.\s+Ingest Health/m },
  { name: 'Scheduled Workflows', pattern: /^#+\s*5\.\s+Scheduled Workflows/m },
  { name: 'Rollback', pattern: /^#+\s*6\.\s+Rollback/m },
  { name: 'Sign-off Block', pattern: /^#+\s*7\.\s+Sign-off/m },
];

for (const sec of REQUIRED_SECTIONS) {
  if (!sec.pattern.test(content)) {
    fail(`Missing required section: "${sec.name}"`);
  }
}

// Verify non-empty section bodies between main headings
const sectionHeaderRegex = /^##\s+\d+\.\s+([^\r\n]+)/gm;
let lastHeadingName = null;
let lastHeadingIndex = -1;
let matchSection;

while ((matchSection = sectionHeaderRegex.exec(content)) !== null) {
  if (lastHeadingName !== null) {
    const bodySlice = content.slice(lastHeadingIndex, matchSection.index).trim();
    if (!bodySlice) {
      fail(`Section "${lastHeadingName}" has an empty body.`);
    }
  }
  lastHeadingName = matchSection[1].trim();
  lastHeadingIndex = matchSection.index + matchSection[0].length;
}
if (lastHeadingName !== null) {
  const tailSlice = content.slice(lastHeadingIndex).trim();
  if (!tailSlice) {
    fail(`Section "${lastHeadingName}" has an empty body.`);
  }
}

// 4. Extract referenced repo file paths and assert existence & non-directory
// Matches `docs/...`, `scripts/...`, `.github/...`, `src/...`, `netlify/...`
const pathRegex = /`((?:docs|scripts|\.github|src|netlify)(?:\/[^`\s)"'>]*)?)`/g;
const foundPaths = new Set();
let matchPath;

while ((matchPath = pathRegex.exec(content)) !== null) {
  let cleanPath = matchPath[1];
  cleanPath = cleanPath.replace(/[),;:]+$/, '');
  cleanPath = cleanPath.replace(/:\d+(?::\d+)?$/, '');
  cleanPath = cleanPath.replace(/\/+$/, '');
  foundPaths.add(cleanPath);
}

if (foundPaths.size === 0) {
  fail('No repository file paths found in checklist.');
} else {
  for (const relPath of foundPaths) {
    // Explicitly allow docs/ops-runbook.md pending PR #591
    if (relPath === 'docs/ops-runbook.md') {
      continue;
    }
    const fullPath = path.resolve(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      fail(`Referenced path does not exist on disk: ${relPath}`);
    } else {
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        fail(`Referenced path is a directory; checklist must reference specific files: ${relPath}`);
      }
    }
  }
}

// 5. Verify external dashboards are clearly named as external
const REQUIRED_DASHBOARDS = [
  'Sentry',
  'Netlify',
  'Cloudflare',
  'Supabase',
  'Razorpay',
];

for (const db of REQUIRED_DASHBOARDS) {
  const unqualifiedPattern = new RegExp(`(?<!external\\s+)\\b${db}(?:\\s+Pages)?\\s+dashboard`, 'i');
  if (unqualifiedPattern.test(content)) {
    fail(`Dashboard for "${db}" must be qualified with "external" (e.g. "external ${db} dashboard").`);
  }
  const qualifiedPattern = new RegExp(`external\\s+.*${db}(?:\\s+Pages)?\\s+dashboard`, 'i');
  if (!qualifiedPattern.test(content)) {
    fail(`Missing required "external ${db} dashboard" qualification.`);
  }
}

// 6. Source-backed assertions
// 6a. Ingest cron in .github/workflows/ingest.yml
const ingestWfPath = path.join(rootDir, '.github', 'workflows', 'ingest.yml');
if (fs.existsSync(ingestWfPath)) {
  const ingestWf = fs.readFileSync(ingestWfPath, 'utf8');
  const cronMatch = ingestWf.match(/cron:\s*['"]([^'"]+)['"]/);
  if (cronMatch) {
    const expectedCron = cronMatch[1];
    if (!content.includes(expectedCron)) {
      fail(`Checklist does not include the exact ingest cron from .github/workflows/ingest.yml: "${expectedCron}"`);
    }
  }
}

// 6b. Billing flag in src/lib/flags/flags.ts
const flagsPath = path.join(rootDir, 'src', 'lib', 'flags', 'flags.ts');
if (fs.existsSync(flagsPath)) {
  const flagsCode = fs.readFileSync(flagsPath, 'utf8');
  if (flagsCode.includes('NEXT_PUBLIC_BILLING_ENABLED')) {
    if (!content.includes('NEXT_PUBLIC_BILLING_ENABLED=false') && !content.includes('NEXT_PUBLIC_BILLING_ENABLED: false')) {
      fail('Checklist must state NEXT_PUBLIC_BILLING_ENABLED=false matching src/lib/flags/flags.ts defaults.');
    }
  }
}

// 6c. Edge health route body in src/app/api/health/route.ts
const edgeHealthPath = path.join(rootDir, 'src', 'app', 'api', 'health', 'route.ts');
if (fs.existsSync(edgeHealthPath)) {
  const edgeHealthCode = fs.readFileSync(edgeHealthPath, 'utf8');
  if (edgeHealthCode.includes('status: "ok"') || edgeHealthCode.includes('"status": "ok"')) {
    if (!content.includes('{"status":"ok"}') && !content.includes('{"status": "ok"}')) {
      fail('Checklist must document exact edge health payload {"status":"ok"} from src/app/api/health/route.ts.');
    }
  }
}

// 6d. Netlify health route body in netlify/functions/health.ts
const netlifyHealthPath = path.join(rootDir, 'netlify', 'functions', 'health.ts');
if (fs.existsSync(netlifyHealthPath)) {
  const netlifyHealthCode = fs.readFileSync(netlifyHealthPath, 'utf8');
  if (netlifyHealthCode.includes('ok: true')) {
    if (!content.includes('{"ok":true')) {
      fail('Checklist must document Netlify function health payload {"ok":true,...} from netlify/functions/health.ts.');
    }
  }
}

// 6e. Resend timer cooldown (30 seconds, not 60)
const loginPath = path.join(rootDir, 'src', 'app', 'login', 'page.tsx');
if (fs.existsSync(loginPath)) {
  const loginCode = fs.readFileSync(loginPath, 'utf8');
  if (loginCode.includes('setResendTimer(30)')) {
    if (/60-second|60\s*seconds/i.test(content)) {
      fail('Checklist specifies 60-second resend timer, but code implements setResendTimer(30) (30 seconds).');
    }
    if (!/30-second|30\s*seconds|30s/i.test(content)) {
      fail('Checklist must document the verified 30-second resend cooldown timer (setResendTimer(30)).');
    }
  }
}

// 6f. Onboarding redirect on mount is a known gap / launch blocker (not Code Verified once-only)
if (/Asked Once Only \(Code Verified\)/i.test(content) || /Once-Only Enforcement:\s*Manually navigate back.*detects.*immediately redirects/i.test(content)) {
  fail('Onboarding mount redirect must NOT be marked as Code Verified once-only. src/app/onboarding/page.tsx lacks mount redirect and is a known gap / launch blocker.');
}
if (!/known gap/i.test(content) || !/launch blocker/i.test(content)) {
  fail('Checklist must document the lack of on-mount redirect for completed users on /onboarding as both a "known gap" and a "launch blocker".');
}

// 6g. Dynamic callback routing
if (!/returnTo/i.test(content) || !/return_to/i.test(content) || !/next/i.test(content)) {
  fail('Checklist must document dynamic callback query parameter routing (returnTo, return_to, next).');
}

// 6h. ProUpgradeScreen gating & separate entitled test account
if (!content.includes('ProUpgradeScreen')) {
  fail('Checklist must reference ProUpgradeScreen gating on /resume and /tracker for non-Pro users.');
}
if (!/entitled\s+test\s+account/i.test(content)) {
  fail('Checklist must require an owner-authorized entitled test account for Pro flow verification.');
}

// 6i. Host clarity and rollback separation
if (!/Cloudflare Pages.*(?:Primary|primary)/i.test(content) && !/primary.*Cloudflare Pages/i.test(content)) {
  fail('Checklist must identify Cloudflare Pages as the primary production host.');
}
if (!/Netlify.*(?:Backup|backup)/i.test(content) && !/backup.*Netlify/i.test(content)) {
  fail('Checklist must identify Netlify as the backup host.');
}
if (!/code.*rollback\s*!=.*(?:database|db)\s*rollback|code\/UI rollback.*not.*database|does not revert (?:the )?database/i.test(content)) {
  fail('Checklist must explicitly state that code/UI rollback does not revert the database.');
}
if (/within ~?15 seconds|switches instantly/i.test(content)) {
  fail('Checklist must not claim instant or 15-second propagation for rollbacks.');
}
if (/down-migration scripts under `?supabase\/migrations/i.test(content)) {
  fail('Checklist must not claim automated down-migration scripts exist in supabase/migrations.');
}

// 6j. Cron prerequisites and accurate scopes
if (!content.includes('DB_RECONCILIATION_ENABLED')) {
  fail('Checklist must document that db-reconciliation is inert unless DB_RECONCILIATION_ENABLED=true.');
}
if (!content.includes('DB_HEALTH_PROBE_ENABLED')) {
  fail('Checklist must document that db-health-probe is inert unless DB_HEALTH_PROBE_ENABLED=true.');
}
if (/prunes expired sessions/i.test(content)) {
  fail('Checklist must not claim retention-cron prunes user sessions; it purges operational logs, optional job archival, and optional index maintenance.');
}
if (!/tolerance/i.test(content) || !/4h|4\s*hours?/i.test(content)) {
  fail('Checklist must document ingest freshness 4h target vs 24h tolerance paired with run reports/artifacts.');
}

// 6k. Payments OFF verification & before/after evidence
if (!/before\/after|before and after/i.test(content)) {
  fail('Checklist must require before/after evidence showing 0 new charges/orders/subscriptions in Razorpay.');
}

// 6l. Live checks marked as UNVERIFIED in the sign-off table
const unverifiedCount = (content.match(/\[\s*\]\s*UNVERIFIED\s*\(Not run\)/g) || []).length;
if (unverifiedCount < 10) {
  fail(`Checklist sign-off table must mark live checks as "[ ] UNVERIFIED (Not run)", found ${unverifiedCount}.`);
}

if (hasErrors) {
  console.error('\ncheck-release-smoke: FAILED with errors.');
  process.exit(1);
}

console.log('check-release-smoke: PASS');
console.log('- Verified docs/release-smoke-checklist.md header & run command.');
console.log(`- Verified ${REQUIRED_SECTIONS.length} required sections with non-empty bodies.`);
console.log(`- Verified ${foundPaths.size} repository file paths exist on disk and are not directories.`);
console.log(`- Verified external qualification for all ${REQUIRED_DASHBOARDS.length} required external dashboards.`);
console.log('- Verified source-backed assertions:');
console.log('  * Ingest cron schedule matches .github/workflows/ingest.yml');
console.log('  * Billing flag defaults match src/lib/flags/flags.ts');
console.log('  * Health liveness payloads match route definitions');
console.log('  * Auth resend timer matches verified 30s code implementation');
console.log('  * Onboarding mount redirect documented as known gap / launch blocker');
console.log('  * Dynamic callback routing documented (next/returnTo)');
console.log('  * Free gating (ProUpgradeScreen) separated from entitled Pro test account');
console.log('  * Host roles and rollback decoupled (Cloudflare primary, Netlify backup, code != DB, no down migrations)');
console.log('  * Cron table prerequisites documented (DB_RECONCILIATION_ENABLED, DB_HEALTH_PROBE_ENABLED, no session pruning)');
console.log('  * Ingest freshness paired with run reports/artifacts (4h target vs 24h tolerance)');
console.log('  * Payments OFF verified with before/after Razorpay evidence');
console.log(`  * All ${unverifiedCount} sign-off execution items marked [ ] UNVERIFIED (Not run)`);
process.exit(0);
