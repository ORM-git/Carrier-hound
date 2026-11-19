import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { getValidReturnUrl } from "../src/lib/auth/session";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("        TEST: RETIREMENT & REMOVAL OF SKILL WHAT-IF FEATURE                       ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const deletedFiles = [
    "src/app/jobs/[id]/skill-what-if/page.tsx",
    "src/app/jobs/[id]/skill-what-if/SkillWhatIfClient.tsx",
    "src/components/skill-what-if/SkillWhatIfView.tsx",
    "src/components/skill-what-if/TopMatchComparison.tsx",
    "src/components/skill-what-if/SkillInputSection.tsx",
    "src/components/skill-what-if/SimulatedJobsSection.tsx",
    "src/components/skill-what-if/SkillsWorthLearningSection.tsx",
    "src/components/skill-what-if/SkillWhatIfFooter.tsx",
    "src/app/api/jobs/skill-what-if/route.ts",
    "netlify/functions/skill-what-if.ts",
  ];

  const preservedSharedFiles = [
    "src/lib/skill-what-if/handler.ts",
    "src/data/skillWhatIfFixture.ts",
  ];

  const failures: string[] = [];

  // 1. Assert all feature pages, clients, components, and routes are deleted
  for (const rel of deletedFiles) {
    const fullPath = path.resolve(process.cwd(), rel);
    const exists = isNegativeControl && rel === "src/app/api/jobs/skill-what-if/route.ts" ? true : fs.existsSync(fullPath);
    if (exists) {
      failures.push(`DELETION FAIL: ${rel} must be deleted from product.`);
    }
  }
  if (!failures.some((f) => f.includes("DELETION FAIL"))) {
    console.log(`  [PASS] 1. Feature files deleted: all ${deletedFiles.length} Skill What-If files removed.`);
  }

  // 2. Assert shared handler and fixtures are preserved for non-UI/test usage
  for (const rel of preservedSharedFiles) {
    const fullPath = path.resolve(process.cwd(), rel);
    if (!fs.existsSync(fullPath)) {
      failures.push(`PRESERVATION FAIL: Shared file ${rel} must be preserved.`);
    }
  }
  if (!failures.some((f) => f.includes("PRESERVATION FAIL"))) {
    console.log("  [PASS] 2. Shared code preserved: handler and fixtures intact.");
  }

  // 3. Assert JobDetailView does not offer Skill What-If entry points
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const detailCode = fs.readFileSync(detailPath, "utf-8");
  for (const forbidden of [
    "What if I add a skill?",
    "/skill-what-if",
  ]) {
    if (detailCode.includes(forbidden)) {
      failures.push(`UI ENTRY FAIL: JobDetailView must not contain '${forbidden}'.`);
    }
  }
  if (!failures.some((f) => f.includes("UI ENTRY FAIL"))) {
    console.log("  [PASS] 3. UI entry points: JobDetailView has no Skill What-If entry controls.");
  }

  // 4. Assert redirects in middleware, netlify.toml, and public/_redirects
  const middlewareCode = fs.readFileSync(path.resolve(process.cwd(), "src/middleware.ts"), "utf-8");
  if (!middlewareCode.includes("/skill-what-if") || !middlewareCode.includes("/jobs")) {
    failures.push("REDIRECT FAIL: src/middleware.ts must redirect /skill-what-if to /jobs.");
  }

  const netlifyTomlCode = fs.readFileSync(path.resolve(process.cwd(), "netlify.toml"), "utf-8");
  if (!netlifyTomlCode.includes('from = "/jobs/:id/skill-what-if"') || !netlifyTomlCode.includes('to = "/jobs"')) {
    failures.push("REDIRECT FAIL: netlify.toml must redirect /jobs/:id/skill-what-if to /jobs.");
  }

  const publicRedirects = fs.readFileSync(path.resolve(process.cwd(), "public/_redirects"), "utf-8");
  if (!publicRedirects.includes("/jobs/*/skill-what-if /jobs 301!")) {
    failures.push("REDIRECT FAIL: public/_redirects must redirect /jobs/*/skill-what-if to /jobs.");
  }

  // 5. Assert getValidReturnUrl normalizes /skill-what-if to /jobs
  const returnTarget = getValidReturnUrl("/jobs/job-123/skill-what-if");
  if (returnTarget !== "/jobs") {
    failures.push(`AUTH RETURN FAIL: getValidReturnUrl must normalize skill-what-if to /jobs, got '${returnTarget}'.`);
  }
  if (!failures.some((f) => f.includes("REDIRECT FAIL") || f.includes("AUTH RETURN FAIL"))) {
    console.log("  [PASS] 4. Redirects & normalization: middleware, netlify.toml, public/_redirects, and return URL tested.");
  }

  // -------------------------------------------------------------------------
  // EVALUATION & EXIT
  // -------------------------------------------------------------------------
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log(`\n[PASS-NEGATIVE-CONTROL] Negative control successfully failed with ${failures.length} expected errors:`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(0);
    } else {
      console.error("\n[FAIL-NEGATIVE-CONTROL] Negative control failed to catch mutations!");
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`\nAUDIT FAILED with ${failures.length} issues:`);
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("SKILL WHAT-IF RETIREMENT & REMOVAL AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
