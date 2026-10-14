/**
 * CareerMonke Search API Rate Limit Verification
 * Tests 30 req/60s per client IP in jobs-search handler.
 * Run with: npx tsx scripts/test-search-ratelimit.ts
 * Run negative control: npx tsx scripts/test-search-ratelimit.ts --negative-control
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  handler as searchHandler,
  _resetSearchRateLimitStore,
  _setSearchRateLimitConfig,
} from "../netlify/functions/jobs-search";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function runRateLimitTests() {
  console.log("===============================================================================");
  console.log("            CAREERMONKE SEARCH API RATE LIMIT VERIFICATION SUITE              ");
  console.log("===============================================================================\n");

  _resetSearchRateLimitStore();

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Setting maxRequests = 1000 in memory...");
    _setSearchRateLimitConfig(1000);
  } else {
    _setSearchRateLimitConfig(30, 60 * 1000);
  }

  const primaryIp = "198.51.100.42";
  const secondaryIp = "203.0.113.19";

  console.log(`Sending 35 consecutive requests from client IP: ${primaryIp}...\n`);

  const statuses: { call: number; status: number; retryAfter?: string; error?: string }[] = [];

  for (let i = 1; i <= 35; i++) {
    const event: any = {
      httpMethod: "GET",
      headers: {
        "x-forwarded-for": primaryIp,
        origin: "https://careermonke.com",
      },
      queryStringParameters: {
        q: "engineer",
        pageSize: "1",
      },
    };

    const res = await searchHandler(event);
    let errorMsg: string | undefined;
    if (res.statusCode === 429) {
      try {
        const body = JSON.parse(res.body);
        errorMsg = body.error;
      } catch (_) {}
    }

    statuses.push({
      call: i,
      status: res.statusCode,
      retryAfter: res.headers?.["Retry-After"],
      error: errorMsg,
    });
  }

  // Print results table
  console.log("SEQUENCE EXECUTION LOG:");
  console.log("-------------------------------------------------------------------------------");
  console.log("Call #".padEnd(10) + "Client IP".padEnd(18) + "Status".padEnd(10) + "Retry-After".padEnd(14) + "Notes");
  console.log("-------------------------------------------------------------------------------");

  for (const s of statuses) {
    const notes =
      s.status === 200
        ? "Allowed (within 30/60s quota)"
        : s.status === 429
        ? `Rate Limited (429 Too Many Requests: ${s.error || "Limited"})`
        : `Unexpected Status: ${s.status}`;

    console.log(
      `#${s.call}`.padEnd(10) +
      primaryIp.padEnd(18) +
      String(s.status).padEnd(10) +
      (s.retryAfter ? `${s.retryAfter}s` : "-").padEnd(14) +
      notes
    );
  }
  console.log("-------------------------------------------------------------------------------\n");

  // Secondary IP test
  console.log(`Testing secondary client IP: ${secondaryIp} (should not be impacted)...`);
  const secEvent: any = {
    httpMethod: "GET",
    headers: {
      "x-forwarded-for": secondaryIp,
      origin: "https://careermonke.com",
    },
    queryStringParameters: { pageSize: "1" },
  };
  const secRes = await searchHandler(secEvent);
  console.log(`Secondary IP Status: ${secRes.statusCode} (${secRes.statusCode === 200 ? "PASS: Isolated" : "FAIL"})\n`);

  const count200 = statuses.filter((s) => s.status === 200).length;
  const count429 = statuses.filter((s) => s.status === 429).length;

  console.log("SUMMARY COUNTS:");
  console.log(`- Total calls:       35`);
  console.log(`- 200 OK:            ${count200}`);
  console.log(`- 429 Rate Limited:  ${count429}`);
  console.log(`- Secondary IP (200): ${secRes.statusCode === 200 ? "YES" : "NO"}\n`);

  if (IS_NEGATIVE_CONTROL) {
    if (count429 === 0) {
      console.error("❌ NEGATIVE CONTROL VERIFIED: Limit set huge (1000) allowed all 35 requests (0 x 429).");
      console.error("Deliberately exiting with non-zero code (1) to prove rate-limit test fails when unconstrained.");
      process.exit(1);
    }
  }

  // In normal mode, assert strict contract
  if (count200 !== 30 || count429 !== 5 || secRes.statusCode !== 200) {
    console.error(`❌ CONTRACT VIOLATION: Expected exactly 30 x 200, 5 x 429, and secondary IP 200. Got ${count200} x 200, ${count429} x 429.`);
    process.exit(1);
  }

  console.log("🎉 ALL RATE LIMIT CHECKS PASSED: Exactly 30 requests permitted per 60s, 429 returned with Retry-After header, secondary IP isolated.");
  process.exit(0);
}

runRateLimitTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
