/**
 * scripts/test-no-dummy-jobs.ts
 *
 * Verification suite proving that DUMMY_JOBS and "sample-" job IDs are completely
 * unreachable from getLiveJobs, getLiveJobById, getAllActiveJobs, and all user-facing
 * routes, ensuring fail-closed empty states when Supabase or network queries fail.
 *
 * Supports --negative-control to verify non-zero exit on corrupted expectations.
 */

import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("         CAREERMONKE DUMMY_JOBS & SAMPLE JOBS REMOVAL VERIFICATION                ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const failures: string[] = [];

  // ---------------------------------------------------------------------------
  // 1. Runtime getLiveJobs Offline / Error Behavior
  // ---------------------------------------------------------------------------
  console.log("TEST 1: Verifying getLiveJobs returns empty states and ZERO sample jobs on failure...");

  // Force Supabase client / fetch to simulate network / database failure
  const origEnvUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const origEnvAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  try {
    const { getLiveJobs, getLiveJobById, getAllActiveJobs } = await import("../src/lib/jobs/service");

    const scenarios = [
      { name: "Default paging", opts: { page: 1, pageSize: 25 } },
      { name: "Category search", opts: { category: "ai", page: 1, pageSize: 25 } },
      { name: "Keyword search", opts: { search: "Engineer", page: 1, pageSize: 25 } },
      { name: "Remote only", opts: { remoteOnly: true, page: 1, pageSize: 25 } },
      { name: "Experience filter", opts: { experience: "3-5 Years", page: 1, pageSize: 25 } },
    ];

    for (const sc of scenarios) {
      const res = await getLiveJobs(sc.opts);
      let jobs = res.jobs || [];

      if (isNegativeControl && sc.name === "Default paging") {
        // Inject a simulated sample job in negative control mode
        jobs = [{ id: "sample-openai-01", title: "Research Engineer" } as any];
      }

      const sampleJob = jobs.find((j) => j.id.startsWith("sample-") || (j.title || "").includes("Research Engineer, Foundation Models"));
      if (sampleJob) {
        failures.push(`getLiveJobs scenario '${sc.name}' returned sample job: ${sampleJob.id} (${sampleJob.title})`);
      } else if (jobs.length > 0) {
        failures.push(`getLiveJobs scenario '${sc.name}' expected 0 jobs on unconfigured DB, but returned ${jobs.length} jobs`);
      } else {
        console.log(`  [PASS] scenario '${sc.name}': returned 0 jobs and zero sample IDs (totalCount: ${res.totalCount})`);
      }
    }

    // ---------------------------------------------------------------------------
    // 2. Runtime getLiveJobById & getAllActiveJobs Fallback Behavior
    // ---------------------------------------------------------------------------
    console.log("\nTEST 2: Verifying getLiveJobById and getAllActiveJobs return null / empty list...");

    const sampleDetail = await getLiveJobById("sample-openai-01", false);
    if (sampleDetail !== null) {
      failures.push(`getLiveJobById('sample-openai-01') returned a sample job object instead of null: ${sampleDetail.id}`);
    } else {
      console.log("  [PASS] getLiveJobById('sample-openai-01') safely returned null");
    }

    const allActive = await getAllActiveJobs();
    const hasSampleInAll = (allActive || []).some((j) => j.id.startsWith("sample-"));
    if (hasSampleInAll) {
      failures.push("getAllActiveJobs returned items with 'sample-' IDs!");
    } else if (allActive.length > 0) {
      failures.push(`getAllActiveJobs returned ${allActive.length} jobs on offline environment; expected 0`);
    } else {
      console.log(`  [PASS] getAllActiveJobs returned empty array (count: ${allActive.length})`);
    }
  } catch (err: any) {
    failures.push(`Runtime service invocation error: ${err?.message || err}`);
  } finally {
    if (origEnvUrl) process.env.NEXT_PUBLIC_SUPABASE_URL = origEnvUrl;
    if (origEnvAnon) process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = origEnvAnon;
  }

  // ---------------------------------------------------------------------------
  // 3. Static Code Audit: Complete Removal from Core Files
  // ---------------------------------------------------------------------------
  console.log("\nTEST 3: Scanning source files to ensure zero reachable DUMMY_JOBS...");

  const filesToCheck = [
    {
      file: "src/lib/jobs/service.ts",
      forbidden: ["DUMMY_JOBS", "sample-openai-01", "sample-anthropic-02"],
      name: "Service layer",
    },
    {
      file: "src/app/remote/[slug]/titles/page.tsx",
      forbidden: ["DUMMY_JOBS"],
      name: "Role titles page",
    },
    {
      file: "src/app/remote/jobs/[category]/page.tsx",
      forbidden: ["DUMMY_JOBS"],
      name: "Category jobs page",
    },
    {
      file: "src/lib/cron/dailyDigestCron.ts",
      forbidden: ["DUMMY_JOBS"],
      name: "Daily digest cron",
    },
  ];

  for (const item of filesToCheck) {
    const fullPath = path.resolve(process.cwd(), item.file);
    if (!fs.existsSync(fullPath)) {
      failures.push(`Expected file ${item.file} does not exist!`);
      continue;
    }

    const content = fs.readFileSync(fullPath, "utf-8");
    for (const term of item.forbidden) {
      if (content.includes(term)) {
        failures.push(`${item.name} (${item.file}) still contains forbidden term '${term}'!`);
      }
    }
    console.log(`  [PASS] ${item.name} contains zero references to ${item.forbidden.join(", ")}`);
  }

  // ---------------------------------------------------------------------------
  // 4. Data Layer Audit: data/jobs.ts & src/data/jobs.ts
  // ---------------------------------------------------------------------------
  console.log("\nTEST 4: Verifying data/jobs.ts and src/data/jobs.ts expose empty datasets...");

  const dataFiles = ["data/jobs.ts", "src/data/jobs.ts"];
  for (const df of dataFiles) {
    const fullPath = path.resolve(process.cwd(), df);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, "utf-8");
      if (content.includes("sample-openai-01") || content.includes("sample-anthropic-02")) {
        failures.push(`${df} still contains sample job IDs!`);
      } else if (!content.includes("export const DUMMY_JOBS: Job[] = [];")) {
        failures.push(`${df} does not export an empty DUMMY_JOBS array!`);
      } else {
        console.log(`  [PASS] ${df} contains 0 sample job records (empty array export)`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Summary & Exit Codes
  // ---------------------------------------------------------------------------
  if (failures.length > 0) {
    console.error(`\nFAIL: Encountered ${failures.length} failure(s):`);
    for (const f of failures) {
      console.error(` - ${f}`);
    }
    process.exit(1);
  }

  console.log("\nALL NO-DUMMY-JOBS ASSERTIONS PASSED [PASS-LOCAL]\n");
  process.exit(0);
}

run().catch((err) => {
  console.error("Unexpected test exception:", err);
  process.exit(1);
});
