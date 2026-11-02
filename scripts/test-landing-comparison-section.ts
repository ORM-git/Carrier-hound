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

  const mascotComponentPath = path.resolve(process.cwd(), "src/components/CareerMonkeMascot.tsx");
  assert.ok(fs.existsSync(mascotComponentPath), "CareerMonkeMascot.tsx must exist");
  const mascotSrc = fs.readFileSync(mascotComponentPath, "utf8");

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
      monke: "Jobs most people never see",
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
    if (idx > 0) {
      assert.ok(
        row.usual.image?.startsWith("/images/comparison/"),
        `Row ${idx + 1} usual image must point to comparison assets: ${row.usual.image}`
      );
      assert.ok(
        row.monke.image?.startsWith("/images/comparison/"),
        `Row ${idx + 1} monke image must point to comparison assets: ${row.monke.image}`
      );
    }
  });

  // Verify Row 1 Code-Driven SVG Mascot Config
  assert.strictEqual(
    COMPARISON_ROWS[0].usual.mascotMood,
    "sad",
    "Row 1 usual mascotMood must be 'sad'"
  );
  assert.strictEqual(
    COMPARISON_ROWS[0].monke.mascotMood,
    "happy",
    "Row 1 monke mascotMood must be 'happy'"
  );
  assert.strictEqual(
    COMPARISON_ROWS[0].monke.caption,
    "Jobs most people never see",
    "Row 1 right caption must be 'Jobs most people never see'"
  );

  console.log("  [PASS] Config-array driven architecture with all 5 rows and row 1 mascot config verified");

  // 4. CareerMonkeMascot SVG Component Architecture
  const requiredSvgGroups = [
    'id="head"',
    'id="hair"',
    'id="sunglasses"',
    'id="eyebrows"',
    'id="mouth"',
    'id="ears"',
    'id="body-hoodie"',
    'id="arms"',
  ];
  requiredSvgGroups.forEach((group) => {
    assert.ok(
      mascotSrc.includes(group),
      `CareerMonkeMascot must include SVG group <g ${group}>`
    );
  });

  // Props check
  assert.ok(
    mascotSrc.includes('mood') && mascotSrc.includes('"sad"') && mascotSrc.includes('"happy"') && mascotSrc.includes('"neutral"') && mascotSrc.includes('"surprised"'),
    "CareerMonkeMascot must accept mood prop ('sad' | 'neutral' | 'happy' | 'surprised')"
  );
  assert.ok(mascotSrc.includes("size"), "CareerMonkeMascot must accept size prop");
  assert.ok(mascotSrc.includes("loop"), "CareerMonkeMascot must accept loop prop");

  // Visual traits check
  assert.ok(
    mascotSrc.includes("#4B5563") || mascotSrc.includes("grey") || mascotSrc.includes("#374151"),
    "Mascot must use grey hoodie for sad mood"
  );
  assert.ok(
    mascotSrc.includes("#2563EB"),
    "Mascot must use brand blue #2563EB hoodie for happy mood"
  );
  assert.ok(
    mascotSrc.includes("#FED7AA") || mascotSrc.includes("#FDBA74"),
    "Mascot must use tan skin color"
  );

  // Animations check
  assert.ok(
    mascotSrc.includes("cm-hair-wobble") || mascotSrc.includes("hair-wobble"),
    "Mascot must include idle hair wobble keyframes"
  );
  assert.ok(
    mascotSrc.includes("cm-blink") || mascotSrc.includes("blink"),
    "Mascot must include periodic eyelid blink over glasses"
  );
  assert.ok(
    mascotSrc.includes("cm-sad-breathe") && mascotSrc.includes("cm-sad-head-tilt"),
    "Sad mascot must include slow breathing and head-nod tilt animations"
  );
  assert.ok(
    mascotSrc.includes("cm-float-z") || mascotSrc.includes("effects-sad-zzz"),
    "Sad mascot must include floating 'z z' elements"
  );
  assert.ok(
    mascotSrc.includes("cm-happy-head-bob") && mascotSrc.includes("cm-glasses-bounce"),
    "Happy mascot must include quick head bob and glasses bounce animations"
  );
  assert.ok(
    mascotSrc.includes("cm-sparkle") || mascotSrc.includes("effects-happy"),
    "Happy mascot must include small sparkles"
  );
  assert.ok(
    mascotSrc.includes("cm-spring-bounce") || mascotSrc.includes("spring-bounce"),
    "Mascot must support spring bounce transition on scroll-in"
  );
  assert.ok(
    mascotSrc.includes("prefers-reduced-motion"),
    "Mascot must respect prefers-reduced-motion for static rendering"
  );
  assert.ok(
    mascotSrc.includes("willChange") || mascotSrc.includes("will-change"),
    "Mascot must declare will-change: transform for GPU acceleration"
  );
  console.log("  [PASS] CareerMonkeMascot SVG groups, moods, animations, and GPU performance verified");

  // 5. Verification of Deleted Unused Files & Remaining Image Assets
  const deletedUsual = path.resolve(process.cwd(), "public/images/comparison/row-1-usual.png");
  const deletedMonke = path.resolve(process.cwd(), "public/images/comparison/row-1-monke.png");
  assert.ok(!fs.existsSync(deletedUsual), "public/images/comparison/row-1-usual.png must be deleted");
  assert.ok(!fs.existsSync(deletedMonke), "public/images/comparison/row-1-monke.png must be deleted");

  // Verify rows 2 to 5 images still exist on disk
  for (let i = 2; i <= 5; i++) {
    const usualFile = path.resolve(process.cwd(), `public/images/comparison/row-${i}-usual.png`);
    const monkeFile = path.resolve(process.cwd(), `public/images/comparison/row-${i}-monke.png`);
    assert.ok(fs.existsSync(usualFile), `public/images/comparison/row-${i}-usual.png must exist`);
    assert.ok(fs.existsSync(monkeFile), `public/images/comparison/row-${i}-monke.png must exist`);
    assert.ok(fs.statSync(usualFile).size > 1000, `row-${i}-usual.png must not be empty`);
    assert.ok(fs.statSync(monkeFile).size > 1000, `row-${i}-monke.png must not be empty`);
  }
  console.log("  [PASS] Deleted row-1 unused PNGs and verified remaining row 2-5 assets");

  // 6. Card Styling, Round VS Badge, and Stagger Entrance
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
  assert.ok(
    compSrc.includes("x: -28") && compSrc.includes("x: 28"),
    "Left card must slide from left, right card from right"
  );
  assert.ok(
    compSrc.includes("scale: 0") && compSrc.includes("scale: 1"),
    "VS badge must pop in (scale 0 -> 1)"
  );
  assert.ok(
    compSrc.includes("IntersectionObserver"),
    "Must use IntersectionObserver to pause loops off-screen"
  );
  console.log("  [PASS] Card styling, VS badge, slide/pop entrances, and IntersectionObserver verified");

  // 7. Mobile 360px layout & zero unintended diffs
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
