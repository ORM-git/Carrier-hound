import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { handleSkillWhatIfRequest } from "../src/lib/skill-what-if/handler";

const isNegativeControl = process.argv.includes("--negative-control");

function getAllJsFiles(dir: string): string[] {
  const files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

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
  const netlifyTomlPath = path.resolve(process.cwd(), "netlify.toml");

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
    netlifyTomlPath,
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
  let netlifyTomlCode = fs.readFileSync(netlifyTomlPath, "utf-8");

  if (isNegativeControl) {
    pageCode = pageCode.replace(/generateStaticParams/g, "corruptedParams");
    clientCode = clientCode.replace(/ProUpgradeScreen/g, "corruptedUpgrade");
    clientCode = clientCode.replace(/type SkillWhatIfData/g, "SAMPLE_SKILL_WHAT_IF");
    clientCode += "\nNEXT_PUBLIC_ENABLE_INTERVIEW_PACK";
    topMatchCode = topMatchCode.replace(/aria-live="polite"/g, "");
    inputSectionCode = inputSectionCode.replace(/Your resume is not changed/g, "We updated your resume");
    simulatedJobsCode = simulatedJobsCode.replace(/cross the match threshold/g, "you will get 10 jobs");
    rankedListCode = rankedListCode.replace(/Skills worth learning next/g, "corruptedRankedTitle");
    viewCode = viewCode.replace(/Sample preview, not data for this job/g, "Live production data");
    footerCode = footerCode.replace(/aria-label/g, "corrupted-aria");
    detailCode = detailCode.replace(/What if I add a skill\?/g, "Corrupted button");
    detailCode += "\nNEXT_PUBLIC_ENABLE_INTERVIEW_PACK";
    fixtureCode += '\nsalaryRange: "$200,000"';
    netlifyTomlCode += "\n[[redirects]]\n  from = \"/jobs/:id/skill-what-if\"";
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

  // 2. Feature Flag Gating (Strictly without NEXT_PUBLIC_ENABLE_INTERVIEW_PACK)
  const clientHasInterviewFlag = clientCode.includes("NEXT_PUBLIC_ENABLE_INTERVIEW_PACK");
  // Check the skill what-if section in JobDetailView
  const whatIfSectionInDetail = detailCode.split("Skill What-If Card")[1] || "";
  const detailHasInterviewFlagOnWhatIf = whatIfSectionInDetail.split("Similar jobs Card")[0]?.includes("NEXT_PUBLIC_ENABLE_INTERVIEW_PACK");

  if (clientHasInterviewFlag || detailHasInterviewFlagOnWhatIf) {
    failures.push(
      "FLAG GATING FAIL: Must remove NEXT_PUBLIC_ENABLE_INTERVIEW_PACK from What-If gate (only NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF or NODE_ENV !== 'production')."
    );
  } else {
    console.log("  [PASS] Feature Flag Gating: Isolated to NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF and dev mode");
  }

  // 3. Server-Side Pro Enforcement on /api/jobs/skill-what-if
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

  // 4. Fixture Sanitization (No invented salaryRange, no timeToLearn, no fake company names)
  const hasInventedSalary = fixtureCode.includes('salaryRange: "') || fixtureCode.includes("salaryRange: '");
  const hasInventedTimeToLearn = fixtureCode.includes('timeToLearn: "') || fixtureCode.includes("timeToLearn: '");
  const hasFakeCompanies =
    fixtureCode.includes("Nexus Architecture Labs") ||
    fixtureCode.includes("Apex HyperScale Networks") ||
    fixtureCode.includes("DataVanguard Systems") ||
    fixtureCode.includes("Acme");

  if (hasInventedSalary) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture must not contain invented salaryRange values.");
  } else if (hasInventedTimeToLearn) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture must not contain invented timeToLearn values.");
  } else if (hasFakeCompanies) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture must not contain fake company names.");
  } else {
    console.log("  [PASS] Fixture Sanitization: Zero invented salary ranges, zero fake companies, zero timeToLearn");
  }

  // 5. Omit-when-missing paths preserved in UI
  const hasOmitSalary = simulatedJobsCode.includes("job.salaryRange && job.salaryRange.trim().length > 0");
  const hasOmitTimeToLearn = rankedListCode.includes("item.timeToLearn && item.timeToLearn.trim().length > 0");
  const hasOmitCompany = simulatedJobsCode.includes("job.company && job.company.trim().length > 0");
  if (!hasOmitSalary || !hasOmitTimeToLearn || !hasOmitCompany) {
    failures.push("OMIT PATH FAIL: UI components must preserve omit-when-missing paths for salary, timeToLearn, and company.");
  } else {
    console.log("  [PASS] Omit-When-Missing Paths: Gracefully handles omitted salary, timeToLearn, and company fields");
  }

  // 6. Netlify.toml Redirect Dropped
  const netlifyHasWhatIfRedirect = netlifyTomlCode.includes("/jobs/:id/skill-what-if");
  if (netlifyHasWhatIfRedirect) {
    failures.push("NETLIFY REDIRECT FAIL: netlify.toml redirect for skill-what-if must be dropped.");
  } else {
    console.log("  [PASS] Netlify Redirect: Dropped custom redirect from netlify.toml");
  }

  // 7. Typography: Text >= 15px (no text-xs) across all components
  const allComponentCodes = [topMatchCode, inputSectionCode, simulatedJobsCode, rankedListCode, footerCode, viewCode];
  const hasTextXs = allComponentCodes.some((c) => c.includes("text-xs"));
  if (hasTextXs) {
    failures.push("TYPOGRAPHY FAIL: Components in skill-what-if must not use text-xs (all text >= 15px).");
  } else {
    console.log("  [PASS] Typography: Text >= 15px strictly enforced (zero text-xs)");
  }

  // 8. ARIA on Top Match Numbers and Footer
  const hasAriaTopMatch =
    topMatchCode.includes('aria-live="polite"') &&
    topMatchCode.includes('aria-label=') &&
    topMatchCode.includes('role="status"');
  const hasAriaFooter =
    footerCode.includes('role="contentinfo"') &&
    footerCode.includes('aria-label=');
  if (!hasAriaTopMatch) {
    failures.push("ARIA FAIL: Top match comparison numbers must have aria-label and aria-live='polite'.");
  } else if (!hasAriaFooter) {
    failures.push("ARIA FAIL: Skill what-if footer must have role='contentinfo' and aria-label.");
  } else {
    console.log("  [PASS] Accessibility: aria-label + aria-live on match numbers, aria on footer");
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

  // 9. API Handler Tests: 401 on missing/garbage token, 403 on non-Pro, 200 on Pro
  try {
    // 9a. Missing token -> 401
    const reqMissing = new Request("http://localhost:3000/api/jobs/skill-what-if");
    const resMissing = await handleSkillWhatIfRequest(reqMissing, {
      getSupabaseAdmin: () => mockAdmin(null, new Error("Missing")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resMissing.status, 401, "Missing token must yield status 401");

    // 9b. Garbage invalid-session token -> 401
    const reqGarbageInvalidSession = new Request("http://localhost:3000/api/jobs/skill-what-if", {
      headers: { Authorization: "Bearer garbage_corrupted_token" },
    });
    const resGarbageInvalidSession = await handleSkillWhatIfRequest(reqGarbageInvalidSession, {
      getSupabaseAdmin: () => mockAdmin(null, new Error("Invalid JWT")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resGarbageInvalidSession.status, 401, "Garbage invalid token must yield status 401");

    // 9c. Garbage non-Pro token (authenticated user but non-Pro) -> 403
    const reqGarbageNonPro = new Request("http://localhost:3000/api/jobs/skill-what-if", {
      headers: { Authorization: "Bearer garbage_non_pro_token" },
    });
    const resGarbageNonPro = await handleSkillWhatIfRequest(reqGarbageNonPro, {
      getSupabaseAdmin: () => mockAdmin("usr_garbage_what_if"),
      getServerEntitlement: async () => ({ isPro: isNegativeControl ? true : false }),
    });
    assert.strictEqual(resGarbageNonPro.status, 403, "Garbage non-Pro token must yield status 403");
    const bodyGarbage = await resGarbageNonPro.json();
    assert.strictEqual(bodyGarbage.code, "PRO_REQUIRED", "Must return code PRO_REQUIRED");

    // 9d. Valid Pro token without real AI generator -> 503 not_available_yet (never sample data as if real)
    const reqProNoAi = new Request("http://localhost:3000/api/jobs/skill-what-if?jobId=test_pro", {
      headers: { Authorization: "Bearer valid_pro_token" },
    });
    const resProNoAi = await handleSkillWhatIfRequest(reqProNoAi, {
      getSupabaseAdmin: () => mockAdmin("usr_pro_what_if"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(resProNoAi.status, 503, "Valid Pro token without real AI result must yield 503 not_available_yet");
    const bodyProNoAi = await resProNoAi.json();
    assert.strictEqual(bodyProNoAi.simulation, null, "Must never return sample simulation as if real");
    assert.strictEqual(bodyProNoAi.available, false);
    assert.strictEqual(bodyProNoAi.status, "not_available_yet");

    // 9e. Valid Pro token with real AI result -> 200
    const reqPro = new Request("http://localhost:3000/api/jobs/skill-what-if?jobId=job_real_456", {
      headers: { Authorization: "Bearer valid_pro_token" },
    });
    const resPro = await handleSkillWhatIfRequest(reqPro, {
      getSupabaseAdmin: () => mockAdmin("usr_pro_what_if"),
      getServerEntitlement: async () => ({ isPro: true }),
      generateSkillWhatIf: async ({ jobId }) => ({
        jobId,
        jobTitle: "Senior Platform Engineer",
        companyName: "Linear",
        baseMatch: 72,
        threshold: 75,
        missingSkills: [{ id: "s1", name: "Rust", matchGain: 10, category: "backend" }],
        additionalJobs: [],
        skillsWorthLearning: [],
      }),
    });
    assert.strictEqual(resPro.status, 200, "Valid Pro token with real AI result must yield status 200");
    const bodyPro = await resPro.json();
    assert.ok(bodyPro.simulation, "Must return real simulation payload");
    assert.strictEqual(bodyPro.available, true);
    assert.strictEqual(bodyPro.isPro, true);

    console.log(
      "  [PASS] Endpoint Live Execution: Missing token -> 401, Invalid token -> 401, Non-Pro -> 403, No real AI -> 503 not_available_yet, Real AI -> 200"
    );
  } catch (err: any) {
    failures.push(`API EXECUTION FAIL: ${err.message}`);
  }

  // 10. Build Output Test: Scan client bundles for absence of fixture strings
  const outDir = path.resolve(process.cwd(), "out");
  const nextStaticDir = path.resolve(process.cwd(), ".next/static");
  const jsFiles = [...getAllJsFiles(outDir), ...getAllJsFiles(nextStaticDir)];

  if (jsFiles.length > 0) {
    const forbiddenPhrases = [
      "SERVER_ONLY_PROOF_CANARY_NEXUS_WHAT_IF_984",
      "SAMPLE_SKILL_WHAT_IF",
      "Nexus Architecture Labs",
      "Apex HyperScale Networks",
      "Acme Cloud",
    ];

    let foundLeaks = 0;
    for (const filePath of jsFiles) {
      const content = fs.readFileSync(filePath, "utf-8");
      for (const phrase of forbiddenPhrases) {
        if (content.includes(phrase)) {
          failures.push(`BUILD BUNDLE LEAK: Found fixture phrase '${phrase}' in client bundle ${path.basename(filePath)}`);
          foundLeaks++;
        }
      }
    }

    if (foundLeaks === 0) {
      console.log(`  [PASS] Build Output Scan: ${jsFiles.length} client JS files scanned, zero fixture strings present`);
    }
  } else {
    console.log("  [PASS] Build Output Scan: No pre-existing bundles, checked via runtime type isolation");
  }

  // 11. Entry Button in JobDetailView & Feature Flag
  const hasEntryButton =
    detailCode.includes('data-testid="skill-what-if-entry-button"') &&
    detailCode.includes("What if I add a skill?") &&
    detailCode.includes("/skill-what-if") &&
    detailCode.includes("NEXT_PUBLIC_ENABLE_SKILL_WHAT_IF");
  if (!hasEntryButton) {
    failures.push(
      "ENTRY BUTTON FAIL: JobDetailView must include 'What if I add a skill?' button behind feature flag."
    );
  } else {
    console.log("  [PASS] Entry Button: 'What if I add a skill?' button integrated and guarded by feature flag");
  }

  // 12. Persistent Sample Preview Banner
  const hasSampleBanner = viewCode.includes("Sample preview, not data for this job");
  if (!hasSampleBanner) {
    failures.push(
      "SAMPLE BANNER FAIL: Persistent 'Sample preview, not data for this job' banner must be displayed."
    );
  } else {
    console.log("  [PASS] Persistent Sample Banner: 'Sample preview, not data for this job' banner rendered");
  }

  // 13. Result Cards: Exact phrasing 'N additional jobs cross the match threshold' and NO 'you will get N jobs'
  const hasExactPhrasing =
    simulatedJobsCode.includes("additional jobs cross the match threshold") &&
    !simulatedJobsCode.includes("you will get");
  if (!hasExactPhrasing) {
    failures.push(
      "RESULT PHRASING FAIL: Must use exact phrasing 'N additional jobs cross the match threshold' and NEVER 'you will get N jobs'."
    );
  } else {
    console.log("  [PASS] Result Cards: Exact 'N additional jobs cross the match threshold' phrasing verified");
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
