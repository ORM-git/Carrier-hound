/**
 * Read-only guard for docs/admin-mfa.md (Backend sheet row "MFA / 2FA"). It reads source files only,
 * changes nothing and enforces nothing. It checks that the doc matches the code today:
 * every admin route goes through verifyAdminSession, the admin check keeps its three conditions,
 * and no admin code reads an MFA assurance level (so the doc's "no enforcement" claim is true).
 * If enforcement is added later, update the doc and this test in the same PR.
 * Run: npx tsx scripts/test-admin-mfa-posture.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}
function walk(dir: string, out: string[]) {
  fs.readdirSync(dir).forEach((n) => {
    const p = dir + "/" + n;
    if (fs.statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  });
}

const doc = fs.readFileSync("docs/admin-mfa.md", "utf8");
const cited = doc.match(/`(?:src|scripts|docs)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|md)`/g) || [];
check("doc cites repo files", cited.length >= 5);
check("every file the doc cites exists", cited.every((c) => fs.existsSync(c.replace(/`/g, ""))));
check("doc states that nothing is enforced and the row stays MISSING", /No MFA is enforced/.test(doc) && /stays MISSING/.test(doc));
check("doc keeps the owner steps and unproven sections", /## Owner steps/.test(doc) && /## What stays unproven/.test(doc));

const routes: string[] = [];
walk("src/app/api/admin", routes);
const routeFiles = routes.filter((f) => /route\.ts$/.test(f));
check("there are admin routes to check", routeFiles.length >= 8);
check("every admin route file calls verifyAdminSession", routeFiles.every((f) => fs.readFileSync(f, "utf8").indexOf("verifyAdminSession") >= 0));

const constants = fs.readFileSync("src/lib/admin/constants.ts", "utf8");
const fnStart = constants.indexOf("export function isVerifiedAdminUser");
const fnBody = fnStart >= 0 ? constants.slice(fnStart) : "";
check("isVerifiedAdminUser still needs admin-list email, confirmed email and a Google identity",
  fnBody.indexOf("isEmailInAdminList") > 0 && fnBody.indexOf("isUserEmailVerified") > 0 && fnBody.indexOf("hasAdminGoogleProvider") > 0);

const adminAuth = fs.readFileSync("src/lib/admin/auth.ts", "utf8");
check("verifyAdminSession still applies the progressive lockout", adminAuth.indexOf("isLockedOut") >= 0 && adminAuth.indexOf("recordFailureAndMaybeLock") >= 0);

const scan: string[] = [];
["src/lib/admin", "src/app/api/admin", "src/app/admin"].forEach((d) => walk(d, scan));
scan.push("src/middleware.ts");
const mfaHits = scan.filter((f) => /\b(aal1|aal2|mfa|totp)\b/i.test(fs.readFileSync(f, "utf8")));
check("no admin code reads an MFA assurance level or factor (doc says nothing is enforced)", mfaHits.length === 0);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
