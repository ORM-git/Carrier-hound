/**
 * Offline test for conditional GET on /api/stats (Backend sheet row 97: ETag / Conditional Requests).
 *
 * Verifies weak ETag computation, If-None-Match handling, 304 response structure,
 * cache header preservation, and route source wiring.
 *
 * Run: npx tsx scripts/test-stats-etag.ts
 * Run negative control: npx tsx scripts/test-stats-etag.ts --negative-control (exits 1)
 */

import fs from "node:fs";
import path from "node:path";
import { computeWeakEtag, notModifiedResponse } from "../src/lib/api/etag";

const isNegativeControl = process.argv.includes("--negative-control");

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

const req = (headers?: Record<string, string>) =>
  new Request("https://careermonke.com/api/stats", { headers });

const samplePublicStats = {
  jobsToday: 42,
  updatedAt: "2026-11-11T12:00:00.000Z",
};

const samplePublicHeaders = {
  "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
  Vary: "Authorization",
};

async function main() {
  // 1. Weak ETag computation
  const etag = await computeWeakEtag(samplePublicStats);
  check("ETag format is weak quote string (W/\"...\")", /^W\/"[0-9a-f]{32}"$/.test(etag));

  // 2. Determinism of ETag
  const etag2 = await computeWeakEtag(samplePublicStats);
  check("computeWeakEtag is deterministic across identical payloads", etag === etag2);

  // 3. ETag reacts to payload changes
  const changedPayload = { ...samplePublicStats, jobsToday: 43 };
  const etagChanged = await computeWeakEtag(changedPayload);
  check("computeWeakEtag changes when payload values change", etag !== etagChanged);

  // 4. Conditional GET with matching If-None-Match gives 304
  const reqMatching = req({ "if-none-match": etag });
  const notModified = notModifiedResponse(reqMatching, etag, samplePublicHeaders);
  check("notModifiedResponse returns Response on matching If-None-Match", Boolean(notModified));
  if (notModified) {
    check("status is 304 Not Modified", notModified.status === 304);
    check("body is empty", (await notModified.text()) === "");
    check("Cache-Control header preserved on 304", notModified.headers.get("cache-control") === samplePublicHeaders["Cache-Control"]);
    check("Vary header preserved on 304", notModified.headers.get("vary") === samplePublicHeaders.Vary);
    check("ETag header preserved on 304", notModified.headers.get("etag") === etag);
  }

  // 5. Conditional GET with non-matching If-None-Match returns null (fall through to 200)
  const reqNonMatching = req({ "if-none-match": 'W/"deadbeef000000000000000000000000"' });
  const fallThrough = notModifiedResponse(reqNonMatching, etag, samplePublicHeaders);
  check("non-matching If-None-Match returns null to serve full 200 body", fallThrough === null);

  // 6. Plain GET without If-None-Match returns null
  const reqPlain = req();
  const plainRes = notModifiedResponse(reqPlain, etag, samplePublicHeaders);
  check("unconditional GET returns null to serve full 200 body", plainRes === null);

  // 7. Route source code verification: ensure /api/stats imports and uses etag helpers
  const routeSource = fs.readFileSync(
    path.join(__dirname, "../src/app/api/stats/route.ts"),
    "utf8"
  );
  check("route imports computeWeakEtag and notModifiedResponse from etag lib",
    routeSource.includes('import { computeWeakEtag, notModifiedResponse } from "@/lib/api/etag";')
  );
  check("route computes weak ETag on publicStats",
    routeSource.includes("const etag = await computeWeakEtag(publicStats);")
  );
  check("route evaluates notModifiedResponse and returns early",
    routeSource.includes("const notModified = notModifiedResponse(req, etag, publicHeaders);") &&
    routeSource.includes("if (notModified) return notModified;")
  );
  check("route attaches ETag header on 200 response",
    routeSource.includes("headers: { ...publicHeaders, ETag: etag }")
  );

  // 8. Negative control
  if (isNegativeControl) {
    console.log("NEGATIVE CONTROL: injecting deliberate assertion failure");
    check("negative control forced failure", false);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
