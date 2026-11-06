/**
 * Static checks for BE#4: internal sub-processor inventory.
 * The document must stay internal, list every sub-processor the codebase
 * calls, and keep the never-name-job-sources rule. Run:
 *   npx tsx scripts/test-subprocessor-inventory.ts
 */
import * as fs from "fs";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

const doc = fs.readFileSync("docs/subprocessors.md", "utf8");

check("marked INTERNAL / not customer-facing", /INTERNAL/.test(doc) && /[Nn]ot customer-facing/.test(doc));
for (const p of ["Supabase", "Netlify", "Sentry", "Groq", "Gmail", "Razorpay"]) {
  check(`lists ${p}`, doc.includes(p));
}
check("each row cites code evidence", (doc.match(/`src\//g) || []).length >= 6);
check("marks Razorpay payments as disabled", /DISABLED/.test(doc));
check("keeps job-board sources out of customer copy", doc.includes("Never name these in customer-facing copy"));
check("does not invent vendor-side details (uses confirm-with-vendor marker)", doc.includes("provider-side - confirm with vendor docs"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
