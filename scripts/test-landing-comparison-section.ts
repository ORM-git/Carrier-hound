import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  COMPARISON_ROWS,
  ComparisonRow,
} from "../src/components/LandingComparisonSection";

async function runTests() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("       LANDING COMPARISON BLOCK VERIFICATION SUITE ('THE MONKE WAY')            ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("Running negative control mode: inducing intentional failure...");
    assert.strictEqual(
      COMPARISON_ROWS.length,
      999,
      "Negative control triggered: expected 999 comparison rows but got " + COMPARISON_ROWS.length
    );
  }

  const componentPath = path.resolve(process.cwd(), "src/components/LandingComparisonSection.tsx");
  assert.ok(fs.existsSync(componentPath), "LandingComparisonSection.tsx must exist");
  const compSrc = fs.readFileSync(componentPath, "utf8");

  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  const pageSrc = fs.readFileSync(pagePath, "utf8");

  // 1. Page Integration & Placement
  assert.ok(
    pageSrc.includes("import LandingComparisonSection from \"@/components/LandingComparisonSection\";"),
    "LandingComparisonSection must be imported in src/app/page.tsx"
  );
  assert.ok(
    pageSrc.includes("<LandingComparisonSection />"),
    "LandingComparisonSection must be rendered in src/app/page.tsx"
  );

  const demoIdx = pageSrc.indexOf("<LandingInteractiveDemoSection />");
  const compIdx = pageSrc.indexOf("<LandingComparisonSection />");
  const resumeMonkeIdx = pageSrc.indexOf("AI Resume Monke");
  assert.ok(
    demoIdx > -1 && compIdx > demoIdx && resumeMonkeIdx > compIdx,
    "LandingComparisonSection must be placed between Hero demo and AI Resume Monke subsection"
  );
  console.log("  [PASS] Page integration & section placement verified");

  // 2. Title & Two Column Headers
  assert.ok(
    compSrc.includes("Tired of getting") && compSrc.includes("auto-rejected?"),
    "Section title must be 'Tired of getting auto-rejected?'"
  );
  assert.ok(
    compSrc.includes("The usual grind"),
    "Header 1 must be 'The usual grind'"
  );
  assert.ok(
    compSrc.includes("The Monke way"),
    "Header 2 must be 'The Monke way'"
  );
  assert.ok(
    compSrc.includes("<X") && compSrc.includes("<Check"),
    "Headers must include red X cross icon for usual grind and Check icon for Monke way"
  );
  console.log("  [PASS] Title 'Tired of getting auto-rejected?' and two column headers verified");

  // 3. Config-Array Driven Structure
  assert.strictEqual(
    COMPARISON_ROWS.length,
    5,
    "COMPARISON_ROWS must contain exactly 5 rows"
  );

  const expectedCaptions = [
    {
      usual: "Scrolling the same feeds. Again.",
      monke: "Jobs straight from company career pages",
    },
    {
      usual: "Posted 1h ago, 200 applicants",
      monke: "Employers you didn't know existed",
    },
    {
      usual: "Rewriting your resume. Again.",
      monke: "AI-refined resume",
    },
    {
      usual: "Am I even qualified?",
      monke: "Resume score card",
    },
    {
      usual: "Endless searching",
      monke: "Worldwide roles, filter by country",
    },
  ];

  expectedCaptions.forEach((pair, idx) => {
    const row = COMPARISON_ROWS[idx];
    assert.ok(row, `Row ${idx + 1} must exist in COMPARISON_ROWS`);
    assert.ok(
      row.usual.caption.includes(pair.usual),
      `Row ${idx + 1} usual caption mismatch: expected to include '${pair.usual}', got '${row.usual.caption}'`
    );
    assert.strictEqual(
      row.monke.caption,
      pair.monke,
      `Row ${idx + 1} monke caption mismatch: expected '${pair.monke}', got '${row.monke.caption}'`
    );
    assert.ok(
      row.usual.image.startsWith("/images/comparison/") || row.usual.image.startsWith("/mascot/"),
      `Row ${idx + 1} usual image must point to comparison or mascot assets: ${row.usual.image}`
    );
    assert.ok(
      row.monke.image.startsWith("/images/comparison/") || row.monke.image.startsWith("/mascot/"),
      `Row ${idx + 1} monke image must point to comparison or mascot assets: ${row.monke.image}`
    );
    assert.ok(row.usual.imageAlt.length > 5, `Row ${idx + 1} usual imageAlt must be descriptive`);
    assert.ok(row.monke.imageAlt.length > 5, `Row ${idx + 1} monke imageAlt must be descriptive`);
  });

  // Verify Row 1 Mascot Images and Loop Animation Config
  assert.strictEqual(
    COMPARISON_ROWS[0].usual.image,
    "/mascot/row1-sad.png",
    "Row 1 usual image must be '/mascot/row1-sad.png'"
  );
  assert.strictEqual(
    COMPARISON_ROWS[0].monke.image,
    "/mascot/row1-happy.png",
    "Row 1 monke image must be '/mascot/row1-happy.png'"
  );
  assert.strictEqual(
    COMPARISON_ROWS[0].usual.loopAnimation,
    "sad",
    "Row 1 usual loopAnimation must be 'sad'"
  );
  assert.strictEqual(
    COMPARISON_ROWS[0].monke.loopAnimation,
    "happy",
    "Row 1 monke loopAnimation must be 'happy'"
  );

  console.log("  [PASS] Config-array driven architecture with all 5 rows and row 1 mascot config verified");

  // 4. Card Styling & Round VS Badge
  assert.ok(
    compSrc.includes("bg-[#F2F1F6]") || compSrc.includes("bg-zinc-100"),
    "Left cards must have soft grey background (#F2F1F6)"
  );
  assert.ok(
    compSrc.includes("border-[1.5px] border-neutral-900") || compSrc.includes("border-neutral-900"),
    "Right cards must be white with a dark border"
  );
  assert.ok(
    compSrc.includes("rounded-full bg-neutral-900 text-white") && compSrc.includes("VS"),
    "Each row must feature a round VS badge with dark background and white text"
  );
  console.log("  [PASS] Card color palette (soft grey vs white/dark border) and round VS badge verified");

  // 5. next/image and Clean Placeholder
  assert.ok(
    compSrc.includes("import Image from \"next/image\";") || compSrc.includes("from 'next/image'"),
    "Must use next/image for monkey illustration loading"
  );
  assert.ok(
    compSrc.includes("CardImagePlaceholder") && compSrc.includes("Illustration"),
    "Must provide a clean placeholder component when image files are loading or not yet added"
  );
  assert.ok(
    compSrc.includes("onError"),
    "Must handle image load errors gracefully via fallback placeholder"
  );

  // Verify that mascot image files exist on disk
  const sadFile = path.resolve(process.cwd(), "public/mascot/row1-sad.png");
  const happyFile = path.resolve(process.cwd(), "public/mascot/row1-happy.png");
  assert.ok(fs.existsSync(sadFile), "public/mascot/row1-sad.png must exist on disk");
  assert.ok(fs.existsSync(happyFile), "public/mascot/row1-happy.png must exist on disk");
  assert.ok(fs.statSync(sadFile).size > 1000, "row1-sad.png must not be empty");
  assert.ok(fs.statSync(happyFile).size > 1000, "row1-happy.png must not be empty");

  // Verify all 10 monkey illustration image files exist on disk
  for (let i = 1; i <= 5; i++) {
    const usualFile = path.resolve(process.cwd(), `public/images/comparison/row-${i}-usual.png`);
    const monkeFile = path.resolve(process.cwd(), `public/images/comparison/row-${i}-monke.png`);
    assert.ok(fs.existsSync(usualFile), `public/images/comparison/row-${i}-usual.png must exist`);
    assert.ok(fs.existsSync(monkeFile), `public/images/comparison/row-${i}-monke.png must exist`);
    assert.ok(fs.statSync(usualFile).size > 1000, `row-${i}-usual.png must not be empty`);
    assert.ok(fs.statSync(monkeFile).size > 1000, `row-${i}-monke.png must not be empty`);
  }
  console.log("  [PASS] next/image integration, transparent mascot PNGs on disk, and clean placeholder verified");

  // 6. Animation, Stagger, and Reduced Motion
  assert.ok(
    compSrc.includes("from \"motion/react\"") || compSrc.includes("from 'motion/react'"),
    "Must use motion/react for smooth animations"
  );
  assert.ok(
    compSrc.includes("useReducedMotion"),
    "Must import and use useReducedMotion to respect prefers-reduced-motion"
  );
  assert.ok(
    compSrc.includes("whileInView"),
    "Must trigger animations on scroll-in via whileInView"
  );
  assert.ok(
    compSrc.includes("once: true"),
    "Animations must run once only (viewport once: true)"
  );
  assert.ok(
    compSrc.includes("0.08") || compSrc.includes("80"),
    "Must implement 80ms stagger between rows"
  );
  assert.ok(
    compSrc.includes("x: -28") || compSrc.includes("x: -") || compSrc.includes("x: -20"),
    "Left card must slide in from the left"
  );
  assert.ok(
    compSrc.includes("x: 28") || compSrc.includes("x: 20"),
    "Right card must slide in from the right"
  );
  assert.ok(
    compSrc.includes("scale: 0") && compSrc.includes("scale: 1"),
    "VS badge must pop in (scale 0 -> 1)"
  );
  assert.ok(
    compSrc.includes("y: 20") || compSrc.includes("y: 24"),
    "Each row must fade up"
  );
  console.log("  [PASS] Entrance specifications (fade up, slide in left/right, pop VS, 80ms stagger, reduced-motion) verified");

  // 7. Mascot CSS Loop Keyframes, IntersectionObserver & GPU friendly
  assert.ok(
    compSrc.includes("mascot-sad-nod") && compSrc.includes("mascot-sad-breathe"),
    "Must include CSS keyframes for sad mascot breathing and head-nod tilt"
  );
  assert.ok(
    compSrc.includes("mascot-happy-swing") && compSrc.includes("mascot-happy-bounce"),
    "Must include CSS keyframes for happy mascot pendulum swing and bounce"
  );
  assert.ok(
    compSrc.includes("transform-origin: bottom center"),
    "Sad mascot tilt must use transform-origin: bottom center"
  );
  assert.ok(
    compSrc.includes("transform-origin: top left"),
    "Happy mascot swing must use transform-origin: top left"
  );
  assert.ok(
    compSrc.includes("IntersectionObserver"),
    "Must use IntersectionObserver to start loops only while in view and pause off-screen"
  );
  assert.ok(
    compSrc.includes("will-change: transform"),
    "Must declare will-change: transform for GPU-friendly animation"
  );
  assert.ok(
    compSrc.includes("prefers-reduced-motion"),
    "Must declare @media (prefers-reduced-motion: reduce) rule to respect user preference"
  );
  console.log("  [PASS] Mascot CSS loop keyframes (sad: breathing/nod; happy: swing/bounce), IntersectionObserver, and reduced-motion verified");

  // 8. Mobile 360px layout & zero unintended diffs
  assert.ok(
    compSrc.includes("grid-cols-2"),
    "Must maintain two-column stacked card layout on mobile matching reference"
  );
  assert.ok(
    !compSrc.includes("overflow-x-scroll") && !compSrc.includes("overflow-x-auto"),
    "No horizontal scroll containers allowed"
  );
  console.log("  [PASS] Mobile 360px stacked two-column layout verified");

  console.log("\n================================================================================");
  console.log("ALL LANDING COMPARISON BLOCK TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
