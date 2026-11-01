import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { GET as proGetRoute, POST as proPostRoute } from "../src/app/api/jobs/pro/route";
import { handler as netlifyJobsProHandler } from "../netlify/functions/jobs-pro";
import { computeFitDiagnostics, getDiagnosticsSummary } from "../src/lib/matcher/scoring";
import type { CandidateProfile } from "../src/lib/resume/types";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

function mockSupabaseAdmin(userId: string | null = null, role: "anon" | "free" | "pro" = "free") {
  return {
    auth: {
      getUser: async (token: string) => {
        if (!token || token.includes("bad") || token.includes("invalid")) {
          return { data: { user: null }, error: new Error("Invalid token") };
        }
        return {
          data: {
            user: {
              id: userId || "usr-test-001",
              email: "test@example.com",
              user_metadata: {},
            },
          },
          error: null,
        };
      },
    },
    from: (table: string) => ({
      select: (cols: string) => ({
        eq: (col: string, val: any) => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => {
                if (table === "jobs") {
                  return {
                    data: {
                      id: val,
                      title: "Staff Distributed Systems Engineer",
                      company: "ScaleTech",
                      location: "Remote (Worldwide)",
                      salary_text: "$220,000 - $260,000",
                      salary_min: 220000,
                      salary_max: 260000,
                      currency: "USD",
                      salary_period: "yearly",
                      description: "Architect core distributed storage engines in Go, Rust and Kubernetes.",
                      skills: ["Go", "Distributed Systems", "Kubernetes", "Rust"],
                      apply_url: "https://example.com/apply/123",
                      remote: true,
                      remote_scope: "worldwide",
                      job_type: "full-time",
                      category: "engineering",
                      country_code: "US",
                      posted_at: "2026-10-15T00:00:00Z",
                      is_active: true,
                      status: "active",
                    },
                    error: null,
                  };
                }
                return { data: null, error: null };
              },
            }),
          }),
          maybeSingle: async () => {
            if (table === "jobs") {
              return {
                data: {
                  id: val,
                  title: "Staff Distributed Systems Engineer",
                  company: "ScaleTech",
                  location: "Remote (Worldwide)",
                  salary_text: "$220,000 - $260,000",
                  salary_min: 220000,
                  salary_max: 260000,
                  currency: "USD",
                  salary_period: "yearly",
                  description: "Architect core distributed storage engines in Go, Rust and Kubernetes.",
                  skills: ["Go", "Distributed Systems", "Kubernetes", "Rust"],
                  apply_url: "https://example.com/apply/123",
                  remote: true,
                  remote_scope: "worldwide",
                  job_type: "full-time",
                  category: "engineering",
                  country_code: "US",
                  posted_at: "2026-10-15T00:00:00Z",
                  is_active: true,
                  status: "active",
                },
                error: null,
              };
            }
            return { data: null, error: null };
          },
        }),
        in: (col: string, vals: any[]) => ({
          data: vals.map((id) => ({
            id,
            title: "Staff Distributed Systems Engineer",
            company: "ScaleTech",
            location: "Remote (Worldwide)",
            salary_text: "$220,000 - $260,000",
            salary_min: 220000,
            salary_max: 260000,
            currency: "USD",
            salary_period: "yearly",
            description: "Architect core distributed storage engines in Go, Rust and Kubernetes.",
            skills: ["Go", "Distributed Systems", "Kubernetes", "Rust"],
            apply_url: "https://example.com/apply/123",
            remote: true,
            remote_scope: "worldwide",
            job_type: "full-time",
            category: "engineering",
            country_code: "US",
            posted_at: "2026-10-15T00:00:00Z",
            is_active: true,
            status: "active",
          })),
          error: null,
        }),
      }),
    }),
  };
}

async function runSuite() {
  console.log("==================================================================================");
  console.log("   CAREERMONKE HONESTY & PRO ENTITLEMENT GATING VERIFICATION SUITE                 ");
  console.log("==================================================================================");
  console.log(`Mode: ${IS_NEGATIVE_CONTROL ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VERIFICATION"}\n`);

  let failures: string[] = [];

  // ====================================================================================
  // TEST 1: Server-Side Pro Gating on /api/jobs/pro (App Router Route)
  // ====================================================================================
  console.log("TEST 1: Server-side gating on /api/jobs/pro (App Router)...");

  // 1a. Free user token must receive 403 Forbidden
  const freeReq = new Request("http://localhost:3000/api/jobs/pro?id=job-101", {
    headers: { Authorization: "Bearer free_user_token" },
  });
  const freeRes = await proGetRoute(freeReq, {
    getSupabaseAdmin: () => mockSupabaseAdmin("usr-free-1", "free"),
    getServerEntitlement: async () => ({ isPro: IS_NEGATIVE_CONTROL ? true : false }),
  });

  const freeStatus = freeRes.status;
  const freeBody = await freeRes.json();

  if (freeStatus !== 403) {
    failures.push(`SERVER PRO GATING FAIL: Free user received status ${freeStatus} instead of 403`);
  } else {
    console.log("  [PASS] 1a. Free user rejected by /api/jobs/pro with HTTP 403 Forbidden");
  }

  if (freeBody.isPro !== false) {
    failures.push("SERVER PRO GATING FAIL: Free user payload contains isPro != false");
  } else {
    console.log("  [PASS] 1b. Free user payload explicitly returns isPro: false");
  }

  if (freeBody.job || freeBody.jobs || freeBody.matchScore || freeBody.match_score) {
    failures.push("SERVER PRO GATING FAIL: Free user response leaked job details or match score");
  } else {
    console.log("  [PASS] 1c. Zero paid job fields or match scores received by Free user");
  }

  // 1b. Pro user token must receive 200 OK with unlocked data & match score
  const confirmedProCandidate: CandidateProfile = {
    name: "Alex Doe",
    email: "alex@example.com",
    headline: "Staff Distributed Systems Engineer",
    skills: ["Go", "Distributed Systems", "Kubernetes"],
    experience: [
      {
        id: "exp-1",
        company: "CloudCore",
        role: "Senior Distributed Systems Engineer",
        startDate: "2020",
        endDate: "Present",
        bullets: ["Built distributed consensus protocols in Go."],
      },
    ],
    confirmedAt: "2026-10-01T00:00:00Z",
  };

  const proReq = new Request(
    `http://localhost:3000/api/jobs/pro?id=job-101&candidate=${encodeURIComponent(JSON.stringify(confirmedProCandidate))}`,
    {
      headers: { Authorization: "Bearer pro_user_token" },
    }
  );
  const proRes = await proGetRoute(proReq, {
    getSupabaseAdmin: () => mockSupabaseAdmin("usr-pro-1", "pro"),
    getServerEntitlement: async () => ({ isPro: true }),
  });

  const proStatus = proRes.status;
  const proBody = await proRes.json();

  if (proStatus !== 200) {
    failures.push(`SERVER PRO UNLOCK FAIL: Pro user received status ${proStatus} instead of 200`);
  } else {
    console.log("  [PASS] 1d. Pro user authorized by /api/jobs/pro with HTTP 200 OK");
  }

  if (proBody.isPro !== true || !proBody.job?.apply_url) {
    failures.push("SERVER PRO UNLOCK FAIL: Pro user response missing unlocked fields");
  } else {
    console.log("  [PASS] 1e. Pro user receives full unlocked job details");
  }

  if (typeof proBody.job?.matchScore !== "number" || proBody.job.matchScore < 50) {
    failures.push(`SERVER PRO MATCH FAIL: Pro user match score missing or invalid: ${proBody.job?.matchScore}`);
  } else {
    console.log(`  [PASS] 1f. Pro user receives server-calculated Pro match score: ${proBody.job.matchScore}%`);
  }

  // ====================================================================================
  // TEST 2: Job Detail View UI Gating & Removal of "PRO MATCH 85%"
  // ====================================================================================
  console.log("\nTEST 2: Verifying JobDetailView source code honesty & gating...");
  const jobDetailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const jobDetailCode = fs.readFileSync(jobDetailPath, "utf-8");

  // Check 2a: No hardcoded blurred "85%"
  const hasBlurred85 = jobDetailCode.includes("85%</span>");
  if (hasBlurred85) {
    failures.push("FABRICATED CLAIM: JobDetailView still contains hardcoded blurred 85% claim");
  } else {
    console.log("  [PASS] 2a. Zero hardcoded blurred '85%' in JobDetailView");
  }

  // Check 2b: No "Pro Match" fallback badge
  const hasProMatchFallback = jobDetailCode.includes('"Pro Match"');
  if (hasProMatchFallback) {
    failures.push("FALSE BADGE: JobDetailView still contains 'Pro Match' fallback badge string");
  } else {
    console.log("  [PASS] 2b. Zero false 'Pro Match' badge in JobDetailView");
  }

  // Check 2c: Desktop Match breakdown gated behind isUnlocked
  const hasDesktopGating = jobDetailCode.includes("isUnlocked && hasConfirmedResume && matchScore !== null");
  if (!hasDesktopGating) {
    failures.push("UI GATING FAIL: JobDetailView desktop match breakdown not gated with isUnlocked");
  } else {
    console.log("  [PASS] 2c. Desktop match breakdown strictly gated: isUnlocked && hasConfirmedResume && matchScore !== null");
  }

  // Check 2d: Mobile Match row gated behind isUnlocked
  const mobileMatchMatch = jobDetailCode.match(/{\s*isUnlocked && hasConfirmedResume && matchScore !== null &&\s*\(\s*<div className="lg:hidden/);
  if (!mobileMatchMatch) {
    failures.push("UI GATING FAIL: JobDetailView mobile match score not gated with isUnlocked");
  } else {
    console.log("  [PASS] 2d. Mobile match score strictly gated: isUnlocked && hasConfirmedResume && matchScore !== null");
  }

  // ====================================================================================
  // TEST 3: Zero Fabricated Match Claims on Accounts with No Resume
  // ====================================================================================
  console.log("\nTEST 3: Verifying match claim generation for accounts with no resume...");

  // 3a. Null candidate
  const unconfirmedCandidate: CandidateProfile = {
    name: "New User",
    email: "new@example.com",
    skills: ["JavaScript", "TypeScript"],
    experience: [
      {
        id: "exp-sample-1",
        company: "Sample Tech",
        role: "Software Developer",
        startDate: "2022",
        endDate: "Present",
      },
    ],
    confirmedAt: undefined, // NOT confirmed!
  };

  const sampleJob = {
    id: "job-sample",
    title: "Software Developer",
    company: "Example Corp",
    skills: ["JavaScript", "TypeScript"],
  };

  const diagNoResume = computeFitDiagnostics(unconfirmedCandidate, sampleJob);
  const claimNoResume = getDiagnosticsSummary(diagNoResume);

  if (claimNoResume !== "") {
    failures.push(`FABRICATED CLAIM: getDiagnosticsSummary returned '${claimNoResume}' for unconfirmed resume`);
  } else {
    console.log("  [PASS] 3a. getDiagnosticsSummary returns empty string (renders nothing) for account with no confirmed resume");
  }

  if (claimNoResume.includes("confirmed experience") || claimNoResume.includes("4+ years")) {
    failures.push("FALSE CLAIM: Unconfirmed candidate received confirmed experience claim");
  } else {
    console.log("  [PASS] 3b. Zero 'confirmed experience' or '4+ years' claims for unconfirmed candidate");
  }

  if (claimNoResume.includes("Evaluated against")) {
    failures.push("GENERIC CLAIM: Found 'Evaluated against' fallback string");
  } else {
    console.log("  [PASS] 3c. Zero 'Evaluated against' generic placeholder returned");
  }

  // 3b. Real confirmed candidate with confirmed experience
  const realConfirmedCandidate: CandidateProfile = {
    name: "Jane Dev",
    email: "jane@example.com",
    skills: ["Python", "Machine Learning", "PyTorch"],
    experience: [
      {
        id: "exp-jane-1",
        company: "AI Labs",
        role: "ML Engineer",
        startDate: "2021",
        endDate: "Present",
      },
    ],
    confirmedAt: "2026-10-01T00:00:00Z",
  };

  const mlJob = {
    id: "job-ml",
    title: "Machine Learning Engineer",
    company: "Vision AI",
    skills: ["Python", "Machine Learning"],
  };

  const diagConfirmed = computeFitDiagnostics(realConfirmedCandidate, mlJob);
  const claimConfirmed = getDiagnosticsSummary(diagConfirmed);

  if (!claimConfirmed || !claimConfirmed.includes("Matches")) {
    failures.push(`CONFIRMED CLAIM FAIL: Real confirmed resume produced invalid claim: '${claimConfirmed}'`);
  } else {
    console.log(`  [PASS] 3d. Real confirmed resume produces honest factual claim: "${claimConfirmed}"`);
  }

  // ====================================================================================
  // TEST 4: Cleanup of DEFAULT_CANDIDATE_PROFILE
  // ====================================================================================
  console.log("\nTEST 4: Verifying removal of leftover DEFAULT_CANDIDATE_PROFILE constant...");
  const storagePath = path.resolve(process.cwd(), "src/lib/resume/storage.ts");
  const storageCode = fs.readFileSync(storagePath, "utf-8");

  const hasDefaultProfile = storageCode.includes("DEFAULT_CANDIDATE_PROFILE");
  if (hasDefaultProfile) {
    failures.push("LEFTOVER CONSTANT: DEFAULT_CANDIDATE_PROFILE is still exported in src/lib/resume/storage.ts");
  } else {
    console.log("  [PASS] 4a. DEFAULT_CANDIDATE_PROFILE successfully removed from src/lib/resume/storage.ts");
  }

  // ====================================================================================
  // TEST 5: Negative Control Mode Handling
  // ====================================================================================
  if (IS_NEGATIVE_CONTROL) {
    if (failures.length > 0) {
      console.error("\n❌ NEGATIVE CONTROL PROVED: Deliberate non-Pro bypass was caught and failed as expected!");
      failures.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.error("\n❌ NEGATIVE CONTROL FAILED: Deliberate non-Pro grant was NOT caught!");
      process.exit(2);
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ VALIDATION FAILED with ${failures.length} errors:`);
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }

  // ====================================================================================
  // TEST 6: Automated Negative Control Verification (Proves non-zero exit)
  // ====================================================================================
  console.log("\nTEST 5: Spawning negative control child process to verify non-zero exit...");
  const npxChild = spawnSync("npx", [
    "tsx",
    path.resolve(__dirname, "test-honesty-entitlement-gating.ts"),
    "--negative-control",
  ], {
    shell: true,
    stdio: "pipe",
  });

  const negStatus = npxChild.status;
  assert.strictEqual(
    negStatus,
    1,
    `Negative control MUST exit with status 1! Received status: ${negStatus}`
  );
  console.log(`  [PASS] 5a. Negative control exited with code ${negStatus} (non-zero exit verified on bypass)`);

  console.log("\n==================================================================================");
  console.log("HONESTY & PRO ENTITLEMENT GATING VALIDATION: PASS-LOCAL");
  console.log("==================================================================================");
  process.exit(0);
}

runSuite().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
