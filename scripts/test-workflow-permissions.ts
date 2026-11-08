/**
 * Offline guard for GitHub Actions token permissions (Backend sheet row "Least-privilege Access Tokens").
 * Reads .github/workflows/*.yml as text. It does not call GitHub and cannot see the repository's default
 * workflow-token setting, so it proves a repo-side posture only.
 * Run: npx tsx scripts/test-workflow-permissions.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const DIR = ".github/workflows";
const files = fs.readdirSync(DIR).filter((n) => /\.ya?ml$/.test(n)).sort();

// Workflows with no top-level `permissions:` block today. They run with the repository default token
// permissions, which this test cannot see. Fixing means adding `permissions: contents: read` to each,
// which edits workflow files that docs/config-drift.md pins by hash, so it is a separate change.
// When a file gets its block, remove it here (the stale-entry check below enforces that).
const NO_EXPLICIT_PERMISSIONS_BASELINE = [
  "ci.yml",
  "daily-digest-cron.yml",
  "early-access-digest-cron.yml",
  "ingest.yml",
  "retention-cron.yml",
];

// Any non-read permission must be listed here with its reason.
const WRITE_ALLOWLIST: { [file: string]: string[] } = {
  "security-scan.yml": ["checks: write"],
};

function text(n: string) { return fs.readFileSync(DIR + "/" + n, "utf8"); }
function hasTopLevelPermissions(src: string) { return /^permissions:/m.test(src); }

check("workflow files found", files.length >= 10);

const missing = files.filter((n) => !hasTopLevelPermissions(text(n)));
check("files without a top-level permissions block match the baseline exactly (new workflows must declare permissions)",
  missing.join(",") === NO_EXPLICIT_PERMISSIONS_BASELINE.join(","));
check("every baseline entry is a real workflow file (no stale names)",
  NO_EXPLICIT_PERMISSIONS_BASELINE.every((n) => files.indexOf(n) >= 0));
check("every baseline entry still lacks permissions (remove it once the block is added)",
  NO_EXPLICIT_PERMISSIONS_BASELINE.every((n) => !hasTopLevelPermissions(text(n))));

check("no workflow uses write-all", files.every((n) => text(n).indexOf("write-all") < 0));
check("no workflow uses the pull_request_target trigger", files.every((n) => text(n).indexOf("pull_request_target") < 0));

const writes: string[] = [];
files.forEach((n) => {
  text(n).split("\n").forEach((line) => {
    const m = line.match(/^\s+([a-z-]+):\s*write\s*$/);
    if (m) writes.push(n + "|" + m[1] + ": write");
  });
});
const allowed: string[] = [];
Object.keys(WRITE_ALLOWLIST).forEach((f) => WRITE_ALLOWLIST[f].forEach((p) => allowed.push(f + "|" + p)));
check("every write permission is on the allowlist", writes.every((w) => allowed.indexOf(w) >= 0));
check("every allowlisted write permission still exists (no stale allowlist)", allowed.every((a) => writes.indexOf(a) >= 0));
check("declared top-level permissions default to contents: read",
  files.filter((n) => hasTopLevelPermissions(text(n))).every((n) => /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(text(n))));
check("no workflow hard-codes a token-looking value (ghp_ or github_pat_)",
  files.every((n) => !/ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}/.test(text(n))));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
