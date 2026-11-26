// Static guard: every user-facing read of jobs / jobs_public applies VISIBLE_SOURCE_FILTER right after select().
// Covers sites the behaviour tests do not drive (top10, radar, ticker, suggest, globe, digest, client list/facets)
// and the Netlify copies of the API routes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../../..");
// file -> expected number of filtered job reads
const SITES: Record<string, number> = {
  "src/lib/api/jobs.ts": 2,
  "src/lib/jobs/service.ts": 6,
  "src/app/api/jobs/search/route.ts": 2,
  "src/app/api/jobs/pro/route.ts": 4,
  "src/app/api/jobs/top10/route.ts": 3,
  "src/app/api/jobs/recommended/route.ts": 1, // Pro hydrate; the candidate read moved into recommendedRequest.ts (#798)
  "src/lib/jobs/recommendedRequest.ts": 1, // baseCandidateQuery: shared by the recommended and snapshot routes
  "src/app/api/jobs/suggest/route.ts": 1,
  "src/app/api/stats/route.ts": 1,
  "src/app/api/radar/route.ts": 2,
  "src/app/api/ticker/route.ts": 1,
  "src/components/JobRadarGlobe.tsx": 1,
  "src/lib/cron/dailyDigestCron.ts": 1,
  "netlify/functions/jobs-pro.ts": 3,
  "netlify/functions/jobs-search.ts": 2,
  "netlify/functions/jobs-top10.ts": 3,
  "netlify/functions/stats.ts": 1,
  "netlify/functions/ticker.ts": 1,
};
const READ = /\.from\(\s*(?:["'`]jobs(?:_public)?["'`]|(?:r\.)?targetTable)\s*\)/g;

describe("every app read of jobs applies the source policy", () => {
  for (const [file, expected] of Object.entries(SITES)) {
    it(file, () => {
      const src = readFileSync(path.join(ROOT, file), "utf8");
      const reads = Array.from(src.matchAll(READ));
      expect(reads.length).toBe(expected);
      for (const m of reads) {
        // The filter must follow this read's select(...) before the statement ends.
        const tail = src.slice(m.index!, m.index! + 1200);
        const stmt = tail.slice(0, tail.search(/;\s*\n/) + 1 || tail.length);
        expect(stmt, `${file}: ${stmt.slice(0, 80)}`).toContain(".or(VISIBLE_SOURCE_FILTER)");
      }
    });
  }
});

// The snapshot serve-time salary recheck reads live jobs through an RPC (jobs_salary_rows). That RPC does not apply
// the source policy itself, so its only call site must feed it to baseCandidateQuery, which does.
describe("snapshot salary RPC read applies the source policy", () => {
  it("jobs_salary_rows is called once and only reaches the route through baseCandidateQuery", () => {
    const lib = readFileSync(path.join(ROOT, "src/lib/jobs/feedSnapshot.ts"), "utf8");
    expect(lib.match(/\.rpc\(\s*["'`]jobs_salary_rows["'`]/g) ?? []).toHaveLength(1);
    const route = readFileSync(path.join(ROOT, "src/app/api/jobs/recommended/snapshot/route.ts"), "utf8");
    expect(route.match(/liveSalaryRows\(/g) ?? []).toHaveLength(1);
    expect(route).toMatch(/const source = held \? liveSalaryRows\([^;]*;\s*\n\s*const q = applyRecommendedFilters\(baseCandidateQuery\(r, cols, source\)/);
  });
});

// The retained-today count is deliberately raw (no source/active/status filter). Pin that exemption to the one
// helper module and require both stats entry points to use it rather than an inline unfiltered read.
describe("retained-today raw count exemption", () => {
  const helper = readFileSync(path.join(ROOT, "src/lib/api/retainedJobsToday.ts"), "utf8");
  it("helper has exactly one raw jobs read with no source/active/status filter", () => {
    const reads = Array.from(helper.matchAll(READ));
    expect(reads.length).toBe(1);
    expect(helper).not.toMatch(/VISIBLE_SOURCE_FILTER|\.or\(|\.eq\(\s*["'`](?:is_active|status)/);
    expect(helper).toMatch(/\.from\("jobs"\)/);
  });
  for (const f of ["src/app/api/stats/route.ts", "netlify/functions/stats.ts"]) {
    it(`${f} uses the helper`, () => {
      expect(readFileSync(path.join(ROOT, f), "utf8")).toContain("countRetainedJobsToday(");
    });
  }
});
