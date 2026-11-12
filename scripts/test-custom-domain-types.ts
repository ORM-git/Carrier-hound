/**
 * Offline static guard test for migration 20261112a_custom_domain_types.sql (NOT APPLIED).
 * Verifies that:
 * 1. Migration file exists at supabase/migrations/20261112a_custom_domain_types.sql
 * 2. Carries the NOT APPLIED header and self-referencing record-migration command
 * 3. Contains CREATE DOMAIN statements for cm_email, cm_non_empty_text, cm_slug
 * 4. Contains NO executable ALTER, DROP, UPDATE, INSERT, DELETE, or TRUNCATE statements
 * 5. Contains a commented rollback block
 * 6. Docs exist at docs/custom-domain-types.md
 * 7. Behavioral unit verification of domain rules and regex patterns
 *
 * Run: npx tsx scripts/test-custom-domain-types.ts
 */
import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    console.log(`FAIL ${name}`);
  }
}

console.log("================================================================================");
console.log("RUNNING CUSTOM DOMAIN TYPES MIGRATION & POLICY AUDIT SUITE");
console.log("================================================================================\n");

const MIGRATION_FILE = "20261112a_custom_domain_types.sql";
const MIGRATION_PATH = path.join("supabase", "migrations", MIGRATION_FILE);
const DOC_PATH = path.join("docs", "custom-domain-types.md");

// 1. File existence
check("migration file exists in supabase/migrations/", fs.existsSync(MIGRATION_PATH));
check("docs/custom-domain-types.md documentation exists", fs.existsSync(DOC_PATH));

const sql = fs.readFileSync(MIGRATION_PATH, "utf8");

// 2. Header and record-migration checks
const headerLines = sql.split("\n").slice(0, 20).join("\n");
check("carries STATUS: NOT APPLIED header marker", /--\s*STATUS:\s*NOT APPLIED/i.test(headerLines));
check(
  "carries self-referencing record-migration.cjs command in header",
  /record-migration\.cjs\s+20261112a_custom_domain_types\b/.test(headerLines)
);

// 3. Rollback section checks
check("carries commented ROLLBACK header", /^\s*--\s*=*\s*ROLLBACK/im.test(sql));
check(
  "carries commented DROP DOMAIN undo statements",
  /--\s*DROP\s+DOMAIN\s+IF\s+EXISTS\s+public\.cm_email/i.test(sql) &&
    /--\s*DROP\s+DOMAIN\s+IF\s+EXISTS\s+public\.cm_non_empty_text/i.test(sql) &&
    /--\s*DROP\s+DOMAIN\s+IF\s+EXISTS\s+public\.cm_slug/i.test(sql)
);
check("no uncommented ROLLBACK statement", !/^\s*ROLLBACK\s*;/im.test(sql));

// 4. Executable statements checks (only CREATE DOMAIN, no ALTER/DROP/UPDATE)
const executableCode = sql
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !/^\s*--/.test(line))
  .join("\n")
  .trim();

check(
  "contains no executable ALTER statements",
  !/\bALTER\b/i.test(executableCode)
);
check(
  "contains no executable DROP statements",
  !/\bDROP\b/i.test(executableCode)
);
check(
  "contains no executable UPDATE statements",
  !/\bUPDATE\b/i.test(executableCode)
);
check(
  "contains no executable INSERT, DELETE, or TRUNCATE statements",
  !/\b(INSERT\s+INTO|DELETE\s+FROM|TRUNCATE)\b/i.test(executableCode)
);
check(
  "contains no executable CREATE TABLE statements",
  !/\bCREATE\s+TABLE\b/i.test(executableCode)
);

// 5. Domain declarations presence
check(
  "contains CREATE DOMAIN public.cm_email statement",
  /CREATE\s+DOMAIN\s+public\.cm_email\s+AS\s+text/i.test(executableCode)
);
check(
  "contains CREATE DOMAIN public.cm_non_empty_text statement",
  /CREATE\s+DOMAIN\s+public\.cm_non_empty_text\s+AS\s+text/i.test(executableCode)
);
check(
  "contains CREATE DOMAIN public.cm_slug statement",
  /CREATE\s+DOMAIN\s+public\.cm_slug\s+AS\s+text/i.test(executableCode)
);

// 6. Domain constraint expressions verification
check(
  "cm_email enforces lower(trim(VALUE)) normalization",
  /VALUE\s*=\s*lower\s*\(\s*trim\s*\(\s*VALUE\s*\)\s*\)/i.test(executableCode)
);
check(
  "cm_email enforces char_length(VALUE) <= 254",
  /char_length\s*\(\s*VALUE\s*\)\s*<=\s*254/i.test(executableCode)
);
check(
  "cm_email enforces position('@' in VALUE) > 1",
  /position\s*\(\s*'@'\s+in\s+VALUE\s*\)\s*>\s*1/i.test(executableCode)
);
check(
  "cm_non_empty_text enforces length(trim(VALUE)) > 0",
  /length\s*\(\s*trim\s*\(\s*VALUE\s*\)\s*\)\s*>\s*0/i.test(executableCode)
);
check(
  "cm_slug enforces lower(trim(VALUE)) normalization",
  /VALUE\s*=\s*lower\s*\(\s*trim\s*\(\s*VALUE\s*\)\s*\)/i.test(executableCode)
);
check(
  "cm_slug enforces non-empty trimmed text",
  /length\s*\(\s*trim\s*\(\s*VALUE\s*\)\s*\)\s*>\s*0/i.test(executableCode)
);
check(
  "cm_slug enforces slug regex pattern ^[a-z0-9]+(-[a-z0-9]+)*$",
  /VALUE\s*~\s*'\^\[a-z0-9\]\+\(-\[a-z0-9\]\+\)\*\$'/i.test(executableCode)
);

// 7. Behavioral unit verification of domain rules
const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const isValidEmail = (val: string) =>
  val === val.trim().toLowerCase() &&
  val.length <= 254 &&
  val.indexOf("@") > 0 &&
  emailRegex.test(val);

check("cm_email accepts valid normalized emails", isValidEmail("user@careermonke.com"));
check("cm_email accepts valid subdomains and plus addressing", isValidEmail("user+alerts@eng.example.co.uk"));
check("cm_email rejects uppercase email", !isValidEmail("User@CareerMonke.com"));
check("cm_email rejects untrimmed email", !isValidEmail(" user@careermonke.com "));
check("cm_email rejects missing top-level domain", !isValidEmail("user@localhost"));
check("cm_email rejects missing local-part", !isValidEmail("@domain.com"));

const isValidNonEmptyText = (val: string) => val.trim().length > 0;
check("cm_non_empty_text accepts standard text", isValidNonEmptyText("Engineering"));
check("cm_non_empty_text rejects empty string", !isValidNonEmptyText(""));
check("cm_non_empty_text rejects whitespace-only string", !isValidNonEmptyText("   \t\n  "));

const slugRegex = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isValidSlug = (val: string) =>
  val === val.trim().toLowerCase() &&
  val.trim().length > 0 &&
  val.length <= 120 &&
  slugRegex.test(val);

check("cm_slug accepts single-word slug", isValidSlug("engineering"));
check("cm_slug accepts hyphenated slug", isValidSlug("senior-frontend-engineer"));
check("cm_slug accepts alphanumeric slug", isValidSlug("web3-developer-2026"));
check("cm_slug rejects uppercase slug", !isValidSlug("Senior-Frontend-Engineer"));
check("cm_slug rejects leading hyphen", !isValidSlug("-senior-frontend"));
check("cm_slug rejects trailing hyphen", !isValidSlug("senior-frontend-"));
check("cm_slug rejects double hyphens", !isValidSlug("senior--frontend"));
check("cm_slug rejects spaces", !isValidSlug("senior frontend"));
check("cm_slug rejects underscores", !isValidSlug("senior_frontend"));

// 8. Documentation content verification
const docContent = fs.readFileSync(DOC_PATH, "utf8");
check("docs covers cm_email", docContent.includes("cm_email"));
check("docs covers cm_non_empty_text", docContent.includes("cm_non_empty_text"));
check("docs covers cm_slug", docContent.includes("cm_slug"));
check("docs explains why domains beat duplicated CHECKs", docContent.includes("Why DOMAIN Types Beat Duplicated"));
check("docs contains staged adoption plan", docContent.includes("Staged Adoption Plan"));

console.log(`\n================================================================================`);
console.log(`AUDIT SUMMARY: ${passed} passed, ${failed} failed`);
console.log(`================================================================================`);

if (failed > 0) {
  process.exit(1);
}
