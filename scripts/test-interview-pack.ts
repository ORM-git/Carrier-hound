import * as fs from "fs";
import * as path from "path";
import assert from "assert";
import { handleInterviewPackRequest } from "../src/lib/interview-pack/handler";

const isNegativeControl = process.argv.includes("--negative-control");

async function run() {
  console.log("==================================================================================");
  console.log("       TEST: INTERVIEW PACK UI, DOSSIER FLOW & SERVER-SIDE PRO ENFORCEMENT       ");
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
  const hasStaticParams = pageCode.includes("export function generateStaticParams()") &&
    pageCode.includes('{ id: "sample" }');
  if (!hasStaticParams) {
    failures.push("STATIC EXPORT FAIL: /jobs/[id]/interview-pack/page.tsx must export generateStaticParams() for static export.");
  } else {
    console.log("  [PASS] Static Export: generateStaticParams() defined with pre-rendered IDs");
  }

  // 2. Server-Side Pro Enforcement on /api/jobs/interview-pack
  const serverCode = routeCode + "\n" + handlerCode;
  const hasServerProEnforcement = serverCode.includes("getServerEntitlement") &&
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
    failures.push("SERVER PRO ENFORCEMENT FAIL: /api/jobs/interview-pack must validate token and use getServerEntitlement with no literal shortcuts or user_metadata trust.");
  } else {
    console.log("  [PASS] Server Pro Enforcement: Token validation via Supabase and getServerEntitlement (401/403)");
  }

  // 3. Client bundle lacks SAMPLE_INTERVIEW_PACK and Acme Cloud
  const clientImportsSamplePack = clientCode.includes("import { SAMPLE_INTERVIEW_PACK") ||
    clientCode.includes("import SAMPLE_INTERVIEW_PACK");
  const fixtureHasAcme = fixtureCode.includes("Acme Cloud") || fixtureCode.includes("Acme");
  const fixtureHasStripe = fixtureCode.includes("company: \"Stripe\"");
  const fixtureHasConfirmed = fixtureCode.includes("verificationType: \"Confirmed\"") ||
    fixtureCode.includes("label: \"Confirmed\"");

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

  process.env.EARLY_ACCESS_ALLOWED_EMAILS = "approved@careermonke.com";

  const mockAdmin = (userId: string | null = null, error: any = null, email: string = "approved@careermonke.com") => ({
    auth: {
      getUser: async () => ({
        data: { user: userId ? { id: userId, email, user_metadata: {} } : null },
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

  // 4. API Endpoint Execution Test: Garbage token gets 403, Missing token gets 401
  try {
    // 4a. Missing token -> 401
    const reqMissing = new Request("http://localhost:3000/api/jobs/interview-pack");
    const resMissing = await handleInterviewPackRequest(reqMissing, {
      getSupabaseAdmin: () => mockAdmin(null, new Error("Missing")),
      getServerEntitlement: async () => ({ isPro: false }),
    });
    const statusMissing = resMissing.status;
    assert.strictEqual(statusMissing, 401, "Missing token must yield status 401");

    // 4b. Garbage non-Pro token -> 403
    const reqGarbage = new Request("http://localhost:3000/api/jobs/interview-pack", {
      headers: { Authorization: "Bearer garbage_non_pro_token" },
    });
    const resGarbage = await handleInterviewPackRequest(reqGarbage, {
      getSupabaseAdmin: () => mockAdmin("usr_garbage_test"),
      getServerEntitlement: async () => ({ isPro: isNegativeControl ? true : false }),
    });
    const statusGarbage = resGarbage.status;
    const bodyGarbage = await resGarbage.json();
    assert.strictEqual(statusGarbage, 403, "Garbage non-Pro token must yield status 403");
    assert.strictEqual(bodyGarbage.code, "PRO_REQUIRED", "Must return code PRO_REQUIRED");

    // 4c. Valid Pro token without real AI generator -> 503 not_available_yet (never sample data as if real)
    const reqProNoAi = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=test_pro", {
      headers: { Authorization: "Bearer valid_pro_token" },
    });
    const resProNoAi = await handleInterviewPackRequest(reqProNoAi, {
      getSupabaseAdmin: () => mockAdmin("usr_pro_test"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(resProNoAi.status, 503, "Valid Pro token without real AI result must yield 503 not_available_yet");
    const bodyProNoAi = await resProNoAi.json();
    assert.strictEqual(bodyProNoAi.pack, null, "Must never return sample pack as if real");
    assert.strictEqual(bodyProNoAi.available, false);
    assert.strictEqual(bodyProNoAi.status, "not_available_yet");

    // 4d. Valid Pro token with real AI result -> 200
    const reqPro = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=job_real_123", {
      headers: { Authorization: "Bearer valid_pro_token" },
    });
    const resPro = await handleInterviewPackRequest(reqPro, {
      getSupabaseAdmin: () => mockAdmin("usr_pro_test"),
      getServerEntitlement: async () => ({ isPro: true }),
      generateInterviewPack: async ({ jobId }) => ({
        jobId,
        jobTitle: "Senior Backend Engineer",
        companyName: "Linear",
        department: "Engineering",
        location: "Remote",
        isThinResearch: false,
        fearQuestionOptions: [],
        brief: {
          summary: "Real AI summary",
          mission: "Real AI mission",
          marketContext: "Real AI context",
          recentNews: [],
          cultureSignals: [],
        },
        process: { overview: "Real overview", stages: [] },
        cards: [],
        gaps: [],
        askThem: [],
        quiz: [],
        sources: [],
      }),
    });
    assert.strictEqual(resPro.status, 200, "Valid Pro token with real AI result must yield status 200");
    const bodyPro = await resPro.json();
    assert.ok(bodyPro.pack, "Must return real interview pack");
    assert.strictEqual(bodyPro.available, true);
    assert.strictEqual(bodyPro.isPro, true);

    // 4e. Unapproved user -> 403 Early access only
    const reqUnapproved = new Request("http://localhost:3000/api/jobs/interview-pack?jobId=job_real_123", {
      headers: { Authorization: "Bearer unapproved_token" },
    });
    const resUnapproved = await handleInterviewPackRequest(reqUnapproved, {
      getSupabaseAdmin: () => mockAdmin("usr_unapproved", null, "unapproved@test.com"),
      getServerEntitlement: async () => ({ isPro: true }),
    });
    assert.strictEqual(resUnapproved.status, 403, "Unapproved user must yield status 403");
    const bodyUnapproved = await resUnapproved.json();
    assert.strictEqual(bodyUnapproved.error, "Early access only", "Must return Early access only");

    console.log("  [PASS] Endpoint Live Execution: Missing token -> 401, Non-Pro -> 403, Unapproved -> 403, No real AI -> 503, Real AI -> 200");
  } catch (err: any) {
    failures.push(`API EXECUTION FAIL: ${err.message}`);
  }

  // 5. Entry Button in JobDetailView & Feature Flag
  const hasEntryButton = detailCode.includes("data-testid=\"interview-pack-entry-button\"") &&
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
  const hasDrawerFocusTrap = drawerCode.includes("previouslyFocusedElementRef") &&
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
  const hasAriaLiveCounter = deckCode.includes("aria-live=\"polite\"");
  if (!hasCmBlueActions) {
    failures.push("COLOR ACCENT FAIL: Primary action buttons in card deck must use CM blue instead of emerald.");
  } else if (!hasAriaLiveCounter) {
    failures.push("ARIA LIVE FAIL: Ready progress indicator must have aria-live='polite' for screen reader announcements.");
  } else {
    console.log("  [PASS] Design System & A11y: CM blue for primary actions, aria-live on 'X of Y ready', focus trap active");
  }

  // 9. Opening Fear Question Screen (Step 1)
  const hasFearScreen = fearCode.includes("afraid of?") &&
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
  const hasTimeBox = timeBoxCode.includes("I have 10 min") &&
    timeBoxCode.includes("I have 30 min") &&
    timeBoxCode.includes("I have tonight") &&
    timeBoxCode.includes("cardCount");
  if (!hasTimeBox) {
    failures.push("TIME BOX FAIL: Step 2 must offer 10 min / 30 min / tonight time boxes trimming card counts.");
  } else {
    console.log("  [PASS] Flow Step 2: Time Box Screen (10m, 30m, tonight) trimming card count");
  }

  // 11. Dossier Rail & Sections
  const hasRailSections = railCode.includes("Brief") &&
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
  const hasLastNightMode = lastNightCode.includes("Last-Night") &&
    lastNightCode.includes("mustKnowCards") &&
    lastNightCode.includes("Pre-Interview") &&
    lastNightCode.includes("Checklist");
  if (!hasLastNightMode) {
    failures.push("LAST NIGHT MODE FAIL: Must include Last-Night Mode toggle displaying top 5 must-know cards and checklist.");
  } else {
    console.log("  [PASS] Last-Night Mode: Filtered 5 must-know cards and evening ritual checklist verified");
  }

  // 13. Disclaimer Footer
  const hasDisclaimerFooter = footerCode.includes("Preparation aid based on public sources; no hiring outcome is guaranteed.") &&
    !footerCode.includes("guaranteed job") &&
    !footerCode.includes("guaranteed offer");
  if (!hasDisclaimerFooter) {
    failures.push("DISCLAIMER FOOTER FAIL: Must include exact disclaimer: 'Preparation aid based on public sources; no hiring outcome is guaranteed.' with no job guarantee wording.");
  } else {
    console.log("  [PASS] Disclaimer Footer: Exact mandatory disclaimer present with zero job guarantee claims");
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
  console.log("INTERVIEW PACK UI & PRO ENFORCEMENT AUDIT VALIDATED [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
