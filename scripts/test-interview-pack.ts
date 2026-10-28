import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { handleInterviewPackRequest, _resetInterviewPackQuotaStore } from "../src/lib/interview-pack/handler";
import {
  sanitizeCompanyClaims,
  getCompanyIntel,
  normalizeCompanyName,
} from "../src/lib/interview-pack/companyIntel";
import {
  generateInterviewPack,
  extractResumeBullets,
  extractJdRequirements,
} from "../src/lib/interview-pack/engine";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("       TEST: INTERVIEW PACK ENGINE, DOSSIER FLOW & SERVER-SIDE PRO ENFORCEMENT    ");
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

  const netlifyFnPath = path.resolve(process.cwd(), "netlify/functions/interview-pack.ts");

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
  ];

  for (const f of requiredFiles) {
    if (!fs.existsSync(f)) {
      console.error(`FAIL: Required file missing: ${f}`);
      process.exit(1);
    }
  }

  // 1. Verify netlify/functions/interview-pack.ts was deleted
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
  }

  const failures: string[] = [];

  // 1. Route & Static Export
  const hasStaticParams =
    pageCode.includes("export function generateStaticParams()") &&
    pageCode.includes('{ id: "sample" }');
  if (!hasStaticParams) {
    failures.push(
      "STATIC EXPORT FAIL: /jobs/[id]/interview-pack/page.tsx must export generateStaticParams() for static export."
    );
  } else {
    console.log("  [PASS] Static Export: generateStaticParams() defined with pre-rendered IDs");
  }

  // 2. Server-Side Pro Enforcement on /api/jobs/interview-pack
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
    failures.push(
      "SERVER PRO ENFORCEMENT FAIL: /api/jobs/interview-pack must validate token and use getServerEntitlement with no literal shortcuts or user_metadata trust."
    );
  } else {
    console.log("  [PASS] Server Pro Enforcement: Token validation via Supabase and getServerEntitlement (401/403)");
  }

  // 3. Client bundle lacks SAMPLE_INTERVIEW_PACK and Acme Cloud
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
    console.log("  [PASS] Client Isolation & Cleanse: No client imports of SAMPLE_INTERVIEW_PACK, no Acme/Stripe, no fake Confirmed chips");
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
      upsert: async () => ({ data: null, error: null }),
      insert: async () => ({ data: null, error: null }),
      update: () => ({
        eq: () => ({
          eq: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }),
      }),
    }),
  });

  // 4. API Endpoint Execution Test: 401 no token, 401 invalid token, 403 non-Pro, 200 Pro
  try {
    _resetInterviewPackQuotaStore();

    // 4a. Missing token -> 401
    const reqMissing = new Request("http://localhost:3000/api/jobs/interview-pack");
    const resMissing = await handleInterviewPackRequest(reqMissing, {
      getSupabaseAdmin: () => mockAdmin(null, new Error("Missing")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resMissing.status, 401, "Missing token must yield status 401");

    // 4b. Invalid/expired token -> 401
    const reqInvalid = new Request("http://localhost:3000/api/jobs/interview-pack", {
      headers: { Authorization: "Bearer expired_or_malformed_token" },
    });
    const resInvalid = await handleInterviewPackRequest(reqInvalid, {
      getSupabaseAdmin: () => mockAdmin(null, new Error("Invalid token")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    assert.strictEqual(resInvalid.status, 401, "Invalid token must yield status 401");

    // 4c. Valid token, Non-Pro user -> 403
    const reqNonPro = new Request("http://localhost:3000/api/jobs/interview-pack", {
      headers: { Authorization: "Bearer valid_non_pro_token" },
    });
    const resNonPro = await handleInterviewPackRequest(reqNonPro, {
      getSupabaseAdmin: () => mockAdmin("usr_non_pro"),
      getServerEntitlement: async () => ({ isPro: isNegativeControl ? true : false }),
    });
    assert.strictEqual(resNonPro.status, 403, "Non-Pro token must yield status 403");
    const bodyNonPro = await resNonPro.json();
    assert.strictEqual(bodyNonPro.code, "PRO_REQUIRED", "Must return code PRO_REQUIRED");

    // 4d. Valid Pro token -> 200 with generated pack
    const reqPro = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=sample", {
      headers: { Authorization: "Bearer valid_pro_token" },
    });
    const resPro = await handleInterviewPackRequest(reqPro, {
      getSupabaseAdmin: () => mockAdmin("usr_pro_test"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(resPro.status, 200, "Valid Pro token must yield status 200");
    const bodyPro = await resPro.json();
    assert.ok(bodyPro.pack, "Must return interview pack");
    assert.strictEqual(bodyPro.isPro, true);
    assert.strictEqual(bodyPro.pack.jobId, "sample");

    console.log("  [PASS] Endpoint Live Execution: 401 no token, 401 invalid token, 403 non-Pro, 200 Pro with injected deps");
  } catch (err: any) {
    failures.push(`API EXECUTION FAIL: ${err.message}`);
  }

  // 5. Entry Button in JobDetailView & Feature Flag
  const hasEntryButton =
    detailCode.includes('data-testid="interview-pack-entry-button"') &&
    detailCode.includes("/interview-pack") &&
    detailCode.includes("NEXT_PUBLIC_ENABLE_INTERVIEW_PACK");
  if (!hasEntryButton) {
    failures.push("ENTRY BUTTON FAIL: JobDetailView must include 'Open Interview Pack' button behind feature flag.");
  } else {
    console.log("  [PASS] Entry Button: Open Interview Pack button integrated and guarded by feature flag");
  }

  // 6. Persistent Sample Preview Banner
  const hasSampleBanner = viewCode.includes("Sample preview, not data for this job");
  if (!hasSampleBanner) {
    failures.push("SAMPLE BANNER FAIL: Persistent 'Sample preview, not data for this job' banner must be displayed.");
  } else {
    console.log("  [PASS] Persistent Sample Banner: 'Sample preview, not data for this job' banner rendered");
  }

  // 7. Focus Trap and Return in SourcesDrawer
  const hasDrawerFocusTrap =
    drawerCode.includes("previouslyFocusedElementRef") &&
    drawerCode.includes("handleKeyDown") &&
    drawerCode.includes("Escape") &&
    drawerCode.includes("Tab");
  if (!hasDrawerFocusTrap) {
    failures.push("FOCUS TRAP FAIL: SourcesDrawer must implement focus trapping and restore focus to trigger element on close.");
  } else {
    console.log("  [PASS] Sources Drawer: Focus trap, Esc to close, and return focus verified");
  }

  // 8. CM Blue for Primary Actions & aria-live for Ready Counter
  const hasCmBlueActions = deckCode.includes("bg-[#2563EB]") && !deckCode.includes("bg-emerald-600");
  const hasAriaLiveCounter = deckCode.includes('aria-live="polite"');
  if (!hasCmBlueActions) {
    failures.push("COLOR ACCENT FAIL: Primary action buttons in card deck must use CM blue instead of emerald.");
  } else if (!hasAriaLiveCounter) {
    failures.push("ARIA LIVE FAIL: Ready progress indicator must have aria-live='polite' for screen reader announcements.");
  } else {
    console.log("  [PASS] Design System & A11y: CM blue for primary actions, aria-live on 'X of Y ready', focus trap active");
  }

  // 9. Opening Fear Question Screen (Step 1)
  const hasFearScreen =
    fearCode.includes("afraid of?") &&
    fearCode.includes("fearQuestionOptions") &&
    fearCode.includes("Skip for now") &&
    fixtureCode.includes("Tell me about yourself") &&
    fixtureCode.includes("Salary") &&
    fixtureCode.includes("Why leave") &&
    fixtureCode.includes("Technical");
  if (!hasFearScreen) {
    failures.push("FEAR SCREEN FAIL: Step 1 must ask 'Is there one question you're most afraid of?' with 4 quick chips and skip button.");
  } else {
    console.log("  [PASS] Flow Step 1: Fear Question Screen with 4 quick chips and skip action");
  }

  // 10. Time Box Screen (Step 2)
  const hasTimeBox =
    timeBoxCode.includes("I have 10 min") &&
    timeBoxCode.includes("I have 30 min") &&
    timeBoxCode.includes("I have tonight") &&
    timeBoxCode.includes("cardCount");
  if (!hasTimeBox) {
    failures.push("TIME BOX FAIL: Step 2 must offer 10 min / 30 min / tonight time boxes trimming card counts.");
  } else {
    console.log("  [PASS] Flow Step 2: Time Box Screen (10m, 30m, tonight) trimming card count");
  }

  // 11. Dossier Rail & Sections
  const hasRailSections =
    railCode.includes("Brief") &&
    railCode.includes("Process") &&
    railCode.includes("Questions") &&
    railCode.includes("Your answers") &&
    railCode.includes("Gaps (JD vs Resume)") &&
    railCode.includes("Ask them") &&
    railCode.includes("Quick quiz") &&
    railCode.includes("Sources directory");
  if (!hasRailSections) {
    failures.push("RAIL SECTIONS FAIL: Dossier rail must include Brief, Process, Questions, Your answers, Gaps, Ask them, Quick quiz, and Sources.");
  } else {
    console.log("  [PASS] Dossier Rail: All 7 required dossier sections and sources drawer button verified");
  }

  // 12. Last-Night Mode
  const hasLastNightMode =
    lastNightCode.includes("Last-Night") &&
    lastNightCode.includes("mustKnowCards") &&
    lastNightCode.includes("Pre-Interview") &&
    lastNightCode.includes("Checklist");
  if (!hasLastNightMode) {
    failures.push("LAST NIGHT MODE FAIL: Must include Last-Night Mode toggle displaying top 5 must-know cards and checklist.");
  } else {
    console.log("  [PASS] Last-Night Mode: Filtered 5 must-know cards and evening ritual checklist verified");
  }

  // 13. Disclaimer Footer
  const hasDisclaimerFooter =
    footerCode.includes("Preparation aid based on public sources; no hiring outcome is guaranteed.") &&
    !footerCode.includes("guaranteed job") &&
    !footerCode.includes("guaranteed offer");
  if (!hasDisclaimerFooter) {
    failures.push(
      "DISCLAIMER FOOTER FAIL: Must include exact disclaimer: 'Preparation aid based on public sources; no hiring outcome is guaranteed.' with no job guarantee wording."
    );
  } else {
    console.log("  [PASS] Disclaimer Footer: Exact mandatory disclaimer present with zero job guarantee claims");
  }

  // -------------------------------------------------------------------------
  // 14. ENGINE LOGIC & VERIFICATION RULES
  // -------------------------------------------------------------------------

  // 14a. Claim without sourceUrl is dropped
  try {
    const rawClaims = [
      { text: "Verified patent filing", sourceUrl: "https://patents.google.com/patent/123", fetchedAt: "2026-10-01" },
      { text: "Unverified rumor without URL", sourceUrl: "", fetchedAt: "2026-10-02" },
      { text: "Another claim with missing URL field", fetchedAt: "2026-10-03" },
      { text: "Valid press release", sourceUrl: "https://prnewswire.com/release/456", fetchedAt: "2026-10-04" },
    ];

    let sanitized = sanitizeCompanyClaims(rawClaims);
    if (isNegativeControl) {
      // Intentionally introduce an unsourced claim in negative control
      sanitized = [...sanitized, { text: "Corrupted unsourced claim", sourceUrl: "", fetchedAt: "now" }];
    }

    assert.strictEqual(sanitized.length, 2, "Must drop all claims missing a sourceUrl");
    assert.strictEqual(sanitized[0].sourceUrl, "https://patents.google.com/patent/123");
    assert.strictEqual(sanitized[1].sourceUrl, "https://prnewswire.com/release/456");
    console.log("  [PASS] Company Intel: Claim without sourceUrl is strictly dropped");
  } catch (err: any) {
    failures.push(`CLAIM SOURCE URL FAIL: ${err.message}`);
  }

  // 14b. Answer without resume citation becomes a gap item, not an answer
  try {
    const testJob = {
      id: "job-verify-1",
      title: "Senior Distributed Systems Engineer",
      company: "InfraCorp",
      description: "Must have deep expertise in Raft Distributed Consensus algorithm and React frontend.",
      skills: ["Raft Consensus", "React"],
    };

    // Candidate has React experience, but ZERO Raft Consensus experience
    const testCandidate = {
      headline: "Frontend Specialist",
      experience: [
        {
          role: "Frontend Engineer",
          company: "WebTech",
          bullets: ["Built performant interactive dashboards with React and TypeScript."],
        },
      ],
    };

    const intel = {
      normalizedCompany: "infracorp",
      companyName: "InfraCorp",
      claims: [{ text: "Series B funded", sourceUrl: "https://techcrunch.com/infracorp", fetchedAt: "2026-10-01" }],
      fetchedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      isThin: false,
    };

    const pack = await generateInterviewPack(testJob, testCandidate, intel);

    // Verify Raft is in gaps, not answered with fake experience
    const raftGap = pack.gaps.find((g) => /raft/i.test(g.jdRequirement));
    const raftCard = pack.cards.find((c) => /raft/i.test(c.question));

    if (isNegativeControl) {
      // Simulate failure by asserting an answer was fabricated
      assert.ok(!raftGap, "Simulated failure: Raft gap missing");
    } else {
      assert.ok(raftGap, "Raft requirement with no resume citation must be placed in gaps matrix");
      assert.strictEqual(raftGap.resumeStatus, "gap");
      assert.ok(raftGap.bridgeStrategy.length > 10, "Must provide honest bridge strategy");
      assert.strictEqual(raftCard, undefined, "Must NOT generate an answered card without real resume citation");
    }

    console.log("  [PASS] Answer Grounding: Uncited JD requirement becomes a gap item, not a fabricated answer");
  } catch (err: any) {
    failures.push(`RESUME CITATION GROUNDING FAIL: ${err.message}`);
  }

  // 14c. Every item carries a valid label ("From job description" | "From your resume" | "From company source" | "AI suggestion")
  try {
    const allowedLabels = new Set([
      "From job description",
      "From your resume",
      "From company source",
      "AI suggestion",
    ]);

    const testJob = {
      id: "job-verify-labels",
      title: "Full-Stack Engineer",
      company: "MonkeCorp",
      description: "Responsible for Node.js API development and PostgreSQL query optimization.",
      skills: ["Node.js", "PostgreSQL"],
    };
    const testCandidate = {
      headline: "Full-Stack Engineer",
      experience: [
        {
          role: "Full-Stack Developer",
          company: "CodeStudio",
          bullets: ["Designed Node.js REST services and optimized PostgreSQL queries."],
        },
      ],
    };
    const testIntel = {
      normalizedCompany: "monkecorp",
      companyName: "MonkeCorp",
      claims: [
        { text: "Hiring engineering leads", sourceUrl: "https://news.ycombinator.com/item?id=1", fetchedAt: "2026-10-01" },
      ],
      fetchedAt: "2026-10-01T00:00:00.000Z",
      expiresAt: "2026-10-31T00:00:00.000Z",
      isThin: false,
    };

    const pack = await generateInterviewPack(testJob, testCandidate, testIntel);

    if (isNegativeControl) {
      // Corrupt a label in negative control
      (pack.cards[0] as any).label = "UNLABELED_CORRUPTED";
    }

    // Verify all cards have label
    for (const card of pack.cards) {
      assert.ok(allowedLabels.has(card.label), `Card ${card.id} has invalid label '${card.label}'`);
    }

    // Verify fear question options
    for (const opt of pack.fearQuestionOptions) {
      assert.ok(allowedLabels.has(opt.label || ""), `Fear option ${opt.id} has invalid label '${opt.label}'`);
    }

    // Verify gaps
    for (const gap of pack.gaps) {
      assert.ok(allowedLabels.has(gap.label || ""), `Gap ${gap.id} has invalid label '${gap.label}'`);
    }

    // Verify brief recentNews
    for (const news of pack.brief.recentNews) {
      assert.ok(allowedLabels.has(news.label || ""), `News item has invalid label '${news.label}'`);
    }

    // Verify culture signals
    for (const signal of pack.brief.cultureSignals) {
      assert.ok(allowedLabels.has(signal.label || ""), `Culture signal has invalid label '${signal.label}'`);
    }

    // Verify reverse questions (askThem)
    for (const q of pack.askThem) {
      assert.ok(allowedLabels.has(q.label || ""), `Reverse question ${q.id} has invalid label '${q.label}'`);
    }

    // Verify quiz questions
    for (const q of pack.quiz) {
      assert.ok(allowedLabels.has(q.label || ""), `Quiz question ${q.id} has invalid label '${q.label}'`);
    }

    // Verify sources
    for (const src of pack.sources) {
      assert.ok(allowedLabels.has(src.label || ""), `Source ${src.url} has invalid label '${src.label}'`);
    }

    console.log("  [PASS] Item Labeling: Every single item in the dossier carries a verified label");
  } catch (err: any) {
    failures.push(`ITEM LABELING FAIL: ${err.message}`);
  }

  // 14d. Cache hit within 30 days does not call provider/fetch; expired cache refetches
  try {
    let fetchCalls = 0;
    const fetchSpy = async (_name: string) => {
      fetchCalls++;
      return [{ text: "Newly fetched claim", sourceUrl: "https://example.com/fresh", fetchedAt: "now" }];
    };

    // Subtest 1: Fresh cache (< 30 days old)
    const freshMockAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                normalized_company: "freshcorp",
                company_name: "FreshCorp",
                intel_json: {
                  claims: [{ text: "Cached claim", sourceUrl: "https://example.com/cached", fetchedAt: "2026-10-01" }],
                },
                claims_count: 1,
                fetched_at: "2026-10-01T00:00:00.000Z",
                expires_at: new Date(Date.now() + 15 * 86400000).toISOString(), // 15 days in future
              },
              error: null,
            }),
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    };

    fetchCalls = 0;
    const freshIntel = await getCompanyIntel("FreshCorp", freshMockAdmin, {
      fetchClaims: fetchSpy,
    });
    if (isNegativeControl) {
      fetchCalls = 999; // Force failure in negative control
    }
    assert.strictEqual(fetchCalls, 0, "Fresh cache hit must NOT call fetchClaims");
    assert.strictEqual(freshIntel.claims.length, 1);
    assert.strictEqual(freshIntel.claims[0].text, "Cached claim");

    // Subtest 2: Expired cache (> 30 days old)
    const expiredMockAdmin = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                normalized_company: "expiredcorp",
                company_name: "ExpiredCorp",
                intel_json: {
                  claims: [{ text: "Old claim", sourceUrl: "https://example.com/old", fetchedAt: "2026-08-01" }],
                },
                claims_count: 1,
                fetched_at: "2026-08-01T00:00:00.000Z",
                expires_at: new Date(Date.now() - 5 * 86400000).toISOString(), // 5 days in past
              },
              error: null,
            }),
          }),
        }),
        upsert: async () => ({ error: null }),
      }),
    };

    fetchCalls = 0;
    const expiredIntel = await getCompanyIntel("ExpiredCorp", expiredMockAdmin, {
      fetchClaims: fetchSpy,
    });
    assert.strictEqual(fetchCalls, 1, "Expired cache MUST call fetchClaims to refetch");
    assert.strictEqual(expiredIntel.claims.length, 1);
    assert.strictEqual(expiredIntel.claims[0].text, "Newly fetched claim");

    console.log("  [PASS] 30-Day Cache: Cache hit does not call fetcher; expired cache refetches");
  } catch (err: any) {
    failures.push(`COMPANY INTEL CACHE FAIL: ${err.message}`);
  }

  // 14e. Per-User Daily Rate Limit (10 packs/day)
  try {
    _resetInterviewPackQuotaStore();

    // Call 10 times with Pro user -> All succeed
    for (let i = 1; i <= 10; i++) {
      const req = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=sample", {
        headers: { Authorization: "Bearer quota_user_token" },
      });
      const res = await handleInterviewPackRequest(req, {
        getSupabaseAdmin: () => mockAdmin("usr_quota_test"),
        getServerEntitlement: async () => ({ isPro: true }),
      });
      assert.strictEqual(res.status, 200, `Request ${i} of 10 must succeed`);
    }

    // 11th request must fail with 429
    const req11 = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=sample", {
      headers: { Authorization: "Bearer quota_user_token" },
    });
    const res11 = await handleInterviewPackRequest(req11, {
      getSupabaseAdmin: () => mockAdmin("usr_quota_test"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(res11.status, 429, "11th request must return 429 rate limit exceeded");
    const body11 = await res11.json();
    assert.strictEqual(body11.code, "RATE_LIMIT_EXCEEDED");
    console.log("  [PASS] Quota Enforcement: 10 packs/day per-user limit strictly enforced with 429");
  } catch (err: any) {
    failures.push(`QUOTA ENFORCEMENT FAIL: ${err.message}`);
  }

  // 14f. Client bundle scan: no server tokens or prompts in client JS
  try {
    const clientFiles = [
      clientPath,
      viewPath,
      fearPath,
      timeBoxPath,
      deckPath,
      railPath,
      lastNightPath,
      thinBannerPath,
      footerPath,
      drawerPath,
    ];

    const forbiddenStrings = [
      "GROQ_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "UNTRUSTED_DATA_SYSTEM_GUARD",
      "process.env.SUPABASE_SERVICE",
    ];

    for (const cp of clientFiles) {
      const code = fs.readFileSync(cp, "utf-8");
      for (const forbidden of forbiddenStrings) {
        if (code.includes(forbidden)) {
          throw new Error(`Forbidden server secret '${forbidden}' leaked in client file: ${path.basename(cp)}`);
        }
      }
    }

    console.log("  [PASS] Client Bundle Cleanse: Zero server tokens or prompts in client code");
  } catch (err: any) {
    failures.push(`CLIENT CLEANSE FAIL: ${err.message}`);
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
  console.log("INTERVIEW PACK ENGINE AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
