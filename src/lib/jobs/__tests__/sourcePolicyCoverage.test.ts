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
  "src/app/api/jobs/recommended/route.ts": 2,
  "src/app/api/jobs/suggest/route.ts": 1,
  "src/app/api/stats/route.ts": 2,
  "src/app/api/radar/route.ts": 2,
  "src/app/api/ticker/route.ts": 1,
  "src/components/JobRadarGlobe.tsx": 1,
  "src/lib/cron/dailyDigestCron.ts": 1,
  "netlify/functions/jobs-pro.ts": 3,
  "netlify/functions/jobs-search.ts": 2,
  "netlify/functions/jobs-top10.ts": 3,
  "netlify/functions/stats.ts": 2,
  "netlify/functions/ticker.ts": 1,
};
const READ = /\.from\(\s*(?:["'`]jobs(?:_public)?["'`]|targetTable)\s*\)/g;

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
