/**
 * Offline check for docs/twelve-factor.md (Backend sheet row "Twelve-Factor App"). It reads the doc and the repo
 * only. It checks the doc is complete and honest in shape; it does not prove runtime behavior.
 * Run: npx tsx scripts/test-twelve-factor-evidence.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/twelve-factor.md", "utf8");
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const RATINGS = ["Met", "Partial", "Not applicable", "Unproven"];

const headings = doc.split("\n").filter((l) => /^## [IVX]+\. /.test(l));
check("exactly twelve factor sections", headings.length === 12);
check("sections are numbered I to XII in order", ROMAN.every((r, i) => headings[i] !== undefined && headings[i].indexOf("## " + r + ". ") === 0));
check("every section carries one of the four ratings",
  headings.every((h) => RATINGS.some((r) => h.slice(-(r.length + 2)) === ": " + r)));
check("logs (XI) and admin processes (XII) stay Partial, matching the sheet row",
  /^## XI\. Logs: Partial$/m.test(doc) && /^## XII\. Admin processes: Partial$/m.test(doc));
check("doc has the unproven and owner-steps sections", /^## What stays unproven$/m.test(doc) && /^## Owner steps/m.test(doc));

const cited = doc.match(/`[A-Za-z0-9_./@-]+\/[A-Za-z0-9_.-]+\.(?:ts|tsx|md|cjs|mjs|json|yml|yaml)`|`\.(?:env\.example|node-version)`|`package(?:-lock)?\.json`/g) || [];
const uniq: string[] = [];
cited.forEach((c) => { const p = c.replace(/`/g, ""); if (uniq.indexOf(p) < 0) uniq.push(p); });
check("doc cites at least 20 repo files", uniq.length >= 20);
const missing = uniq.filter((p) => !fs.existsSync(p));
if (missing.length > 0) console.log("missing: " + missing.join(", "));
check("every file the doc cites exists", missing.length === 0);
check("netlify/functions directory named in factor I exists", fs.existsSync("netlify/functions"));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
