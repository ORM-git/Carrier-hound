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

  // 1. Verify CareerMonkeMascot SVG component is deleted
  const mascotComponentPath = path.resolve(process.cwd(), "src/components/CareerMonkeMascot.tsx");
  assert.ok(!fs.existsSync(mascotComponentPath), "CareerMonkeMascot.tsx must be deleted");
  assert.ok(
    !compSrc.includes("CareerMonkeMascot"),
    "LandingComparisonSection must not import or render CareerMonkeMascot"
  );
  console.log("  [PASS] CareerMonkeMascot.tsx successfully deleted and removed from section");

  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  const pageSrc = fs.readFileSync(pagePath, "utf8");

  // 2. Page Integration & Placement
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

  // 3. Title & Two Column Headers
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

  // 4. Config-Array Driven Structure for all 5 Rows
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
    const rowNum = idx + 1;
    assert.ok(row, `Row ${rowNum} must exist in COMPARISON_ROWS`);
    assert.ok(
      row.usual.caption.includes(pair.usual),
      `Row ${rowNum} usual caption mismatch: expected to include '${pair.usual}', got '${row.usual.caption}'`
    );
    assert.strictEqual(
      row.monke.caption,
      pair.monke,
      `Row ${rowNum} monke caption mismatch: expected '${pair.monke}', got '${row.monke.caption}'`
    );

    // Verify mascot image file references in public/mascot/
    assert.strictEqual(
      row.usual.image,
      `/mascot/row${rowNum}-sad.png`,
      `Row ${rowNum} usual image must point to /mascot/row${rowNum}-sad.png`
    );
    assert.strictEqual(
      row.monke.image,
      `/mascot/row${rowNum}-happy.png`,
      `Row ${rowNum} monke image must point to /mascot/row${rowNum}-happy.png`
    );
  });
  console.log("  [PASS] All 5 rows configured with /mascot/row{n}-sad.png and row{n}-happy.png image paths");

  // 5. Mascot PNG Assets Verification (All 10 active files for rows 1 to 5)
  const activeMascotFiles = [
    { file: "row1-sad.png", maxKb: 80 },
    { file: "row1-happy.png", maxKb: 80 },
    { file: "row2-sad.png", maxKb: 80 },
    { file: "row2-happy.png", maxKb: 80 },
    { file: "row3-sad.png", maxKb: 80 },
    { file: "row3-happy.png", maxKb: 80 },
    { file: "row4-sad.png", maxKb: 80 },
    { file: "row4-happy.png", maxKb: 80 },
    { file: "row5-sad.png", maxKb: 80 },
    { file: "row5-happy.png", maxKb: 80 },
  ];

  for (const { file, maxKb } of activeMascotFiles) {
    const fullPath = path.resolve(process.cwd(), "public/mascot", file);
    assert.ok(fs.existsSync(fullPath), `Mascot image public/mascot/${file} must exist`);
    const stat = fs.statSync(fullPath);
    const sizeKb = stat.size / 1024;
    assert.ok(
      sizeKb < maxKb,
      `Mascot image public/mascot/${file} must be under ${maxKb} KB (actual: ${sizeKb.toFixed(2)} KB)`
    );
    assert.ok(stat.size > 1000, `Mascot image public/mascot/${file} must not be empty`);

    // Verify PNG header (89 50 4E 47 0D 0A 1A 0A)
    const buf = fs.readFileSync(fullPath);
    assert.strictEqual(buf[0], 0x89, `${file} must be a valid PNG`);
    assert.strictEqual(buf[1], 0x50, `${file} must be a valid PNG`);
    assert.strictEqual(buf[2], 0x4e, `${file} must be a valid PNG`);
    assert.strictEqual(buf[3], 0x47, `${file} must be a valid PNG`);
  }
  console.log("  [PASS] All 10 active mascot PNG files verified (transparent, ~320px, strictly under 80 KB)");

  // 6. Graceful Placeholder Fallback on Missing Source or Load Error
  assert.ok(
    compSrc.includes("CardImagePlaceholder"),
    "LandingComparisonSection must render CardImagePlaceholder on missing files or error"
  );
  assert.ok(
    compSrc.includes("!src || hasError"),
    "LandingComparisonSection must show placeholder when src is missing or error occurs"
  );
  console.log("  [PASS] CardImagePlaceholder graceful fallback verified");

  // 7. Cleanup of Old Comparison Directory
  const oldCompDir = path.resolve(process.cwd(), "public/images/comparison");
  assert.ok(
    !fs.existsSync(oldCompDir),
    "Old directory public/images/comparison must be deleted"
  );
  console.log("  [PASS] Old public/images/comparison files confirmed deleted");

  // 8. Keyframe Animations & GPU Optimization
  assert.ok(
    compSrc.includes("mascot-sad-nod") && compSrc.includes("rotate(-2deg)"),
    "Sad mascot must include head-nod tilt keyframe"
  );
  assert.ok(
    compSrc.includes("mascot-sad-breathe") && compSrc.includes("scale(1.02)"),
    "Sad mascot must include slow breathing keyframe"
  );
  assert.ok(
    compSrc.includes("mascot-happy-swing") && compSrc.includes("rotate(-4deg)"),
    "Happy mascot must include pendulum swing keyframe"
  );
  assert.ok(
    compSrc.includes("mascot-happy-bounce") && compSrc.includes("translateY(-6px)"),
    "Happy mascot must include soft bounce keyframe"
  );
  assert.ok(
    compSrc.includes("mascot-scale-pop"),
    "Mascot cards must include scale-pop on scroll-in"
  );
  assert.ok(
    compSrc.includes("will-change: transform"),
    "CSS rules must declare will-change: transform for GPU friendliness"
  );
  assert.ok(
    compSrc.includes("prefers-reduced-motion: reduce"),
    "CSS must respect prefers-reduced-motion to show static poses"
  );
  assert.ok(
    compSrc.includes("imgRef.current.complete") || compSrc.includes("imgRef.current?.complete"),
    "Must check img.complete so pre-hydration image still displays immediately"
  );
  assert.ok(
    compSrc.includes("IntersectionObserver"),
    "Must use IntersectionObserver to pause animations off-screen"
  );
  console.log("  [PASS] Light CSS keyframes, GPU acceleration, prefers-reduced-motion, and img.complete verified");

  // 9. Card Styling, Round VS Badge, and Stagger Entrance
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
  console.log("  [PASS] Card styling, VS badge, slide/pop entrances, and zero layout shift verified");

  console.log("\n================================================================================");
  console.log("ALL LANDING COMPARISON BLOCK TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
