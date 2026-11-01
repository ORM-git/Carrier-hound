/**
 * CareerMonke CORS Verification Suite
 * Tests all 7 Netlify serverless functions and _cors.ts against origin allow-list.
 * Run with: npx tsx scripts/test-cors.ts
 * Run negative control: npx tsx scripts/test-cors.ts --negative-control
 */

import { buildCorsHeaders, handleCorsPreflight } from "../netlify/functions/_cors";
import { handler as accountDeleteHandler } from "../netlify/functions/account-delete";
import { handler as aiHandler } from "../netlify/functions/ai";
import { handler as jobsProHandler } from "../netlify/functions/jobs-pro";
import { handler as jobsSearchHandler } from "../netlify/functions/jobs-search";
import { handler as jobsTop10Handler } from "../netlify/functions/jobs-top10";
import { handler as simulateCheckoutHandler } from "../netlify/functions/simulate-checkout";
import { handler as statsHandler } from "../netlify/functions/stats";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

interface TestCase {
  origin: string | undefined;
  desc: string;
  expectedAllowed: boolean;
}

const TEST_CASES: TestCase[] = [
  { origin: "https://careermonke.com", desc: "Production Canonical", expectedAllowed: true },
  { origin: "https://www.careermonke.com", desc: "Production Canonical WWW", expectedAllowed: true },
  { origin: "https://careermonke.netlify.app", desc: "Netlify Production 1", expectedAllowed: true },
  { origin: "https://careermonke12.netlify.app", desc: "Netlify Production 2", expectedAllowed: true },
  { origin: "https://carrier-hound.pages.dev", desc: "Canonical Cloudflare Pages", expectedAllowed: true },
  { origin: "https://careerhound.netlify.app", desc: "Canonical Careerhound Netlify", expectedAllowed: true },
  { origin: "http://localhost:3000", desc: "Local Dev (allowed in dev)", expectedAllowed: true },
  { origin: "https://anything.carrier-hound.pages.dev", desc: "Stale Cloudflare Preview (Blocked)", expectedAllowed: false },
  { origin: "https://stale-deploy.carrier-hound.pages.dev", desc: "Stale Preview Subdomain (Blocked)", expectedAllowed: false },
  { origin: "https://evil.example", desc: "Untrusted Origin", expectedAllowed: false },
  { origin: undefined, desc: "No Origin (server/direct)", expectedAllowed: false },
];

const HANDLERS = [
  { name: "account-delete", fn: accountDeleteHandler },
  { name: "ai", fn: aiHandler },
  { name: "jobs-pro", fn: jobsProHandler },
  { name: "jobs-search", fn: jobsSearchHandler },
  { name: "jobs-top10", fn: jobsTop10Handler },
  { name: "simulate-checkout", fn: simulateCheckoutHandler },
  { name: "stats", fn: statsHandler },
];

interface TestRowResult {
  handler: string;
  origin: string;
  status: number;
  allowOriginHeader: string;
  varyHeader: string;
  result: "PASS" | "FAIL";
  notes: string;
}

async function runCorsTests() {
  console.log("===============================================================================");
  console.log("                CAREERMONKE CORS ALLOW-LIST VERIFICATION SUITE                 ");
  console.log("===============================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Simulating an in-memory bypass / wildcard leak...\n");
  }

  const tableResults: TestRowResult[] = [];
  let violations = 0;

  for (const h of HANDLERS) {
    for (const tc of TEST_CASES) {
      const event: any = {
        httpMethod: "OPTIONS",
        headers: tc.origin ? { origin: tc.origin } : {},
      };

      let res: any;
      try {
        res = await h.fn(event);
      } catch (err: any) {
        res = { statusCode: 500, headers: {}, body: err.message };
      }

      let allowOrigin = res.headers?.["Access-Control-Allow-Origin"] || "(omitted)";
      const vary = res.headers?.["Vary"] || "(omitted)";

      // In negative control mode, deliberately inject an in-memory wildcard to prove failure
      if (IS_NEGATIVE_CONTROL && h.name === "account-delete" && tc.origin === "https://evil.example") {
        allowOrigin = "*";
      }

      let passed = true;
      let notes = "";

      // Rule 1: Never return wildcard '*'
      if (allowOrigin === "*") {
        passed = false;
        notes = "VIOLATION: Wildcard '*' returned!";
        violations++;
      }
      // Rule 2: Never echo unallowed origin
      else if (!tc.expectedAllowed && allowOrigin !== "(omitted)") {
        passed = false;
        notes = `VIOLATION: Untrusted origin echoed: ${allowOrigin}`;
        violations++;
      }
      // Rule 3: Allowed origins must receive matching header
      else if (tc.expectedAllowed && allowOrigin !== tc.origin) {
        passed = false;
        notes = `VIOLATION: Expected ${tc.origin}, got ${allowOrigin}`;
        violations++;
      }
      // Rule 4: Vary: Origin must always be present
      else if (!vary.includes("Origin")) {
        passed = false;
        notes = "VIOLATION: Missing 'Vary: Origin' header!";
        violations++;
      } else {
        notes = tc.expectedAllowed ? "Allowed (Strict Match)" : "Blocked (Header Omitted)";
      }

      tableResults.push({
        handler: h.name,
        origin: tc.origin || "(none)",
        status: res.statusCode,
        allowOriginHeader: allowOrigin,
        varyHeader: vary,
        result: passed ? "PASS" : "FAIL",
        notes,
      });
    }
  }

  // Print results table
  console.log("CORS TEST RESULTS TABLE:");
  console.log("-------------------------------------------------------------------------------------------------------------------------");
  console.log(
    "Handler".padEnd(20) +
    "Origin".padEnd(30) +
    "Status".padEnd(8) +
    "Allow-Origin Header".padEnd(30) +
    "Vary".padEnd(10) +
    "Verdict".padEnd(8) +
    "Notes"
  );
  console.log("-------------------------------------------------------------------------------------------------------------------------");

  for (const r of tableResults) {
    const line =
      r.handler.padEnd(20) +
      r.origin.padEnd(30) +
      String(r.status).padEnd(8) +
      r.allowOriginHeader.padEnd(30) +
      r.varyHeader.padEnd(10) +
      r.result.padEnd(8) +
      r.notes;
    console.log(line);
  }

  console.log("-------------------------------------------------------------------------------------------------------------------------\n");

  const totalRuns = tableResults.length;
  const passedRuns = tableResults.filter((r) => r.result === "PASS").length;

  console.log(`Total Handlers Tested: ${HANDLERS.length}`);
  console.log(`Total Cases Evaluated: ${totalRuns}`);
  console.log(`Passed:                ${passedRuns} / ${totalRuns}`);
  console.log(`Violations Found:      ${violations}\n`);

  if (violations > 0) {
    console.error(`❌ CORS VERIFICATION FAILED with ${violations} security violation(s)! Exiting with code 1.`);
    process.exit(1);
  }

  console.log("🎉 ALL CORS CHECKS PASSED: Zero wildcards, zero echoed untrusted origins, strict allow-list enforced.");
  process.exit(0);
}

runCorsTests().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
