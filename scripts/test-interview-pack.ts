import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import {
  handleInterviewPackRequest,
  checkAndIncrementInterviewPackQuota,
  refundInterviewPackQuota,
} from "../src/lib/interview-pack/handler";
import {
  sanitizeCompanyClaims,
  getCompanyIntel,
  isPrivateOrInternalHost,
} from "../src/lib/interview-pack/companyIntel";
import {
  generateInterviewPack,
  extractResumeBullets,
} from "../src/lib/interview-pack/engine";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("       TEST: INTERVIEW PACK REAL ENGINE, STRICT GROUNDING & AUTHZ ENFORCEMENT     ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const pagePath = path.resolve(process.cwd(), "src/app/jobs/[id]/interview-pack/page.tsx");
  const clientPath = path.resolve(process.cwd(), "src/app/jobs/[id]/interview-pack/InterviewPackClient.tsx");
  const viewPath = path.resolve(process.cwd(), "src/components/interview-pack/InterviewPackView.tsx");
  const fearPath = path.resolve(process.cwd(), "src/components/interview-pack/FearQuestionScreen.tsx");
  const timeBoxPath = path.resolve(process.cwd(), "src/components/interview-pack/TimeBoxScreen.tsx");
  const deckPath = path.resolve(process.cwd(), "src/components/interview-pack/QuestionsCardDeck.tsx");
  const railPath = path.resolve(process.cwd(), "src/components/interview-pack/DossierRail.tsx");
  const lastNightPath = path.resolve(process.cwd(), "src/components/interview-pack/LastNightModeView.tsx");
  const thinBannerPath = path.resolve(process.cwd(), "src/components/interview-pack/ThinResearchBanner.tsx");
  const footerPath = path.resolve(process.cwd(), "src/components/interview-pack/DossierFooter.tsx");
  const routePath = path.resolve(process.cwd(), "src/app/api/jobs/interview-pack/route.ts");
  const handlerPath = path.resolve(process.cwd(), "src/lib/interview-pack/handler.ts");
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const fixturePath = path.resolve(process.cwd(), "src/data/interviewPackFixture.ts");
  const drawerPath = path.resolve(process.cwd(), "src/components/interview-pack/SourcesDrawer.tsx");
  const enginePath = path.resolve(process.cwd(), "src/lib/interview-pack/engine.ts");
  const intelPath = path.resolve(process.cwd(), "src/lib/interview-pack/companyIntel.ts");
  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261028_company_intel_cache.sql");

  const requiredFiles = [
    pagePath,
    clientPath,
    viewPath,
    fearPath,
    timeBoxPath,
    deckPath,
    railPath,
    lastNightPath,
    thinBannerPath,
    footerPath,
    routePath,
    handlerPath,
    detailPath,
    fixturePath,
    drawerPath,
    enginePath,
    intelPath,
    migrationPath,
  ];

  for (const f of requiredFiles) {
    if (!fs.existsSync(f)) {
      console.error(`FAIL: Required file missing: ${f}`);
      process.exit(1);
    }
  }

  // 1. Verify netlify/functions/interview-pack.ts does not exist
  const netlifyFnPath = path.resolve(process.cwd(), "netlify/functions/interview-pack.ts");
  if (fs.existsSync(netlifyFnPath)) {
    console.error("FAIL: netlify/functions/interview-pack.ts must be deleted.");
    process.exit(1);
  }

  let pageCode = fs.readFileSync(pagePath, "utf-8");
  let clientCode = fs.readFileSync(clientPath, "utf-8");
  let viewCode = fs.readFileSync(viewPath, "utf-8");
  let fearCode = fs.readFileSync(fearPath, "utf-8");
  let timeBoxCode = fs.readFileSync(timeBoxPath, "utf-8");
  let deckCode = fs.readFileSync(deckPath, "utf-8");
  let railCode = fs.readFileSync(railPath, "utf-8");
  let lastNightCode = fs.readFileSync(lastNightPath, "utf-8");
  let thinBannerCode = fs.readFileSync(thinBannerPath, "utf-8");
  let footerCode = fs.readFileSync(footerPath, "utf-8");
  let routeCode = fs.readFileSync(routePath, "utf-8");
  let handlerCode = fs.readFileSync(handlerPath, "utf-8");
  let detailCode = fs.readFileSync(detailPath, "utf-8");
  let fixtureCode = fs.readFileSync(fixturePath, "utf-8");
  let drawerCode = fs.readFileSync(drawerPath, "utf-8");
  let migrationCode = fs.readFileSync(migrationPath, "utf-8");

  if (isNegativeControl) {
    pageCode = pageCode.replace(/generateStaticParams/g, "corruptedParams");
    clientCode = clientCode.replace(/ProUpgradeScreen/g, "corruptedUpgrade");
    clientCode = clientCode.replace(/type InterviewPackData/g, "SAMPLE_INTERVIEW_PACK");
    fearCode = fearCode.replace(/afraid of\?/g, "Corrupted Question");
    fixtureCode = fixtureCode.replace(/Tell me about yourself/g, "");
    fixtureCode += "\nAcme Cloud";
    timeBoxCode = timeBoxCode.replace(/I have 10 min/g, "");
    deckCode = deckCode.replace(/whyTheyAsk/g, "corruptedWhy");
    deckCode = deckCode.replace(/resumeBulletSource/g, "corruptedBullet");
    deckCode = deckCode.replace(/Got it!/g, "corruptedGotIt");
    deckCode = deckCode.replace(/bg-\[#2563EB\]/g, "bg-emerald-600");
    deckCode = deckCode.replace(/aria-live="polite"/g, "");
    drawerCode = drawerCode.replace(/previouslyFocusedElementRef/g, "corruptedRef");
    railCode = railCode.replace(/Last-Night Mode/g, "corruptedNight");
    thinBannerCode = thinBannerCode.replace(/thin-research-banner/g, "corrupted-banner");
    viewCode = viewCode.replace(/Sample preview, not data for this job/g, "Live production data");
    footerCode = footerCode.replace(/Preparation aid based on public sources; no hiring outcome is guaranteed\./g, "Guaranteed job!");
    routeCode = routeCode.replace(/handleInterviewPackRequest/g, "corruptedHandler");
    handlerCode = handlerCode.replace(/getServerEntitlement/g, "corruptedEntitlement");
    detailCode = detailCode.replace(/interview-pack-entry-button/g, "corrupted-button");
    migrationCode = migrationCode.replace(/REVOKE ALL/g, "GRANT ALL");
  }

  const failures: string[] = [];

  // 1. Static Export & Route Gate
  const hasStaticParams =
    pageCode.includes("export function generateStaticParams()") &&
    pageCode.includes('{ id: "sample" }');
  if (!hasStaticParams) {
    failures.push("STATIC EXPORT FAIL: /jobs/[id]/interview-pack/page.tsx must export generateStaticParams().");
  } else {
    console.log("  [PASS] Static Export: generateStaticParams() defined with pre-rendered IDs");
  }

  // 2. Migration Checks: RLS, Drop public policy, Revoke anon/auth, check constraint
  const hasMigrationLocks =
    migrationCode.includes("ALTER TABLE public.company_intel_cache ENABLE ROW LEVEL SECURITY;") &&
    migrationCode.includes('DROP POLICY IF EXISTS "company_intel_cache_service_all"') &&
    migrationCode.includes("REVOKE ALL ON public.company_intel_cache FROM anon, authenticated;") &&
    migrationCode.includes("CHECK (expires_at > fetched_at)") &&
    !migrationCode.includes("USING (true)") &&
    !migrationCode.includes("GRANT ALL");
  if (!hasMigrationLocks) {
    failures.push("MIGRATION LOCKS FAIL: company_intel_cache migration must enable RLS, revoke anon/authenticated, add check constraint, and have zero public policies.");
  } else {
    console.log("  [PASS] Migration SQL: Strictly locked with RLS, REVOKE anon/auth, expires_at check constraint, zero public policies");
  }

  // 3. Route File: GET only, no unused POST
  const routeHasOnlyGet =
    routeCode.includes("export async function GET") &&
    !routeCode.includes("export async function POST");
  if (!routeHasOnlyGet) {
    failures.push("ROUTE EXPORT FAIL: /api/jobs/interview-pack/route.ts must only export GET (no POST).");
  } else {
    console.log("  [PASS] Clean Route: Only GET exported, unused POST removed");
  }

  // 4. Server-Side Pro Enforcement on /api/jobs/interview-pack
  const serverCode = routeCode + "\n" + handlerCode;
  const hasServerProEnforcement =
    serverCode.includes("getServerEntitlement") &&
    serverCode.includes("auth.getUser") &&
    serverCode.includes("status: 403") &&
    serverCode.includes("status: 401") &&
    !serverCode.includes("user_metadata?.is_pro") &&
    !serverCode.includes("user_metadata?.pro_granted") &&
    !serverCode.includes("invalid-non-pro-token") &&
    clientCode.includes("ProUpgradeScreen") &&
    clientCode.includes("getProAccessStatus") &&
    !clientCode.includes("user_metadata?.pro_granted");
  if (!hasServerProEnforcement) {
    failures.push("SERVER PRO ENFORCEMENT FAIL: /api/jobs/interview-pack must validate token and use getServerEntitlement with no shortcuts.");
  } else {
    console.log("  [PASS] Server Pro Enforcement: Token validation via Supabase and getServerEntitlement (401/403)");
  }

  // 5. Client bundle lacks SAMPLE_INTERVIEW_PACK and Acme Cloud
  const clientImportsSamplePack =
    clientCode.includes("import { SAMPLE_INTERVIEW_PACK") ||
    clientCode.includes("import SAMPLE_INTERVIEW_PACK");
  const fixtureHasAcme = fixtureCode.includes("Acme Cloud") || fixtureCode.includes("Acme");
  const fixtureHasStripe = fixtureCode.includes('company: "Stripe"');
  const fixtureHasConfirmed =
    fixtureCode.includes('verificationType: "Confirmed"') ||
    fixtureCode.includes('label: "Confirmed"');

  if (clientImportsSamplePack) {
    failures.push("CLIENT ISOLATION FAIL: InterviewPackClient must not import SAMPLE_INTERVIEW_PACK runtime value.");
  } else if (fixtureHasAcme) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture data must not contain 'Acme Cloud' or 'Acme'.");
  } else if (fixtureHasStripe) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture data must not claim 'Stripe' as candidate employer.");
  } else if (fixtureHasConfirmed) {
    failures.push("FIXTURE CLEANSE FAIL: Fixture must drop fake 'Confirmed' verification chips.");
  } else {
    console.log("  [PASS] Client Isolation: No client imports of SAMPLE_INTERVIEW_PACK, no Acme/Stripe, no fake Confirmed chips");
  }

  // Database Mock Factory for Testing
  const quotaMap = new Map<string, number>();

  const createMockAdmin = (userId: string | null = null, authError: any = null, dbError: any = null) => {
    return {
      auth: {
        getUser: async () => ({
          data: { user: userId ? { id: userId, user_metadata: {} } : null },
          error: authError,
        }),
      },
      from: (table: string) => {
        let selectedId = "";
        let selectedUserId = "";
        const queryBuilder: any = {
          select: () => queryBuilder,
          eq: (col: string, val: any) => {
            if (col === "id") selectedId = val;
            if (col === "user_id") selectedUserId = val;
            return queryBuilder;
          },
          maybeSingle: async () => {
            if (dbError) return { data: null, error: dbError };
            if (table === "banned_users") {
              return { data: null, error: null };
            }
            if (table === "ai_usage_quotas") {
              const count = selectedUserId ? quotaMap.get(selectedUserId) || 0 : 0;
              return { data: { count }, error: null };
            }
            if (table === "jobs") {
              if (selectedId === "00000000-0000-0000-0000-000000000001") {
                return {
                  data: {
                    id: selectedId,
                    title: "Staff Infrastructure Engineer",
                    company: "RealTech",
                    description: "Hands-on experience with Kubernetes, Go microservices, and PostgreSQL query tuning.",
                    skills: ["Kubernetes", "Go", "PostgreSQL"],
                    apply_url: "https://realtech.example/jobs/infra",
                  },
                  error: null,
                };
              }
              return { data: null, error: null };
            }
            if (table === "candidate_profiles") {
              return {
                data: {
                  name: "Alex Candidate",
                  headline: "Infrastructure Specialist",
                  experience_json: [
                    {
                      role: "DevOps Engineer",
                      company: "CloudStudio",
                      bullets: ["Managed Kubernetes clusters and containerized Go microservices."],
                    },
                  ],
                },
                error: null,
              };
            }
            if (table === "company_intel_cache") {
              return { data: null, error: null };
            }
            return { data: null, error: null };
          },
          single: async () => queryBuilder.maybeSingle(),
          upsert: (payload: any) => ({
            select: () => ({
              single: async () => {
                if (dbError) return { data: null, error: dbError };
                const current = quotaMap.get(payload.user_id) || 0;
                const updated = payload.count ?? current + 1;
                quotaMap.set(payload.user_id, updated);
                return { data: { count: updated }, error: null };
              },
            }),
          }),
          update: (payload: any) => ({
            eq: (_col1: string, val1: any) => ({
              eq: () => ({
                eq: async () => {
                  if (dbError) return { error: dbError };
                  if (typeof payload.count === "number") {
                    quotaMap.set(val1, payload.count);
                  }
                  return { error: null };
                },
              }),
            }),
          }),
        };
        return queryBuilder;
      },
    };
  };

  const mockAiCall = async (payload: { systemPrompt: string; userPrompt: string }) => {
    // Model returns valid structured JSON matching real JD and candidate lines
    return {
      questions: [
        {
          id: "card-1",
          question: "How have you managed Kubernetes clusters and Go microservices in production?",
          category: "technical",
          whyTheyAsk: "Verifies execution depth under production constraints.",
          citedBulletText: "Managed Kubernetes clusters and containerized Go microservices.",
          citedRole: "DevOps Engineer",
          citedCompany: "CloudStudio",
          answerDraft: "At CloudStudio, I managed Kubernetes clusters and containerized Go microservices.",
          expandedAnswer: "Situation: Scaling infrastructure at CloudStudio.\nTask: Manage Kubernetes clusters.\nAction: Deployed containerized Go microservices.\nResult: Stabilized deployments without regression.",
          isMustKnow: true,
        },
        {
          id: "card-2",
          question: "How do you approach PostgreSQL query tuning under heavy write traffic?",
          category: "technical",
          whyTheyAsk: "Assesses database indexing and latency optimization.",
          citedBulletText: "", // NOT in candidate resume!
          citedRole: "",
          citedCompany: "",
          answerDraft: "",
          expandedAnswer: "",
          isMustKnow: false,
        },
      ],
      gaps: [
        {
          id: "gap-1",
          jdRequirement: "PostgreSQL query tuning under heavy write traffic",
          bridgeStrategy: "Acknowledge direct tuning experience gap and emphasize strong database design fundamentals.",
        },
      ],
      fearQuestions: [
        {
          id: "fear-opt-about",
          chip: "Tell me about yourself",
          question: "Walk me through your background and how it matches this role.",
          whyTheyAsk: "Tests executive presence and alignment.",
          answerDraft: "I am an infrastructure engineer with deep Kubernetes experience.",
          expandedAnswer: "STAR framework grounded in real career steps.",
          citedBulletText: "Managed Kubernetes clusters and containerized Go microservices.",
          citedRole: "DevOps Engineer",
          citedCompany: "CloudStudio",
        },
        {
          id: "fear-opt-salary",
          chip: "Salary",
          question: "What are your salary expectations?",
          whyTheyAsk: "Ensures compensation alignment.",
          answerDraft: "Targeting market competitive rates.",
          expandedAnswer: "Structured range discussion.",
          citedBulletText: "",
          citedRole: "",
          citedCompany: "",
        },
        {
          id: "fear-opt-leave",
          chip: "Why leave",
          question: "Why are you considering leaving your current role?",
          whyTheyAsk: "Tests forward focus and professionalism.",
          answerDraft: "Seeking greater technical scale and ownership.",
          expandedAnswer: "Forward-looking rationale.",
          citedBulletText: "",
          citedRole: "",
          citedCompany: "",
        },
        {
          id: "fear-opt-tech",
          chip: "Technical",
          question: "Describe your most complex cluster incident.",
          whyTheyAsk: "Assesses debugging under pressure.",
          answerDraft: "Triage and root cause analysis in Kubernetes.",
          expandedAnswer: "Systematic diagnostic loop.",
          citedBulletText: "Managed Kubernetes clusters and containerized Go microservices.",
          citedRole: "DevOps Engineer",
          citedCompany: "CloudStudio",
        },
      ],
      reverseQuestions: [
        {
          id: "ask-1",
          question: "How does the team prioritize architectural refactoring vs feature delivery?",
          category: "Engineering culture",
          whyAskThis: "Surfaces engineering balance.",
          whatToListenFor: "Pragmatic scheduling of tech debt.",
        },
      ],
      quiz: [
        {
          id: "quiz-1",
          question: "What core stack is emphasized in this Staff Infrastructure position?",
          options: [
            "Kubernetes, Go, and PostgreSQL",
            "PHP and WordPress",
            "Ruby on Rails and MongoDB",
            "Pure frontend client-side React only",
          ],
          correctIndex: 0,
          explanation: "The job description emphasizes Kubernetes, Go microservices, and PostgreSQL.",
        },
      ],
    };
  };

  // 6. Test: Garbage token 401 & Non-Pro 403
  try {
    quotaMap.clear();

    // 6a. Missing token -> 401
    const reqMissing = new Request("http://localhost:3000/api/jobs/interview-pack");
    const resMissing = await handleInterviewPackRequest(reqMissing, {
      getSupabaseAdmin: () => createMockAdmin(null, new Error("Missing")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resMissing.status, 401, "Missing token must yield status 401");

    // 6b. Invalid / Garbage token -> 401
    const reqGarbage = new Request("http://localhost:3000/api/jobs/interview-pack", {
      headers: { Authorization: "Bearer garbage_token" },
    });
    const resGarbage = await handleInterviewPackRequest(reqGarbage, {
      getSupabaseAdmin: () => createMockAdmin(null, new Error("Invalid session")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resGarbage.status, 401, "Invalid token must yield status 401");

    // 6c. Non-Pro user -> 403
    const reqNonPro = new Request("http://localhost:3000/api/jobs/interview-pack", {
      headers: { Authorization: "Bearer valid_non_pro_token" },
    });
    const resNonPro = await handleInterviewPackRequest(reqNonPro, {
      getSupabaseAdmin: () => createMockAdmin("usr_non_pro"),
      getServerEntitlement: async () => ({ isPro: isNegativeControl ? true : false }),
    });
    assert.strictEqual(resNonPro.status, 403, "Non-Pro token must yield status 403");
    const bodyNonPro = await resNonPro.json();
    assert.strictEqual(bodyNonPro.code, "PRO_REQUIRED");

    console.log("  [PASS] Auth Enforcement: Missing token 401, garbage token 401, non-Pro 403");
  } catch (err: any) {
    failures.push(`AUTH ENFORCEMENT FAIL: ${err.message}`);
  }

  // 7. Test: Job Not Found or Non-UUID -> 404 JSON (Never substitute fictional job)
  try {
    // 7a. Non-UUID jobId -> 404
    const reqInvalidUuid = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=not-a-uuid-string", {
      headers: { Authorization: "Bearer pro_token" },
    });
    const resInvalidUuid = await handleInterviewPackRequest(reqInvalidUuid, {
      getSupabaseAdmin: () => createMockAdmin("usr_pro"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(resInvalidUuid.status, 404, "Invalid UUID must yield status 404");
    const bodyInvalidUuid = await resInvalidUuid.json();
    assert.strictEqual(bodyInvalidUuid.code, "JOB_NOT_FOUND");

    // 7b. Valid UUID but job not in database -> 404
    const reqMissingJob = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=99999999-9999-9999-9999-999999999999", {
      headers: { Authorization: "Bearer pro_token" },
    });
    const resMissingJob = await handleInterviewPackRequest(reqMissingJob, {
      getSupabaseAdmin: () => createMockAdmin("usr_pro"),
      getServerEntitlement: async () => ({ isPro: true }),
      fetchJob: async () => null,
    });
    if (isNegativeControl) {
      assert.strictEqual(resMissingJob.status, 200, "Negative control check");
    } else {
      assert.strictEqual(resMissingJob.status, 404, "Missing job in database must yield status 404 (no fake partner job)");
      const bodyMissingJob = await resMissingJob.json();
      assert.strictEqual(bodyMissingJob.code, "JOB_NOT_FOUND");
    }

    console.log("  [PASS] Job Resolution: Invalid UUID -> 404, missing job -> 404, zero fictional job substitution");
  } catch (err: any) {
    failures.push(`JOB 404 FAIL: ${err.message}`);
  }

  // 8. Test: Quota 429 & Fail Closed 503 (No in-memory fallback)
  try {
    quotaMap.clear();

    // 8a. First 10 requests succeed
    for (let i = 1; i <= 10; i++) {
      const req = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=00000000-0000-0000-0000-000000000001", {
        headers: { Authorization: "Bearer pro_token_quota" },
      });
      const res = await handleInterviewPackRequest(req, {
        getSupabaseAdmin: () => createMockAdmin("usr_quota_test"),
        getServerEntitlement: async () => ({ isPro: true }),
        callAi: mockAiCall,
      });
      assert.strictEqual(res.status, 200, `Request ${i} of 10 must succeed`);
    }

    // 8b. 11th request must fail with 429
    const req11 = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=00000000-0000-0000-0000-000000000001", {
      headers: { Authorization: "Bearer pro_token_quota" },
    });
    const res11 = await handleInterviewPackRequest(req11, {
      getSupabaseAdmin: () => createMockAdmin("usr_quota_test"),
      getServerEntitlement: async () => ({ isPro: true }),
      callAi: mockAiCall,
    });
    assert.strictEqual(res11.status, 429, "11th request must return 429");
    const body11 = await res11.json();
    assert.strictEqual(body11.code, "RATE_LIMIT_EXCEEDED");

    // 8c. Direct DB error in checkAndIncrementInterviewPackQuota must fail closed (no in-memory fallback)
    const directQuotaCheck = await checkAndIncrementInterviewPackQuota(
      createMockAdmin("usr_direct_err", null, new Error("Quota DB select timeout")),
      "usr_direct_err"
    );
    assert.strictEqual(directQuotaCheck.isServiceUnavailable, true, "Quota must flag service unavailable on DB error");
    assert.strictEqual(directQuotaCheck.allowed, false, "Quota must fail closed on DB error");

    // 8d. Handler returns 503 when quota service is unavailable
    const reqDbErr = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=00000000-0000-0000-0000-000000000001", {
      headers: { Authorization: "Bearer pro_token_quota_err" },
    });
    const resDbErr = await handleInterviewPackRequest(reqDbErr, {
      getSupabaseAdmin: () => createMockAdmin("usr_db_err"),
      getServerEntitlement: async () => ({ isPro: true }),
      checkQuota: async () => ({ allowed: false, isServiceUnavailable: true, currentCount: 0, limit: 10 }),
      callAi: mockAiCall,
    });
    assert.strictEqual(resDbErr.status, 503, "Database error must fail closed with 503 (no in-memory fallback)");
    const bodyDbErr = await resDbErr.json();
    assert.strictEqual(bodyDbErr.code, "AI_QUOTA_SERVICE_UNAVAILABLE");

    console.log("  [PASS] Quota Enforcement: 10 packs/day limit -> 429, DB error -> 503 fail-closed (no in-memory bypass)");
  } catch (err: any) {
    failures.push(`QUOTA 429/503 FAIL: ${err.message}`);
  }

  // 9. Test: Provider failure -> Error JSON & Quota refunded (never template filler)
  try {
    quotaMap.clear();

    const reqFail = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=00000000-0000-0000-0000-000000000001", {
      headers: { Authorization: "Bearer pro_token_fail" },
    });

    const resFail = await handleInterviewPackRequest(reqFail, {
      getSupabaseAdmin: () => createMockAdmin("usr_fail_test"),
      getServerEntitlement: async () => ({ isPro: true }),
      callAi: async () => {
        throw new Error("Upstream AI provider timed out.");
      },
    });

    if (isNegativeControl) {
      assert.strictEqual(resFail.status, 200, "Negative control check");
    } else {
      assert.strictEqual(resFail.status, 504, "Provider timeout must yield status 504 clean error JSON");
      const bodyFail = await resFail.json();
      assert.strictEqual(bodyFail.code, "GENERATION_TIMEOUT");
      assert.strictEqual(bodyFail.pack, undefined, "Must NEVER return template filler pack on provider failure");
      // Check quota refunded
      assert.strictEqual(quotaMap.get("usr_fail_test") || 0, 0, "Failed request must be refunded in quota");
    }

    console.log("  [PASS] Provider Error: Clean 504 error JSON returned, zero template filler, quota refunded");
  } catch (err: any) {
    failures.push(`PROVIDER FAILURE ERROR JSON FAIL: ${err.message}`);
  }

  // 10. Test: Answer without resume citation -> Gap item (strict resume grounding)
  try {
    const testJob = {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Staff Infrastructure Engineer",
      company: "RealTech",
      description: "Requires deep expertise in Kubernetes and PostgreSQL query tuning.",
      skills: ["Kubernetes", "PostgreSQL"],
    };

    const testCandidate = {
      headline: "DevOps Engineer",
      experience: [
        {
          role: "DevOps Engineer",
          company: "CloudStudio",
          bullets: ["Managed Kubernetes clusters and containerized Go microservices."],
        },
      ],
    };

    const intel = {
      normalizedCompany: "realtech",
      companyName: "RealTech",
      claims: [],
      fetchedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      isThin: true,
    };

    const pack = await generateInterviewPack(testJob, testCandidate, intel, {
      callAi: mockAiCall,
    });

    // Check that Kubernetes (in resume) became an answered card
    const k8sCard = pack.cards.find((c) => /kubernetes/i.test(c.question));
    assert.ok(k8sCard, "Kubernetes requirement must be an answered card");
    assert.strictEqual(k8sCard.label, "From your resume");
    assert.strictEqual(k8sCard.resumeBulletSource.company, "CloudStudio");

    // Check that PostgreSQL (NOT in resume) became a gap item
    const postgresGap = pack.gaps.find((g) => /postgresql/i.test(g.jdRequirement));
    const postgresCard = pack.cards.find((c) => /postgresql/i.test(c.question));

    if (isNegativeControl) {
      assert.ok(!postgresGap, "Simulated negative control: gap missing");
    } else {
      assert.ok(postgresGap, "PostgreSQL requirement missing from resume must become a gap item");
      assert.strictEqual(postgresGap.resumeStatus, "gap");
      assert.strictEqual(postgresCard, undefined, "PostgreSQL without resume citation must NOT be an answered card");
    }

    console.log("  [PASS] Resume Grounding: Grounded question -> answered card, ungrounded question -> gap item");
  } catch (err: any) {
    failures.push(`RESUME GROUNDING GAP FAIL: ${err.message}`);
  }

  // 11. Test: Invented text mutation must fail (no hardcoded stages, no invented Result metrics)
  try {
    const testJob = {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Staff Infrastructure Engineer",
      company: "RealTech",
      description: "Job description without interview process stages or company mission.",
    };
    const testCandidate = {
      headline: "Engineer",
      experience: [{ role: "Eng", company: "Co", bullets: ["Built scalable Go services."] }],
    };
    const intel = {
      normalizedCompany: "realtech",
      companyName: "RealTech",
      claims: [],
      fetchedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      isThin: true,
    };

    const pack = await generateInterviewPack(testJob, testCandidate, intel, {
      callAi: mockAiCall,
    });

    if (isNegativeControl) {
      // Intentionally introduce an invented statement in negative control
      pack.process.stages.push({
        step: 1,
        name: "Invented Recruiter Screen",
        duration: "30 min",
        format: "Phone",
        focus: "General",
        proTip: "Invented tip",
      });
    }

    assert.strictEqual(pack.process.stages.length, 0, "Must have zero hardcoded interview stages");
    assert.strictEqual(pack.process.overview, "", "Must have zero hardcoded process overview");
    assert.strictEqual(pack.brief.mission, "", "Must have zero invented company mission");
    assert.strictEqual(pack.brief.marketContext, "", "Must have zero invented market context");

    console.log("  [PASS] Zero Invented Text: No hardcoded interview stages, formats, or company mission statements");
  } catch (err: any) {
    failures.push(`INVENTED TEXT FAIL: ${err.message}`);
  }

  // 12. Test: Private-IP claim URL dropped & https only
  try {
    const rawClaims = [
      { text: "Valid claim", sourceUrl: "https://public-news.example.com/item/1" },
      { text: "Insecure claim", sourceUrl: "http://public-news.example.com/item/2" },
      { text: "Localhost claim", sourceUrl: "https://localhost:8080/secret" },
      { text: "Loopback claim", sourceUrl: "https://127.0.0.1/admin" },
      { text: "Private IP 10.x", sourceUrl: "https://10.0.1.5/confidential" },
      { text: "Private IP 192.168.x", sourceUrl: "https://192.168.1.1/router" },
      { text: "Private IP 172.16.x", sourceUrl: "https://172.20.0.1/internal" },
      { text: "Internal host", sourceUrl: "https://intranet.internal/doc" },
      { text: "Local host", sourceUrl: "https://corp.local/vpn" },
      { text: "Single word host", sourceUrl: "https://intranet/wiki" },
    ];

    let sanitized = sanitizeCompanyClaims(rawClaims);

    if (isNegativeControl) {
      sanitized.push({ text: "Private IP leaked", sourceUrl: "https://192.168.1.1/leak", fetchedAt: "now" });
    }

    assert.strictEqual(sanitized.length, 1, "Must drop all non-https, private IPs, localhost, and internal hosts");
    assert.strictEqual(sanitized[0].sourceUrl, "https://public-news.example.com/item/1");
    console.log("  [PASS] Security Sanitize: http rejected, private IPs and internal hosts strictly dropped");
  } catch (err: any) {
    failures.push(`SECURITY SANITIZE FAIL: ${err.message}`);
  }

  // 13. Test: No careermonke.com anywhere in generated output
  try {
    const testJob = {
      id: "00000000-0000-0000-0000-000000000001",
      title: "Staff Infrastructure Engineer",
      company: "RealTech",
      description: "Real job description.",
      apply_url: "https://external-jobs.example.com/postings/123",
    };
    const testCandidate = {
      headline: "DevOps",
      experience: [{ role: "Role", company: "Co", bullets: ["Built Go microservices."] }],
    };
    const intel = {
      normalizedCompany: "realtech",
      companyName: "RealTech",
      claims: [],
      fetchedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      isThin: true,
    };

    const pack = await generateInterviewPack(testJob, testCandidate, intel, {
      callAi: mockAiCall,
    });

    let packJson = JSON.stringify(pack);

    if (isNegativeControl) {
      packJson += " https://careermonke.com/jobs/corrupted ";
    }

    assert.strictEqual(packJson.includes("careermonke.com"), false, "Must contain ZERO 'careermonke.com' URLs or references");
    console.log("  [PASS] Domain Integrity: Zero 'careermonke.com' strings in generated output");
  } catch (err: any) {
    failures.push(`DOMAIN INTEGRITY FAIL: ${err.message}`);
  }

  // 14. Test: Chips rendering - All four label types reuse existing chip styling without visual redesign
  try {
    const hasChipMapping =
      deckCode.includes('case "From job description":') &&
      deckCode.includes('case "From your resume":') &&
      deckCode.includes('case "AI suggestion":') &&
      deckCode.includes('case "From company source":');
    if (!hasChipMapping) {
      failures.push("CHIP STYLING FAIL: QuestionsCardDeck must map all four label types to existing chip classes.");
    } else {
      console.log("  [PASS] Chip Styling: All four label types mapped cleanly to existing design system badge styles");
    }
  } catch (err: any) {
    failures.push(`CHIP STYLING FAIL: ${err.message}`);
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
  console.log("INTERVIEW PACK REAL ENGINE AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
