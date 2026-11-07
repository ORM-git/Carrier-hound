import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

// Guard for Database sheet rank 73 (SELECT * discipline): every
// .select("*") call site in server code must be reviewed and recorded in
// docs/select-star-discipline.md. A new unreviewed full-row read fails CI.
// See the doc for the per-site classification.

const ROOT = join(__dirname, "..", "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  const entries = readdirSync(dir);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

// Allowlist: exact "relative/path.ts:line" keys, mirrored in the doc.
const ALLOWLIST = new Set([
  "src/lib/account/exportHandler.ts:161",
  "src/lib/account/exportHandler.ts:175",
  "src/lib/account/deleteHandler.ts:279",
  "src/lib/billing/quota.ts:303",
  "src/lib/billing/quota.ts:321",
  "src/lib/billing/subscription.ts:59",
  "src/lib/billing/subscription.ts:315",
  "src/lib/billing/serverEntitlement.ts:49",
  "src/app/api/billing/razorpay/verify/route.ts:171",
  "src/app/api/billing/razorpay/verify/route.ts:325",
  "src/app/api/billing/razorpay/verify/route.ts:341",
  "src/app/api/billing/razorpay/verify/route.ts:486",
  "src/lib/resume/storage.ts:151",
  "src/lib/tracker/storage.ts:129",
  "src/lib/auth/session.ts:138",
  "src/lib/cron/dailyDigestCron.ts:118",
  "src/lib/cron/digestStorage.ts:58",
  "src/lib/events/failedEvents.ts:622",
]);

const STAR_RE = /\.select\(\s*(["'`])\*\1\s*\)/g;

function findSites(file: string): string[] {
  const rel = relative(ROOT, file).split("\\").join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  const hits: string[] = [];
  lines.forEach((line, i) => {
    STAR_RE.lastIndex = 0;
    if (STAR_RE.test(line)) hits.push(`${rel}:${i + 1}`);
  });
  return hits;
}

describe("SELECT * discipline guard (DB sheet rank 73)", () => {
  it("every .select(\"*\") site is allowlisted and documented", () => {
    const found: string[] = [];
    walk(join(ROOT, "src")).forEach((file) => found.push(...findSites(file)));
    const undocumented = found.filter((s) => !ALLOWLIST.has(s));
    expect(
      undocumented,
      `new unreviewed .select("*") site(s): ${undocumented.join(", ")} - ` +
        `name the columns instead, or record the justification in docs/select-star-discipline.md and this allowlist`,
    ).toEqual([]);
    expect(found.length).toBe(ALLOWLIST.size);
  });

  it("the doc records every allowlisted site", () => {
    const doc = readFileSync(join(ROOT, "docs", "select-star-discipline.md"), "utf8");
    ALLOWLIST.forEach((site) => {
      const [file, line] = site.split(":");
      expect(doc.includes(`${file}:${line}`), `${site} missing from docs/select-star-discipline.md`).toBe(true);
    });
  });
});
