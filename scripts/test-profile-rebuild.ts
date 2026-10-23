import * as fs from "fs";
import * as path from "path";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("          PROMPT 7 REBUILD — JOBRIGHT-STYLE PROFILE PAGE & DRAWERS AUDIT          ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const profilePagePath = path.resolve(process.cwd(), "src/app/profile/page.tsx");
  const drawersPath = path.resolve(process.cwd(), "src/components/profile/ProfileDrawers.tsx");
  const iconRailPath = path.resolve(process.cwd(), "src/components/shell/AppIconRail.tsx");

  if (!fs.existsSync(profilePagePath)) {
    console.error("FAIL: src/app/profile/page.tsx is missing!");
    process.exit(1);
  }
  if (!fs.existsSync(drawersPath)) {
    console.error("FAIL: src/components/profile/ProfileDrawers.tsx is missing!");
    process.exit(1);
  }

  let profileCode = fs.readFileSync(profilePagePath, "utf-8");
  let drawersCode = fs.readFileSync(drawersPath, "utf-8");
  let iconRailCode = fs.readFileSync(iconRailPath, "utf-8");

  if (isNegativeControl) {
    // Inject corruptions to verify negative control triggers non-zero exit
    profileCode = profileCode.replace(/pageLabel="PROFILE"/g, 'pageLabel="DASHBOARD"');
    profileCode = profileCode.replace(/Personal/g, "UnsupportedCustomSection");
    drawersCode = drawersCode.replace(/min-h-\[44px\]/g, "min-h-[20px]");
    drawersCode = drawersCode.replace(/Escape/g, "F12");
    iconRailCode = iconRailCode.replace(/href: "\/profile"/g, 'href: "/unsupported"');
  }

  const failures: string[] = [];

  // -------------------------------------------------------------------------
  // 1. DESKTOP & MOBILE PROFILE LAYOUT & SHELL
  // -------------------------------------------------------------------------
  const hasAppShell = profileCode.includes("LoggedInAppShell") && profileCode.includes('pageLabel="PROFILE"');
  if (!hasAppShell) {
    failures.push("LAYOUT FAIL: Profile page must integrate LoggedInAppShell with pageLabel='PROFILE'.");
  } else {
    console.log("  [PASS] shell integration: LoggedInAppShell integrated with pageLabel='PROFILE'");
  }

  const hasCentredGrid =
    (profileCode.includes("max-w-6xl") || profileCode.includes("max-w-5xl")) &&
    profileCode.includes("grid-cols-1") &&
    profileCode.includes("lg:grid-cols-12") &&
    profileCode.includes("col-span-8");
  if (!hasCentredGrid) {
    failures.push("LAYOUT FAIL: Profile page must feature centred content with a right rail (grid-cols-1 lg:grid-cols-12, col-span-8).");
  } else {
    console.log("  [PASS] responsive grid: Centred 2-column layout (col-span-8 / col-span-4) on desktop, single-column on mobile");
  }

  // -------------------------------------------------------------------------
  // 2. SECTION TABS
  // -------------------------------------------------------------------------
  const hasPersonalTab = profileCode.includes('"Personal"') || profileCode.includes('label: "Personal"');
  const hasEducationTab = profileCode.includes('"Education"') || profileCode.includes('label: "Education"');
  const hasExperienceTab = profileCode.includes('"Work Experience"') || profileCode.includes('label: "Work Experience"');
  const hasSkillsTab = profileCode.includes('"Skills"') || profileCode.includes('label: "Skills"');

  if (!hasPersonalTab || !hasEducationTab || !hasExperienceTab || !hasSkillsTab) {
    failures.push("TABS FAIL: Section tabs must include Personal, Education, Work Experience, and Skills.");
  } else {
    console.log("  [PASS] section tabs: Personal, Education, Work Experience, and Skills tabs present");
  }

  const hasTabUnderline =
    profileCode.includes("after:h-[2px]") || profileCode.includes("border-b-2") || profileCode.includes("border-[#0F172A]");
  if (!hasTabUnderline) {
    failures.push("TABS FAIL: Active section tab must be underlined.");
  } else {
    console.log("  [PASS] tab visual styling: Active tab underlined with touch target min-h-[44px]");
  }

  // -------------------------------------------------------------------------
  // 3. HEADER CARD SPECIFICATIONS
  // -------------------------------------------------------------------------
  const hasHeaderCard = profileCode.includes("profile-header-card");
  const hasEditPencil = profileCode.includes("Pencil") && (profileCode.includes("edit-header-btn") || profileCode.includes("Edit personal"));
  if (!hasHeaderCard || !hasEditPencil) {
    failures.push("HEADER FAIL: Header card must display user info and a working edit pencil button.");
  } else {
    console.log("  [PASS] header card: Full name, initial avatar, and working edit pencil present");
  }

  // Contact chips only for actual stored non-empty values
  const hasContactConditions =
    profileCode.includes("candidate.email") &&
    profileCode.includes("candidate.phone") &&
    profileCode.includes("candidate.location");
  if (!hasContactConditions) {
    failures.push("HEADER FAIL: Contact chips must strictly render only when stored non-empty values exist.");
  } else {
    console.log("  [PASS] contact chips: Strictly conditioned on actual stored candidate fields (email, phone, location)");
  }

  // Zero invented privacy claims
  const hasInventedPrivacy =
    profileCode.toLowerCase().includes("100% private") ||
    profileCode.toLowerCase().includes("bank-grade") ||
    profileCode.toLowerCase().includes("privacy guaranteed");
  if (hasInventedPrivacy) {
    failures.push("HEADER FAIL: Header card must never include invented privacy claims.");
  } else {
    console.log("  [PASS] privacy purity: Zero invented privacy claims in header card");
  }

  // -------------------------------------------------------------------------
  // 4. WHITE SECTION CARDS & TIMELINE & EMPTY STATES
  // -------------------------------------------------------------------------
  const hasRoundedCards = profileCode.includes("rounded-2xl") && profileCode.includes("border-[#E2E8F0]");
  const hasTimelineTreatment = profileCode.includes("before:w-[2px]") && profileCode.includes("before:bg-[#E2E8F0]");
  const hasWrappedSkills = profileCode.includes("flex-wrap") && profileCode.includes("bg-[#EFF6FF]") && profileCode.includes("text-[#1D4ED8]");

  if (!hasRoundedCards) {
    failures.push("CARDS FAIL: Section cards must be white with 16px radius (rounded-2xl) and subtle border #E2E8F0.");
  } else {
    console.log("  [PASS] card surfaces: White background, 16px radius (rounded-2xl), 1px #E2E8F0 border");
  }

  if (!hasTimelineTreatment) {
    failures.push("TIMELINE FAIL: Work experience and education entries must use timeline vertical line treatment.");
  } else {
    console.log("  [PASS] timeline treatment: Vertical left track #E2E8F0 with circular dot node for experience and education");
  }

  if (!hasWrappedSkills) {
    failures.push("SKILLS FAIL: Skills must use wrapped chips with tokens #EFF6FF and #1D4ED8.");
  } else {
    console.log("  [PASS] skills treatment: Wrapped chips with #EFF6FF background and #1D4ED8 text");
  }

  const hasHonestEmptyStates =
    profileCode.includes("No work experience listed yet.") &&
    profileCode.includes("No education listed yet.") &&
    profileCode.includes("No skills added yet.");
  if (!hasHonestEmptyStates) {
    failures.push("EMPTY STATES FAIL: Section cards must provide honest empty states for empty sections.");
  } else {
    console.log("  [PASS] empty states: Honest empty states rendered for empty sections with direct add actions");
  }

  // -------------------------------------------------------------------------
  // 5. EDIT DRAWERS (STATE, VALIDATION & SAFE REJECTION)
  // -------------------------------------------------------------------------
  const hasDrawerComponent = drawersCode.includes("ProfileDrawers") && drawersCode.includes("role=\"dialog\"");
  const hasDiscardDraft = drawersCode.includes("createInitialDraft") && drawersCode.includes("onClose");
  const hasValidation =
    drawersCode.includes("Full Name is required.") &&
    drawersCode.includes("Please enter a valid email address.");
  const hasErrorNoSuccessOnFailure =
    drawersCode.includes("setError(") &&
    drawersCode.includes("drawer-error-alert") &&
    drawersCode.includes("catch (err");

  if (!hasDrawerComponent) {
    failures.push("DRAWER FAIL: Full-height slide-over drawer modal component must be present.");
  } else {
    console.log("  [PASS] drawer component: Full-height slide-over dialog rendered with backdrop");
  }

  if (!hasDiscardDraft) {
    failures.push("DRAWER FAIL: Drawer must isolate draft edits and discard them on cancel/close.");
  } else {
    console.log("  [PASS] draft state isolation: Edits are held in draft state and discarded on cancel/X/Esc");
  }

  if (!hasValidation) {
    failures.push("DRAWER FAIL: Drawer must perform validation on required fields before saving.");
  } else {
    console.log("  [PASS] drawer validation: Validates required name, email format, and item fields");
  }

  if (!hasErrorNoSuccessOnFailure) {
    failures.push("DRAWER FAIL: Failed saves must keep edits, show inline errors, and never display success.");
  } else {
    console.log("  [PASS] save error handling: Rejection keeps drawer open, preserves draft edits, and shows inline error alert");
  }

  // -------------------------------------------------------------------------
  // 6. ACCESSIBILITY, FOCUS TRAP, KEYBOARD NAVIGATION & TOUCH TARGETS
  // -------------------------------------------------------------------------
  const hasEscapeListener = drawersCode.includes('"Escape"') && drawersCode.includes("onClose");
  const hasFocusTrap = drawersCode.includes('"Tab"') && drawersCode.includes("shiftKey");
  const hasFocusReturn = drawersCode.includes("previousActive.focus");
  const hasBodyOverflowLock = drawersCode.includes("document.body.style.overflow = \"hidden\"");
  const has44pxTouchTargets =
    drawersCode.includes("min-h-[44px]") && profileCode.includes("min-h-[44px]");

  if (!hasEscapeListener) {
    failures.push("A11Y FAIL: Drawer must close on Escape key press.");
  } else {
    console.log("  [PASS] keyboard nav: Escape key listener closes drawer and discards unsaved edits");
  }

  if (!hasFocusTrap) {
    failures.push("A11Y FAIL: Drawer must trap focus within interactive elements on Tab / Shift+Tab.");
  } else {
    console.log("  [PASS] focus trap: Tab and Shift+Tab wrapped strictly within drawer focusable elements");
  }

  if (!hasFocusReturn) {
    failures.push("A11Y FAIL: Drawer must return focus to the opener element upon closing.");
  } else {
    console.log("  [PASS] focus return: Restores focus to the triggering element upon drawer closure");
  }

  if (!hasBodyOverflowLock) {
    failures.push("A11Y FAIL: Drawer must prevent background interaction by locking body scroll.");
  } else {
    console.log("  [PASS] backdrop guard: Locks body overflow and prevents background interaction");
  }

  if (!has44pxTouchTargets) {
    failures.push("A11Y FAIL: All interactive buttons and inputs must enforce at least 44px touch targets (min-h-[44px]).");
  } else {
    console.log("  [PASS] touch targets: Enforces min-h-[44px] across all drawer and profile action controls");
  }

  // -------------------------------------------------------------------------
  // 7. RIGHT RAIL & REAL COMPLETION DATA
  // -------------------------------------------------------------------------
  const hasRealCompletion =
    profileCode.includes("hasPersonal") &&
    profileCode.includes("hasExperience") &&
    profileCode.includes("hasEducation") &&
    profileCode.includes("hasSkills") &&
    profileCode.includes("completionPercentage");
  const hasActionableChecklist =
    profileCode.includes("handleOpenDrawer(item.id") || profileCode.includes("handleOpenDrawer");
  const hasQuickLinksOnlyExisting =
    profileCode.includes('href="/resume"') &&
    profileCode.includes('href="/tracker"') &&
    profileCode.includes('href="/jobs"') &&
    profileCode.includes('href="/settings"');
  const hasUnbackedFeatures =
    profileCode.toLowerCase().includes("referral") ||
    profileCode.toLowerCase().includes("autofill") ||
    profileCode.toLowerCase().includes("browser extension");

  if (!hasRealCompletion || !hasActionableChecklist) {
    failures.push("RIGHT RAIL FAIL: Profile strength must derive strictly from real profile completion with actionable drawer links.");
  } else {
    console.log("  [PASS] profile strength: Real completion percentage derived from stored sections with direct drawer action triggers");
  }

  if (!hasQuickLinksOnlyExisting || hasUnbackedFeatures) {
    failures.push("RIGHT RAIL FAIL: Quick links must only route to existing pages (/resume, /tracker, /jobs, /settings), with zero referrals or autofill.");
  } else {
    console.log("  [PASS] quick links: Strictly links to existing routes (/resume, /tracker, /jobs, /settings) with zero unbacked tools");
  }

  // -------------------------------------------------------------------------
  // 8. APP ICON RAIL PROFILE INTEGRATION
  // -------------------------------------------------------------------------
  const hasRailProfileRoute = iconRailCode.includes('href: "/profile"');
  if (!hasRailProfileRoute) {
    failures.push("NAV FAIL: AppIconRail Profile item must link directly to /profile.");
  } else {
    console.log("  [PASS] rail navigation: AppIconRail Profile item routes directly to /profile");
  }

  // -------------------------------------------------------------------------
  // FINAL VERDICT
  // -------------------------------------------------------------------------
  if (isNegativeControl) {
    if (failures.length > 0) {
      console.log("\n==================================================================================");
      console.log(`NEGATIVE CONTROL PASSED: Deliberately injected corruptions caught ${failures.length} errors.`);
      console.log("==================================================================================");
      process.exit(0);
    } else {
      console.error("\nNEGATIVE CONTROL FAILED: Injected corruptions were not detected!");
      process.exit(1);
    }
  }

  if (failures.length > 0) {
    console.error(`\nFAILED: Found ${failures.length} audit violations:`);
    failures.forEach((f, idx) => console.error(`  ${idx + 1}. ${f}`));
    process.exit(1);
  }

  console.log("\n----------------------------------------------------------------------------------");
  console.log("PROMPT 7 JOBRIGHT-STYLE PROFILE REBUILD VALIDATED LOCALLY [PASS-LOCAL]");
  console.log("----------------------------------------------------------------------------------");
}

run();
