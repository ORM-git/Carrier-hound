/**
 * Static checks for BE#11 + BE#14: release versioning policy exists and
 * defines semver rules, tag format, release notes contents, and the
 * hotfix-from-tag rule. Run: npx tsx scripts/test-release-versioning-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/release-versioning.md", "utf8");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

check("marked INTERNAL", doc.includes("INTERNAL"));
check("documents current pinned 1.0.0 state", doc.includes("1.0.0"));
check("defines MAJOR rules", doc.includes("MAJOR") && doc.includes("breaking"));
check("defines MINOR rules", doc.includes("MINOR") && doc.includes("backward-compatible feature"));
check("defines PATCH rules", doc.includes("PATCH"));
check("annotated tag format vX.Y.Z", doc.includes("git tag -a v"));
check("release notes must list migrations + owner steps", doc.includes("NOT APPLIED") && doc.includes("owner follow-up"));
check("hotfix branches from tag, not main", doc.includes("hotfixes branch from the tag"));
check("links API versioning policy", doc.includes("docs/api-versioning.md"));
check("package.json version field is semver-shaped", /^\d+\.\d+\.\d+$/.test(pkg.version));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
