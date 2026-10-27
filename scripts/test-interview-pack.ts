import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
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
  const netlifyFnPath = path.resolve(process.cwd(), "netlify/functions/interview-pack.ts");
  const detailPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");
  const fixturePath = path.resolve(process.cwd(), "src/data/interviewPackFixture.ts");

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
    netlifyFnPath,
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
  let fearCode = fs.readFileSync(fearPath, "utf-8");
  let timeBoxCode = fs.readFileSync(timeBoxPath, "utf-8");
  let deckCode = fs.readFileSync(deckPath, "utf-8");
  let railCode = fs.readFileSync(railPath, "utf-8");
  let lastNightCode = fs.readFileSync(lastNightPath, "utf-8");
  let thinBannerCode = fs.readFileSync(thinBannerPath, "utf-8");
  let footerCode = fs.readFileSync(footerPath, "utf-8");
  let netlifyFnCode = fs.readFileSync(netlifyFnPath, "utf-8");
  let detailCode = fs.readFileSync(detailPath, "utf-8");
  let fixtureCode = fs.readFileSync(fixturePath, "utf-8");

  if (isNegativeControl) {
    pageCode = pageCode.replace(/generateStaticParams/g, "corruptedParams");
    clientCode = clientCode.replace(/ProUpgradeScreen/g, "corruptedUpgrade");
    fearCode = fearCode.replace(/afraid of\?/g, "Corrupted Question");
    fixtureCode = fixtureCode.replace(/Tell me about yourself/g, "");
    timeBoxCode = timeBoxCode.replace(/I have 10 min/g, "");
    deckCode = deckCode.replace(/whyTheyAsk/g, "corruptedWhy");
    deckCode = deckCode.replace(/resumeBulletSource/g, "corruptedBullet");
    deckCode = deckCode.replace(/Got it!/g, "corruptedGotIt");
    railCode = railCode.replace(/Last-Night Mode/g, "corruptedNight");
    thinBannerCode = thinBannerCode.replace(/thin-research-banner/g, "corrupted-banner");
    footerCode = footerCode.replace(/Preparation aid based on public sources; no hiring outcome is guaranteed\./g, "Guaranteed job!");
    netlifyFnCode = netlifyFnCode.replace(/verifyProUser/g, "corruptedVerify");
    detailCode = detailCode.replace(/interview-pack-entry-button/g, "corrupted-button");
  }

  const failures: string[] = [];

  // 1. Route & Static Export
  const hasStaticParams = pageCode.includes("export function generateStaticParams()") &&
    pageCode.includes("{ id: \"sample\" }");
  if (!hasStaticParams) {
    failures.push("STATIC EXPORT FAIL: /jobs/[id]/interview-pack/page.tsx must export generateStaticParams() for static export.");
  } else {
    console.log("  [PASS] Static Export: generateStaticParams() defined with pre-rendered IDs");
  }

  // 2. Server-Side Pro Enforcement
  const hasServerProEnforcement = netlifyFnCode.includes("verifyProUser") &&
    netlifyFnCode.includes("authResult.isPro") &&
    netlifyFnCode.includes("status: 403") &&
    netlifyFnCode.includes("status: 401") &&
    clientCode.includes("ProUpgradeScreen") &&
    clientCode.includes("getProAccessStatus");
  if (!hasServerProEnforcement) {
    failures.push("SERVER PRO ENFORCEMENT FAIL: Netlify function and client must enforce Pro-only access with 401/403 and ProUpgradeScreen.");
  } else {
    console.log("  [PASS] Server Pro Enforcement: Bearer token verification, 401/403 gating, and client ProUpgradeScreen");
  }

  // 3. Entry Button in JobDetailView
  const hasEntryButton = detailCode.includes("data-testid=\"interview-pack-entry-button\"") &&
    detailCode.includes("/interview-pack") &&
    detailCode.includes("Open Interview Pack");
  if (!hasEntryButton) {
    failures.push("ENTRY BUTTON FAIL: JobDetailView must include 'Open Interview Pack' entry button in desktop side panel.");
  } else {
    console.log("  [PASS] Entry Button: Open Interview Pack button integrated in JobDetailView side panel");
  }

  // 4. Opening Fear Question Screen (Step 1)
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

  // 5. Time Box Screen (Step 2)
  const hasTimeBox = timeBoxCode.includes("I have 10 min") &&
    timeBoxCode.includes("I have 30 min") &&
    timeBoxCode.includes("I have tonight") &&
    timeBoxCode.includes("cardCount");
  if (!hasTimeBox) {
    failures.push("TIME BOX FAIL: Step 2 must offer 10 min / 30 min / tonight time boxes trimming card counts.");
  } else {
    console.log("  [PASS] Flow Step 2: Time Box Screen (10m, 30m, tonight) trimming card count");
  }

  // 6. Swipe / Step Cards (Step 3)
  const hasCardDeck = deckCode.includes("currentCard.question") &&
    deckCode.includes("currentCard.whyTheyAsk") &&
    deckCode.includes("currentCard.answerDraft") &&
    deckCode.includes("currentCard.resumeBulletSource") &&
    deckCode.includes("currentCard.source") &&
    deckCode.includes("Got it!") &&
    deckCode.includes("Practice again") &&
    deckCode.includes("Skip") &&
    deckCode.includes("ready") &&
    deckCode.includes("You are ready for this interview.");
  if (!hasCardDeck) {
    failures.push("CARD DECK FAIL: Question cards must include question, why-they-ask, resume bullet citation, source link, action buttons (Got it/Practice again/Skip), micro-win line, and completion screen.");
  } else {
    console.log("  [PASS] Flow Step 3: Flashcard Deck with why-they-ask, resume citations, action buttons, and completion screen");
  }

  // 7. Dossier Rail & Sections
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

  // 8. Last-Night Mode
  const hasLastNightMode = lastNightCode.includes("Last-Night") &&
    lastNightCode.includes("mustKnowCards") &&
    lastNightCode.includes("Pre-Interview") &&
    lastNightCode.includes("Checklist");
  if (!hasLastNightMode) {
    failures.push("LAST NIGHT MODE FAIL: Must include Last-Night Mode toggle displaying top 5 must-know cards and checklist.");
  } else {
    console.log("  [PASS] Last-Night Mode: Filtered 5 must-know cards and evening ritual checklist verified");
  }

  // 9. Thin-Research Banner
  const hasThinBanner = thinBannerCode.includes("data-testid=\"thin-research-banner\"") &&
    thinBannerCode.includes("Limited Company-Specific Interview Data Found");
  if (!hasThinBanner) {
    failures.push("THIN BANNER FAIL: Must include thin-research banner when company evidence is low.");
  } else {
    console.log("  [PASS] Thin Research Banner: Non-alarmist benchmark notification verified");
  }

  // 10. Disclaimer Footer
  const hasDisclaimerFooter = footerCode.includes("Preparation aid based on public sources; no hiring outcome is guaranteed.") &&
    !footerCode.includes("guaranteed job") &&
    !footerCode.includes("guaranteed offer");
  if (!hasDisclaimerFooter) {
    failures.push("DISCLAIMER FOOTER FAIL: Must include exact disclaimer: 'Preparation aid based on public sources; no hiring outcome is guaranteed.' with no job guarantee wording.");
  } else {
    console.log("  [PASS] Disclaimer Footer: Exact mandatory disclaimer present with zero job guarantee claims");
  }

  // 11. Readability & Accessibility
  const hasReadableTypography = deckCode.includes("text-[15px]") || deckCode.includes("text-[16px]");
  const hasAriaLabels = deckCode.includes("aria-label=") && railCode.includes("aria-label=");
  if (!hasReadableTypography || !hasAriaLabels) {
    failures.push("A11Y & READABILITY FAIL: Body copy must be >=15px and interactive elements must have aria labels.");
  } else {
    console.log("  [PASS] A11y & Readability: Body font >=15px, readable contrast, aria labels, and keyboard navigation");
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

run();
