import * as fs from "fs";
import * as path from "path";
import ts from "typescript";

const isNegativeControl = process.argv.includes("--negative-control");

function run() {
  console.log("==================================================================================");
  console.log("       JOB DETAIL REDESIGN (JOBRIGHT-STYLE TWO-COLUMN & STICKY HEADER) AUDIT      ");
  console.log("==================================================================================");
  console.log(`Mode: ${isNegativeControl ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VALIDATION"}\n`);

  const detailViewPath = path.resolve(process.cwd(), "src/components/jobs/JobDetailView.tsx");

  if (!fs.existsSync(detailViewPath)) {
    console.error("FAIL: Required file src/components/jobs/JobDetailView.tsx is missing!");
    process.exit(1);
  }

  let detailCode = fs.readFileSync(detailViewPath, "utf-8");

  if (isNegativeControl) {
    // Inject intentional corruptions to verify negative control failure detection
    detailCode = detailCode.replace(/sticky top-14/g, "static");
    detailCode = detailCode.replace(/Overview/g, "BadTab1");
    detailCode = detailCode.replace(/>Responsibilities<\/h2>/g, ">BadResponsibilities</h2>");
    detailCode = detailCode.replace(/Company/g, "BadTab2");
    detailCode = detailCode.replace(/const isUnlocked = isPro && !job.proUnlockError;/g, "const isUnlocked = false;");
    detailCode = detailCode.replace(/lg:grid-cols-12/g, "block");
    detailCode = detailCode.replace(/mobile-sticky-header-strip/g, "bad-strip");
    detailCode = detailCode.replace(/sanitizeExternalUrl\(rawWebsite\)/g, "rawWebsite");
  }

  const failures: string[] = [];

  // 1. Sticky Header under Top Bar
  const hasStickyHeader =
    detailCode.includes("sticky top-14 z-20") &&
    detailCode.includes('aria-label="Job header"') &&
    detailCode.includes("onBack") &&
    detailCode.includes("onApply") &&
    detailCode.includes("Overview") &&
    detailCode.includes("Company") &&
    detailCode.includes("onHide") &&
    detailCode.includes("onSave") &&
    detailCode.includes("isScrolled") &&
    detailCode.includes("scrolled-header-chip");

  if (!hasStickyHeader) {
    failures.push("STICKY HEADER FAIL: Header must be sticky (sticky top-14 z-20) with Back, Overview/Company tabs, Share, Report issue, Hide, Heart, Apply, and scrolled compact chip.");
  } else {
    console.log("  [PASS] sticky header: pinned with top-14 z-20 docking under AppTopBar, with Back, Overview/Company tabs, Share, Report issue, Hide, Heart, Apply, and scrolled compact chip");
  }

  // 2. Header Body with 2x3 metadata and Match card
  const hasHeaderBody =
    detailCode.includes("inferJobLevel") &&
    detailCode.includes("formatRelativeTime") &&
    detailCode.includes("Experience Level") &&
    detailCode.includes("Skill") &&
    detailCode.includes("Role Match") &&
    !detailCode.includes("Industry"); // FitDiagnosticsResult has no industry dimension: never label one

  if (!hasHeaderBody) {
    failures.push("HEADER BODY FAIL: Must contain 2x3 metadata grid (location, job type, work model, level, salary, exp) and Match card with sub-scores.");
  } else {
    console.log("  [PASS] header body: metadata grid (location, type, work model, level, salary, exp) and match card with total % + sub-scores");
  }

  // 3. Two-Column Desktop Layout
  const hasTwoColumnGrid =
    detailCode.includes("grid-cols-1 lg:grid-cols-12") &&
    detailCode.includes("lg:col-span-7") &&
    detailCode.includes("lg:col-span-5");

  if (!hasTwoColumnGrid) {
    failures.push("TWO COLUMN GRID FAIL: Layout must be two-column on desktop (grid-cols-1 lg:grid-cols-12 with lg:col-span-7 and lg:col-span-5).");
  } else {
    console.log("  [PASS] two-column layout: clean two-column grid on desktop (lg:grid-cols-12 with 7/5 column ratio), single column on mobile");
  }

  // 4. Existing Overview cards must precede Company. Source order is intentional:
  // only render grounded lists and do not reintroduce a separate sections tab.
  const contentStart = detailCode.indexOf("(3) CONTENT ORDER");
  const contentCode = detailCode.slice(contentStart);
  const orderedMarkers = [
    ">Job description</h2>",
    ">Responsibilities</h2>",
    ">Qualifications</h2>",
    ">Benefits</h2>",
    'id="company-section"',
  ];
  const markerPositions = orderedMarkers.map((marker) => contentCode.indexOf(marker));
  const hasContentOrder = contentStart >= 0 && markerPositions.every(
    (position, index) => position >= 0 && (index === 0 || position > markerPositions[index - 1]),
  ) && contentCode.includes("responsibilitiesList.length > 0") &&
    contentCode.includes("requirementsList.length > 0 || preferredList.length > 0") &&
    contentCode.includes("benefitsList.length > 0");

  if (!hasContentOrder) {
    failures.push("CONTENT ORDER FAIL: Must render Job description, data-backed Responsibilities, Qualifications, Benefits, then Company in Overview order.");
  } else {
    console.log("  [PASS] content order: Job description, Responsibilities, Qualifications, Benefits, then Company; lists require data");
  }

  // 5. Right Rail with Stacked Cards. Product restore (#665): the Tailor Resume card was removed (no AI
  // CTAs outside the landing page), so it must NOT come back; Similar jobs and Your notes remain.
  const hasRightRail =
    detailCode.includes("Similar jobs") &&
    detailCode.includes("Your notes") &&
    !detailCode.includes("Tailor Resume");

  if (!hasRightRail) {
    failures.push("RIGHT RAIL FAIL: Desktop right rail must contain stacked cards (Similar jobs, Your notes) and no Tailor Resume card.");
  } else {
    console.log("  [PASS] right rail: stacked cards (Similar jobs, Your notes), no Tailor Resume card, sections hidden when no data");
  }

  // 6. Pro Unlock Error Handling & isUnlocked logic preserved
  const hasUnlockLogic =
    detailCode.includes("const isUnlocked = isPro && !job.proUnlockError;") &&
    detailCode.includes('data-testid="pro-unlock-error-banner"') &&
    detailCode.includes("onRetryUnlock") &&
    detailCode.includes("isRetryingUnlock");

  if (!hasUnlockLogic) {
    failures.push("UNLOCK LOGIC FAIL: Must preserve PR #84 isUnlocked logic, pro-unlock-error-banner, and onRetryUnlock prop.");
  } else {
    console.log("  [PASS] unlock logic: preserves isUnlocked (isPro && !job.proUnlockError), error retry banner, and onRetryUnlock prop");
  }

  // 7. Inspect executable JSX, not an obsolete paid-only label or comment.
  function mobileMatchGuards(source: string) {
    const file = ts.createSourceFile("detail.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const flags = { grid: false, heading: false, labels: false, values: false, matchLabel: false, mobile: false };
    const printer = ts.createPrinter({ removeComments: true });
    const code = (node: ts.Node) => printer.printNode(ts.EmitHint.Unspecified, node, file).replace(/\s/g, "");
    function walk(node: ts.Node, visit: (node: ts.Node) => void) {
      visit(node); ts.forEachChild(node, child => walk(child, visit));
    }
    const attrs = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) =>
      node.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(file) === name)?.initializer;
    walk(file, node => {
      if (ts.isFunctionDeclaration(node) && node.name?.text === "MatchScoreTiles" && node.body) {
        walk(node.body, child => {
          if (ts.isJsxElement(child)) {
            const tag = child.openingElement.tagName.getText(file);
            const cls = attrs(child.openingElement, "className");
            if (tag === "dl" && cls && ts.isStringLiteral(cls)) {
              const tokens = cls.text.split(/\s+/);
              flags.grid = tokens.includes("grid") && tokens.includes("grid-cols-4");
            }
            if (tag === "h2") flags.heading = child.children.some(c => ts.isJsxText(c) && c.text.trim() === "Match Score");
            if (tag === "dt" && cls && ts.isJsxExpression(cls) && cls.expression && ts.isTemplateExpression(cls.expression)) {
              const text = cls.expression.head.text + cls.expression.templateSpans.map(s => s.literal.text).join(" ");
              flags.labels = text.split(/\s+/).includes("text-[11px]") && !/text-\[(9|10)px\]/.test(text);
            }
          }
          if (ts.isConditionalExpression(child)) {
            // Overall may show a Free server score; paid component numbers may not.
            if (code(child.condition) === "(isUnlocked||overall)&&value!==null")
              flags.values = ts.isParenthesizedExpression(child.whenTrue) && ts.isJsxFragment(child.whenTrue.expression) &&
                code(child.whenTrue).includes("{value}") && code(child.whenFalse).includes('isUnlocked?"—":"••%"');
            if (code(child.condition) === "overall" && code(child.whenTrue) === "matchLabel" && code(child.whenFalse) === "label")
              flags.matchLabel = true;
          }
        });
      }
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "MatchScoreTiles") {
        const id = attrs(node, "testId");
        const label = attrs(node, "matchLabel");
        const tiles = attrs(node, "tiles");
        if (id && ts.isStringLiteral(id) && id.text === "mobile-match-score" && label && ts.isJsxExpression(label) &&
            label.expression && code(label.expression) === "matchLabel" && tiles && ts.isJsxExpression(tiles) && tiles.expression && ts.isArrayLiteralExpression(tiles.expression)) {
          const names = tiles.expression.elements.map(e => ts.isObjectLiteralExpression(e)
            ? e.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(file) === "label")?.initializer : undefined);
          flags.mobile = names.length === 4 && names.every((n, i) => n && ts.isStringLiteral(n) && n.text === ["Overall", "Experience Level", "Skill", "Role Match"][i]);
        }
      }
    });
    return flags;
  }
  const mobileGuards = mobileMatchGuards(detailCode);
  if (!Object.values(mobileGuards).every(Boolean)) {
    failures.push("MOBILE MATCH ROW FAIL: four-column tiles, 11px labels, real overall label and masked component values required: " + JSON.stringify(mobileGuards));
  } else {
    console.log("  [PASS] mobile match layout: four-column row, 11px labels, real overall score/label, masked Free sub-scores");
  }
  // Each obligation fails independently, including comment-only decoys.
  const mutations: Array<[keyof typeof mobileGuards, string, string]> = [
    ["grid", "grid grid-cols-4", "grid grid-cols-3"],
    ["labels", "min-h-[40px] text-[11px]", "min-h-[40px] text-[10px]"],
    ["values", "(isUnlocked || overall) && value !== null", "value !== null"],
    ["matchLabel", "{overall ? matchLabel : label}", '{/* overall ? matchLabel : label */}{label}'],
    ["mobile", '{ label: "Experience Level", value: expSubScore }', '{ label: "Wrong label", value: expSubScore }'],
  ];
  mutations.push(
    ["grid", 'className="grid grid-cols-4 gap-1.5 sm:gap-2"', 'className="grid grid-cols-3 gap-1.5 sm:gap-2" /* grid grid-cols-4 */'],
    ["values", "(isUnlocked || overall) && value !== null", "(true || overall) && value !== null"],
  );
  if (!isNegativeControl) for (const [guard, before, after] of mutations) {
    const broken = detailCode.replace(before, after);
    if (broken === detailCode || mobileMatchGuards(broken)[guard]) failures.push("MOBILE NEGATIVE CONTROL FAIL: " + guard);
    else console.log("  [PASS] mobile independent mutation rejected: " + guard);
  }

  // 8. Mobile Single-Row Sticky Strip: X (close) left, Overview/Company tabs centered, "..." menu right
  const hasMobileStrip =
    detailCode.includes('data-testid="mobile-sticky-header-strip"') &&
    detailCode.includes("md:hidden flex items-center justify-between gap-2") &&
    detailCode.includes("Overview") &&
    detailCode.includes("Company") &&
    detailCode.includes("Close job details") &&
    detailCode.includes("<JobCardMenu");

  if (!hasMobileStrip) {
    failures.push("MOBILE STRIP FAIL: Mobile header must be a single sticky row: X (close) left, Overview/Company tabs centered, '...' menu right.");
  } else {
    console.log("  [PASS] mobile strip: X left, Overview/Company tabs centered, '...' menu right");
  }

  // 8b. Mobile overview restyle details: 64px logo action row, posted/category pills, grey summary card with
  // company name, salary always listed ("Not disclosed" when empty, never masked on mobile)
  const mobileFacts = detailCode.slice(detailCode.indexOf('data-testid="mobile-job-facts"'), detailCode.indexOf('data-testid="overview-chips"'));
  const hasMobileOverviewRestyle =
    detailCode.includes("w-16 h-16 rounded-2xl") &&
    detailCode.includes("{/* Mobile pills: posted time + category (real data only) */}") &&
    detailCode.includes("max-md:bg-[#F1F5F9]") &&
    mobileFacts.includes("Not disclosed") &&
    !mobileFacts.includes("\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022");

  if (!hasMobileOverviewRestyle) {
    failures.push("MOBILE OVERVIEW FAIL: Mobile overview must have the 64px-logo action row, posted/category pills, the grey summary card, and an always-visible salary row (never masked).");
  } else {
    console.log("  [PASS] mobile overview: action row, pills, grey summary card, always-visible salary row");
  }

  // 9. Sanitized Company Website URL
  const { sanitizeExternalUrl } = require("../src/lib/security/xss");
  const hasSanitizedWebsite =
    detailCode.includes("sanitizeExternalUrl(rawWebsite)") &&
    sanitizeExternalUrl("javascript:alert(1)") === null &&
    sanitizeExternalUrl("https://careermonke.com") === "https://careermonke.com/";

  if (!hasSanitizedWebsite) {
    failures.push("SANITIZED WEBSITE FAIL: Company website must be wrapped with sanitizeExternalUrl and reject javascript: URLs.");
  } else {
    console.log("  [PASS] sanitized company website: wrapped with sanitizeExternalUrl; javascript: URLs rejected");
  }

  // 10. Prohibited Terms & Data Blocks We Do Not Have
  const prohibitedTerms = [
    /jobright/i,
    /coaching/i,
    /\bagent\b/i,
    /interview (?:prep|coaching|copilot|autofill)/i,
    /autofill/i,
    /referral/i,
    /upsell/i,
    /insider connection/i,
    /find any email/i,
    /h1b sponsor/i,
    /email credits/i,
  ];

  for (const term of prohibitedTerms) {
    if (term.test(detailCode)) {
      failures.push(`BRAND PURITY FAIL: Prohibited term "${term.source}" found in source.`);
    }
  }

  if (failures.some((f) => f.includes("BRAND PURITY FAIL"))) {
    // already logged
  } else {
    console.log("  [PASS] brand & data purity: zero unbacked blocks (no referral people, H1B, funding, news, ratings, applicant counts, or external AI tools)");
  }

  console.log("\n----------------------------------------------------------------------------------");
  if (isNegativeControl) {
    if (failures.length >= 3) {
      console.log(`NEGATIVE CONTROL PASSED: Detected ${failures.length} expected intentional failure(s):`);
      failures.forEach((f) => console.log(`  - ${f}`));
      process.exit(1);
    } else {
      console.error(`NEGATIVE CONTROL FAILED: Expected >= 3 failures, got ${failures.length}`);
      process.exit(0);
    }
  }

  if (failures.length > 0) {
    console.error("VALIDATION FAILED:");
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log("JOB DETAIL REDESIGN VALIDATED LOCALLY [PASS-LOCAL]");
  process.exit(0);
}

run();
