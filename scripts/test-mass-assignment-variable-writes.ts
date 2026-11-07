/**
 * Backend sheet row "Mass Assignment" (PARTIAL: "regex guard misses direct
 * .update(body), variable/array arguments"). The existing guard
 * (src/lib/__tests__/massAssignment.test.ts) only inspects object-literal
 * arguments inside API routes. This scan covers the rest of src/: every
 * .insert/.update/.upsert whose first argument is a variable, not a literal.
 *
 * Those call sites are reviewed once (baseline below, read on 8 Nov 2026; owner to
 * confirm) and any NEW one fails this test, so a request body cannot be passed
 * straight into a DB write without someone adding it here on purpose. Stale
 * baseline entries fail too. Static text scan only: it is not data-flow analysis and
 * cannot prove a variable is server-built; the baseline notes record why each is.
 * Run: npx tsx scripts/test-mass-assignment-variable-writes.ts
 */
import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}`); }
}

// key = file :: call(firstArgument) ; value = review note
const BASELINE: Record<string, string> = {
  "src/lib/alerts/searchAlertDispatcher.ts :: upsert(rows)": "rows built from alert id and job ids inside claimJobsInDb",
  "src/lib/admin/analytics.ts :: insert(record)": "record assembled server-side from sanitized page-view fields",
  "src/lib/db/optimisticLock.ts :: update(patch)": "helper: caller supplies the patch; helper refuses a patch that sets row_version",
  "src/lib/early-access/gmail.ts :: insert(row)": "send-log row built from server values",
  "src/lib/cron/dailyDigestCron.ts :: upsert(pendingDigestRows)": "cron-built digest rows",
  "src/lib/cron/dailyDigestCron.ts :: upsert(row)": "cron-built digest row (per-row retry)",
  "src/lib/billing/razorpay.ts :: update(rawBody)": "NOT a DB write: crypto HMAC update",
  "src/lib/resume/storage.ts :: upsert(payload)": "payload built from the validated candidate profile (two sites: first try and retry)",
};
const EXPECTED_COUNTS: Record<string, number> = { "src/lib/resume/storage.ts :: upsert(payload)": 2 };

function walk(dir: string, out: string[]) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "node_modules") return;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(full);
  });
}

const files: string[] = [];
walk("src", files);
const found: Record<string, number> = {};
const CALL = /\.(insert|update|upsert)\(\s*([A-Za-z_$][\w$]*)/g;
files.forEach((f) => {
  const src = fs.readFileSync(f, "utf8");
  CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CALL.exec(src)) !== null) {
    const key = f.split(path.sep).join("/") + " :: " + m[1] + "(" + m[2] + ")";
    found[key] = (found[key] || 0) + 1;
  }
});

const foundKeys = Object.keys(found);
const unreviewed = foundKeys.filter((k) => !(k in BASELINE));
check("scanned src/ (sanity: files found)", files.length > 50);
check("no new variable-argument DB write outside the reviewed baseline" + (unreviewed.length ? " -> " + unreviewed.join("; ") : ""), unreviewed.length === 0);
const stale = Object.keys(BASELINE).filter((k) => !(k in found));
check("no stale baseline entries" + (stale.length ? " -> " + stale.join("; ") : ""), stale.length === 0);
const wrongCount = Object.keys(found).filter((k) => (EXPECTED_COUNTS[k] || 1) !== found[k]);
check("call-site counts match the baseline" + (wrongCount.length ? " -> " + wrongCount.join("; ") : ""), wrongCount.length === 0);
check("no API route passes a variable straight into a DB write", foundKeys.filter((k) => k.indexOf("src/app/api/") === 0).length === 0);
check("every baseline entry carries a review note", Object.keys(BASELINE).every((k) => BASELINE[k].length > 10));
check("scanner flags a direct request-body write (self-test)", /\.update\(\s*([A-Za-z_$][\w$]*)/.exec("supabase.from('t').update(body)")![1] === "body");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
