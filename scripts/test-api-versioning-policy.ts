/**
 * Static checks for BE#10: API versioning policy exists, keeps /api/*
 * unversioned while private, and defines the v1 trigger + deprecation rule.
 * Run: npx tsx scripts/test-api-versioning-policy.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/api-versioning.md", "utf8");

check("marked INTERNAL", doc.includes("INTERNAL"));
check("states current unversioned /api/* is private", doc.includes("/api/*") && doc.includes("private"));
check("defines /api/v1 path prefix on first public promise", doc.includes("/api/v1/*"));
check("breaking changes require a new prefix", doc.includes("/api/v2/*"));
check("defines a deprecation overlap window", doc.includes("90-day overlap"));
check("path prefixes only (no negotiation headers)", doc.includes("NOT used"));
check("does not renumber existing routes (no route changes required)", !doc.includes("rename existing"));
check("references the OpenAPI surface as the public trigger", doc.includes("docs/openapi.yaml"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
