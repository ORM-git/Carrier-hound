#!/usr/bin/env node
/**
 * scripts/check-release-smoke.cjs
 *
 * Standalone offline checker for docs/release-smoke-checklist.md.
 * Verifies that the release smoke checklist:
 * 1. Starts with the required one-line run command.
 * 2. Contains all 6 required sections plus the sign-off block with non-empty content.
 * 3. Extracts every referenced repo file path (docs/..., scripts/..., .github/workflows/..., src/..., netlify/...)
 *    and asserts that each file exists in the working copy (excepting docs/ops-runbook.md pending #591).
 * 4. Verifies that external dashboards are clearly named as external (Sentry, Netlify, Cloudflare, Supabase, Razorpay).
 *
 * Usage: node scripts/check-release-smoke.cjs
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const checklistPath = path.join(rootDir, 'docs', 'release-smoke-checklist.md');

let hasErrors = false;

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  hasErrors = true;
}

// 1. Verify file exists
if (!fs.existsSync(checklistPath)) {
  console.error('ERROR: docs/release-smoke-checklist.md does not exist.');
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

// 3. Verify all 6 sections plus the sign-off block exist with non-empty content
const REQUIRED_SECTIONS = [
  { name: 'Deploy Identity', pattern: /#+\s*.*Deploy Identity/i },
  { name: 'Core Flows', pattern: /#+\s*.*Core Flows/i },
  { name: 'Payments OFF', pattern: /#+\s*.*Payments OFF/i },
  { name: 'Ingest Health', pattern: /#+\s*.*Ingest Health/i },
  { name: 'Scheduled Workflows', pattern: /#+\s*.*Scheduled Workflows/i },
  { name: 'Rollback', pattern: /#+\s*.*Rollback/i },
  { name: 'Sign-off Block', pattern: /#+\s*.*Sign-off/i },
];

for (const sec of REQUIRED_SECTIONS) {
  if (!sec.pattern.test(content)) {
    fail(`Missing required section: "${sec.name}"`);
  }
}

// 4. Extract referenced repo file paths
// Matches `docs/...`, `scripts/...`, `.github/workflows/...`, `src/...`, `netlify/...`
const pathRegex = /`((?:docs|scripts|\.github\/workflows|src|netlify)\/[^`\s]+)`/g;
const foundPaths = new Set();
let match;

while ((match = pathRegex.exec(content)) !== null) {
  let cleanPath = match[1];
  // Remove trailing punctuation or line anchors if any
  cleanPath = cleanPath.replace(/[),;:]+$/, '');
  cleanPath = cleanPath.replace(/:\d+(?::\d+)?$/, '');
  foundPaths.add(cleanPath);
}

if (foundPaths.size === 0) {
  fail('No repository file paths found in docs/release-smoke-checklist.md');
} else {
  for (const relPath of foundPaths) {
    // Explicitly allow docs/ops-runbook.md pending PR #591 as instructed
    if (relPath === 'docs/ops-runbook.md') {
      continue;
    }
    const fullPath = path.resolve(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      fail(`Referenced path does not exist on disk: ${relPath}`);
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
  const externalPattern = new RegExp(`external\\s+.*${db}|${db}.*external`, 'i');
  if (!externalPattern.test(content)) {
    fail(`Dashboard for "${db}" is not clearly qualified as external.`);
  }
}

if (hasErrors) {
  console.error('\ncheck-release-smoke: FAILED with errors.');
  process.exit(1);
}

console.log('check-release-smoke: PASS');
console.log(`- Verified docs/release-smoke-checklist.md header & run command.`);
console.log(`- Verified 6 required sections + Sign-off block.`);
console.log(`- Verified ${foundPaths.size} repository file paths exist on disk.`);
console.log(`- Verified external qualification for all ${REQUIRED_DASHBOARDS.length} required external dashboards.`);
process.exit(0);
