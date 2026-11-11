/**
 * Config drift check (docs/config-drift.md).
 *
 * Deployment and CI configuration lives in repo files (netlify.toml,
 * next.config.mjs, package.json build scripts, GitHub Actions workflows)
 * while the Cloudflare Pages / Netlify dashboards hold the remaining
 * clickops settings. Nothing else notices when one of the repo files
 * changes outside an intentional PR, so this script pins a sha256 baseline
 * (scripts/config-drift-baseline.json) and fails CI when a covered file
 * changes without the baseline being updated in the same change.
 *
 * Usage:
 *   npx tsx scripts/check-config-drift.ts          # verify (CI)
 *   npx tsx scripts/check-config-drift.ts --update # regenerate baseline
 *
 * Intentional config change = edit the file AND regenerate the baseline in
 * the same PR, so the diff reviewer sees both.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const BASELINE_PATH = path.join(REPO_ROOT, "scripts", "config-drift-baseline.json");

/** Repo files that define deployment/build/CI behavior. */
const COVERED_FILES = [
  "netlify.toml",
  "next.config.mjs",
  "package.json",
  "scripts/suite-runner.ts",
  ".github/workflows/board-ingest.yml",
  ".github/workflows/capacity-report-cron.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/daily-digest-cron.yml",
  ".github/workflows/early-access-digest-cron.yml",
  ".github/workflows/ingest.yml",
  ".github/workflows/license-guard.yml",
  ".github/workflows/plan-regression.yml",
  ".github/workflows/quality-advisory.yml",
  ".github/workflows/retention-cron.yml",
  ".github/workflows/security-scan.yml",
  ".github/workflows/source-health-cron.yml",
  ".github/workflows/workflow-failure-alert.yml",
] as const;

type Baseline = {
  version: 1;
  generated: string;
  files: Record<string, string>;
};

function sha256Of(relPath: string): string | null {
  const abs = path.join(REPO_ROOT, relPath);
  if (!existsSync(abs)) return null;
  return createHash("sha256").update(readFileSync(abs)).digest("hex");
}

function computeHashes(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of COVERED_FILES) {
    const h = sha256Of(f);
    if (h) out[f] = h;
  }
  return out;
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) {
    console.error(`Baseline missing at ${BASELINE_PATH}. Run with --update to create it.`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline;
}

function writeBaseline(): void {
  const baseline: Baseline = {
    version: 1,
    generated: new Date().toISOString().slice(0, 10),
    files: computeHashes(),
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`Baseline written: ${Object.keys(baseline.files).length} files pinned.`);
}

function verify(): void {
  const baseline = loadBaseline();
  const drifted: string[] = [];
  const missing: string[] = [];

  for (const [file, pinned] of Object.entries(baseline.files)) {
    const current = sha256Of(file);
    if (current === null) missing.push(file);
    else if (current !== pinned) drifted.push(file);
  }

  for (const file of COVERED_FILES) {
    if (!(file in baseline.files) && sha256Of(file)) {
      drifted.push(`${file} (not in baseline)`);
    }
  }

  if (missing.length === 0 && drifted.length === 0) {
    console.log(`Config drift check passed: ${Object.keys(baseline.files).length} files match the pinned baseline.`);
    return;
  }

  for (const f of missing) console.error(`MISSING: ${f} is pinned in the baseline but no longer exists.`);
  for (const f of drifted) console.error(`DRIFTED: ${f} changed without a baseline update.`);
  console.error(
    "\nIf this change is intentional, regenerate the baseline in the same PR:\n" +
      "  npx tsx scripts/check-config-drift.ts --update\n" +
      "See docs/config-drift.md.",
  );
  process.exit(1);
}

if (process.argv.includes("--update")) writeBaseline();
else verify();
