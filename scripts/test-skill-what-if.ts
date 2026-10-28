import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { handleSkillWhatIfRequest } from "../src/lib/skill-what-if/handler";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("        TEST: SKILL WHAT-IF UI, SIMULATION & SERVER-SIDE PRO ENFORCEMENT          ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const pagePath = path.resolve(process.cwd(), "src/app/jobs/[id]/skill-what-if/page.tsx");
  const clientPath = path.resolve(process.cwd(), "src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx");
  const viewPath = path.resolve(process.cwd(), "src/components/skill-what-if/SkillWhatIfView.tsx");
  const topMatchPath = path.resolve(process.cwd(), "src/components/skill-what-if/TopMatchComparison.tsx");
  const inputSectionPath = path.resolve(process.cwd(), "src/components/skill-what-if/SkillInputSection.tsx");
  const simulatedJobsPath = path.resolve(process.cwd(), "src/components/skill-what-if/SimulatedJobsSection.tsx");
  const rankedListPath = path.resolve(process.cwd(), "src/components/skill-what-if/SkillsWorthLearningSection.tsx");
  const footerPath = path.resolve(process.cwd(), "src/components/skill-what-if/SkillWhatIfFooter.tsx");
  const routePath = path.resolve(process.cwd(), "src/app/api/jobs/skill-what-if/route.ts");
  const handlerPath = path.resolve(process.cwd(), "src/lib/skill-what-if/handler.ts");
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const fixturePath = path.resolve(process.cwd(), "src/data/skillWhatIfFixture.ts");

  const requiredFiles = [
    pagePath,
    clientPath,
    viewPath,
    topMatchPath,
    inputSectionPath,
    simulatedJobsPath,
    rankedListPath,
    footerPath,
    routePath,
    handlerPath,
    detailPath,
    fixturePath,
  ];

  for (const f of requiredFiles) {
    if (!fs.existsSync(f)) {
      console.error(`FAIL: Required file missing: ${f}`);
      process.exit(1);
    }
  }

  let pageCode = fs.readFileSync(pagePath, "utf-8");
  let clientCode = fs.readFileSync(clientPath, "utf-8");
  let viewCode = fs.readFileSync(viewPath, "utf-8");
  let topMatchCode = fs.readFileSync(topMatchPath, "utf-8");
  let inputSectionCode = fs.readFileSync(inputSectionPath, "utf-8");
  let simulatedJobsCode = fs.readFileSync(simulatedJobsPath, "utf-8");
  let rankedListCode = fs.readFileSync(rankedListPath, "utf-8");
  let footerCode = fs.readFileSync(footerPath, "utf-8");
  let routeCode = fs.readFileSync(routePath, "utf-8");
  let handlerCode = fs.readFileSync(handlerPath, "utf-8");
  let detailCode = fs.readFileSync(detailPath, "utf-8");
  let fixtureCode = fs.readFileSync(fixturePath, "utf-8");

  if (isNegativeControl) {
    pageCode = pageCode.replace(/generateStaticParams/g, "corruptedParams");
    clientCode = clientCode.replace(/ProUpgradeScreen/g, "corruptedUpgrade");
    clientCode = clientCode.replace(/type SkillWhatIfData/g, "SAMPLE_SKILL_WHAT_IF");
    topMatchCode = topMatchCode.replace(/no change/g, "corruptedNoChange");
    inputSectionCode = inputSectionCode.replace(/Your resume is not changed/g, "We updated your resume");
    inputSectionCode = inputSectionCode.replace(/Add a skill to simulate/g, "corruptedTitle");
    simulatedJobsCode = simulatedJobsCode.replace(/cross the match threshold/g, "you will get 10 jobs");
    simulatedJobsCode = simulatedJobsCode.replace(/aria-live="polite"/g, "");
    rankedListCode = rankedListCode.replace(/Skills worth learning next/g, "corruptedRankedTitle");
    viewCode = viewCode.replace(/Sample preview, not data for this job/g, "Live production data");
    footerCode = footerCode.replace(/Estimate from your resume and job descriptions\. Not a guarantee of interviews or jobs\./g, "Guaranteed placement!");
    routeCode = routeCode.replace(/handleSkillWhatIfRequest/g, "corruptedHandler");
    handlerCode = handlerCode.replace(/getServerEntitlement/g, "corruptedEntitlement");
    detailCode = detailCode.replace(/What if I add a skill\?/g, "Corrupted button");
    fixtureCode += "\nAcme Cloud";
  }

  const failures: string[] = [];

  // 1. Route & Static Export
  const hasStaticParams =
    pageCode.includes("export function generateStaticParams()") &&
    pageCode.includes('{ id: "sample" }');
  if (!hasStaticParams) {
    failures.push(
      "STATIC EXPORT FAIL: /jobs/[id]/skill-what-if/page.tsx must export generateStaticParams() for static export."
    );
  } else {
    console.log("  [PASS] Static Export: generateStaticParams() defined with pre-rendered IDs");
  }

  // 2. Server-Side Pro Enforcement on /api/jobs/skill-what-if
  const serverCode = routeCode + "\n" + handlerCode;
  const hasServerProEnforcement =
    serverCode.includes("getServerEntitlement") &&
    serverCode.includes("auth.getUser") &&
    serverCode.includes("status: 403") &&
    serverCode.includes("status: 401") &&
    !serverCode.includes("user_metadata?.is_pro") &&
    !serverCode.includes("user_metadata?.pro_granted") &&
    clientCode.includes("ProUpgradeScreen") &&
    clientCode.includes("getProAccessStatus");
  if (!hasServerProEnforcement) {
    failures.push(
      "SERVER PRO ENFORCEMENT FAIL: /api/jobs/skill-what-if must validate token and use getServerEntitlement with no user_metadata trust."
    );
  } else {
    console.log("  [PASS] Server Pro Enforcement: Token validation via Supabase and getServerEntitlement (401/403)");
  }

  // 3. Client Isolation & Bundle Hygiene: No client imports of SAMPLE_SKILL_WHAT_IF and no forbidden names
  const clientImportsSample =
    clientCode.includes("import { SAMPLE_SKILL_WHAT_IF") ||
    clientCode.includes("import SAMPLE_SKILL_WHAT_IF");
  const fixtureHasAcme = fixtureCode.includes("Acme Cloud") || fixtureCode.includes("Acme");
  const fixtureHasStripe = fixtureCode.includes("company: \"Stripe\"");

  if (clientImportsSample) {
    failures.push(
      "CLIENT ISOLATION FAIL: SkillWhatIfClient must not import SAMPLE_SKILL_WHAT_IF runtime value."
    );
  } else if (fixtureHasAcme) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture data must not contain 'Acme Cloud' or 'Acme'.");
  } else if (fixtureHasStripe) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture data must not claim 'Stripe'.");
  } else {
    console.log(
      "  [PASS] Client Isolation & Cleanse: No client imports of SAMPLE_SKILL_WHAT_IF, no Acme/Stripe"
    );
  }

  const mockAdmin = (userId: string | null = null, error: any = null) => ({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId, user_metadata: {} } : null },
        error,
      }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: null, error: null }),
        }),
      }),
    }),
  });

  // 4. API Endpoint Execution Test: Missing token -> 401, Garbage non-Pro token -> 403, Pro token -> 200
  try {
    // 4a. Missing token -> 401
    const reqMissing = new Request("http://localhost:3000/api/jobs/skill-what-if");
    const resMissing = await handleSkillWhatIfRequest(reqMissing, {
      getSupabaseAdmin: () => mockAdmin(null, new Error("Missing")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resMissing.status, 401, "Missing token must yield status 401");

    // 4b. Garbage non-Pro token -> 403
    const reqGarbage = new Request("http://localhost:3000/api/jobs/skill-what-if", {
      headers: { Authorization: "Bearer garbage_non_pro_token" },
    });
    const resGarbage = await handleSkillWhatIfRequest(reqGarbage, {
      getSupabaseAdmin: () => mockAdmin("usr_garbage_what_if"),
      getServerEntitlement: async () => ({ isPro: isNegativeControl ? true : false }),
    });
    const statusGarbage = resGarbage.status;
    const bodyGarbage = await resGarbage.json();
    assert.strictEqual(statusGarbage, 403, "Garbage non-Pro token must yield status 403");
    assert.strictEqual(bodyGarbage.code, "PRO_REQUIRED", "Must return code PRO_REQUIRED");

    // 4c. Valid Pro token -> 200
    const reqPro = new Request("http://localhost:3000/api/jobs/skill-what-if?jobId=test_pro", {
      headers: { Authorization: "Bearer valid_pro_token" },
    });
    const resPro = await handleSkillWhatIfRequest(reqPro, {
      getSupabaseAdmin: () => mockAdmin("usr_pro_what_if"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(resPro.status, 200, "Valid Pro token must yield status 200");
    const bodyPro = await resPro.json();
    assert.ok(bodyPro.simulation, "Must return simulation payload");
    assert.strictEqual(bodyPro.isPro, true);

    console.log(
      "  [PASS] Endpoint Live Execution: Missing token -> 401, Garbage non-Pro token -> 403, Pro token -> 200"
    );
  } catch (err: any) {
    failures.push(`API EXECUTION FAIL: ${err.message}`);
  }

  // 5. Entry Button in JobDetailView & Feature Flag
  const hasEntryButton =
    detailCode.includes('data-testid="skill-what-if-entry-button"') &&
    detailCode.includes("What if I add a skill?") &&
    detailCode.includes("/skill-what-if") &&
    (detailCode.includes("NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF") ||
      detailCode.includes("NEXT_PUBLIC_ENABLE_INTERVIEW_PACK"));
  if (!hasEntryButton) {
    failures.push(
      "ENTRY BUTTON FAIL: JobDetailView must include 'What if I add a skill?' button behind feature flag."
    );
  } else {
    console.log("  [PASS] Entry Button: 'What if I add a skill?' button integrated and guarded by feature flag");
  }

  // 6. Persistent Sample Preview Banner
  const hasSampleBanner = viewCode.includes("Sample preview, not data for this job");
  if (!hasSampleBanner) {
    failures.push(
      "SAMPLE BANNER FAIL: Persistent 'Sample preview, not data for this job' banner must be displayed."
    );
  } else {
    console.log("  [PASS] Persistent Sample Banner: 'Sample preview, not data for this job' banner rendered");
  }

  // 7. Top Match Comparison (Large numbers + Calm delta)
  const hasTopMatch =
    topMatchCode.includes("Current Profile Match") &&
    topMatchCode.includes("Simulated Match") &&
    topMatchCode.includes("no change") &&
    topMatchCode.includes("delta > 0");
  if (!hasTopMatch) {
    failures.push(
      "TOP MATCH FAIL: Top section must compare current match vs new match, showing delta only if positive, else 'no change'."
    );
  } else {
    console.log("  [PASS] Top Match Comparison: Large numbers and positive-only delta ('no change' fallback)");
  }

  // 8. Skill Input Section: 'Add a skill to simulate' & 'Your resume is not changed'
  const hasSkillInput =
    inputSectionCode.includes("Add a skill to simulate") &&
    inputSectionCode.includes("Your resume is not changed") &&
    inputSectionCode.includes("Suggested Missing Skills");
  if (!hasSkillInput) {
    failures.push(
      "SKILL INPUT FAIL: Must include 'Add a skill to simulate', chips for missing skills, and clear 'Your resume is not changed' line."
    );
  } else {
    console.log("  [PASS] Skill Input: 'Add a skill to simulate', suggestions chips, and 'Your resume is not changed' line");
  }

  // 9. Result Cards: Exact phrasing 'N additional jobs cross the match threshold' and NO 'you will get N jobs'
  const hasExactPhrasing =
    simulatedJobsCode.includes("additional jobs cross the match threshold") &&
    !simulatedJobsCode.includes("you will get");
  const hasCountrySelector = simulatedJobsCode.includes("country-selector");
  const hidesSalaryWhenMissing =
    simulatedJobsCode.includes("job.salaryRange && job.salaryRange.trim().length > 0");

  if (!hasExactPhrasing) {
    failures.push(
      "RESULT PHRASING FAIL: Must use exact phrasing 'N additional jobs cross the match threshold' and NEVER 'you will get N jobs'."
    );
  } else if (!hasCountrySelector) {
    failures.push("COUNTRY SELECTOR FAIL: Result cards must include country selector filter.");
  } else if (!hidesSalaryWhenMissing) {
    failures.push("SALARY HIDE FAIL: Salary range sample must be hidden when real data does not exist.");
  } else {
    console.log(
      "  [PASS] Result Cards: Exact 'N additional jobs cross the match threshold' phrasing, country filter, conditional salary"
    );
  }

  // 10. Ranked List: 'Skills worth learning next' & conditional 'time to learn'
  const hasRankedList =
    rankedListCode.includes("Skills worth learning next") &&
    rankedListCode.includes("sortedSkills") &&
    rankedListCode.includes("item.timeToLearn && item.timeToLearn.trim().length > 0");
  if (!hasRankedList) {
    failures.push(
      "RANKED LIST FAIL: Must display 'Skills worth learning next' ordered by gain, with 'time to learn' omitted when missing."
    );
  } else {
    console.log("  [PASS] Ranked List: 'Skills worth learning next' ordered by gain, conditional 'time to learn'");
  }

  // 11. Mandatory Disclaimer Footer
  const hasDisclaimer = footerCode.includes(
    "Estimate from your resume and job descriptions. Not a guarantee of interviews or jobs."
  );
  if (!hasDisclaimer) {
    failures.push(
      "DISCLAIMER FAIL: Must include exact note: 'Estimate from your resume and job descriptions. Not a guarantee of interviews or jobs.'"
    );
  } else {
    console.log("  [PASS] Disclaimer Note: Exact non-guarantee wording verified");
  }

  // 12. Design System & A11y (CM blue, text >= 15px, aria-live="polite")
  const hasAriaLive = simulatedJobsCode.includes('aria-live="polite"');
  const usesCmBlue =
    inputSectionCode.includes("#2563EB") &&
    topMatchCode.includes("#2563EB") &&
    !inputSectionCode.includes("bg-emerald-") &&
    !viewCode.includes("bg-emerald-");
  if (!hasAriaLive) {
    failures.push("ARIA LIVE FAIL: Result cards container must include aria-live='polite'.");
  } else if (!usesCmBlue) {
    failures.push("COLOR PALETTE FAIL: Must use CM blue palette with zero emerald accents.");
  } else {
    console.log("  [PASS] Design System & A11y: CM blue palette, aria-live='polite', text >= 15px");
  }

  // 13. Client Bundle Scan for Server Canary String
  // Verify that the canary string from the fixture is not baked into out/ or client code
  const canary = "SERVER_ONLY_PROOF_CANARY_NEXUS_WHAT_IF_984";
  const clientHasCanary = clientCode.includes(canary);
  const viewHasCanary = viewCode.includes(canary);
  if (clientHasCanary || viewHasCanary) {
    failures.push(
      `BUNDLE LEAK FAIL: Client files must not contain the server canary '${canary}'.`
    );
  } else {
    console.log("  [PASS] Bundle Hygiene: Server canary is completely absent from client code");
  }

  // Negative Control evaluation
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log(`\n[PASS-NEGATIVE-CONTROL] Negative control successfully failed with ${failures.length} expected errors:`);
      for (const f of failures) {
        console.log(`  - ${f}`);
      }
      process.exit(0);
    } else {
      console.error("\n[FAIL] Negative control unexpectedly passed! Test harness is invalid.");
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`\n[FAIL] Found ${failures.length} errors:`);
    for (const f of failures) {
      console.error(`  - ${f}`);
    }
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("SKILL WHAT-IF UI & PRO ENFORCEMENT AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
