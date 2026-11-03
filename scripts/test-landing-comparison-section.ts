import assert from "assert";
import * as fs from "fs";
import * as path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { spawnSync } from "child_process";
import LandingComparisonSection from "../src/components/LandingComparisonSection";

async function runTests() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("       LANDING COMPARISON BLOCK VERIFICATION SUITE (GIF ARTWORK ONLY)           ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL MODE] Inducing intentional assertion failure...");
    assert.strictEqual(
      "real",
      "intentional-mismatch",
      "Negative control triggered: expected intentional failure"
    );
    return;
  }

  // 1. Verify component source exists and does not contain old row/placeholder/badge code
  console.log("Test 1: Inspecting src/components/LandingComparisonSection.tsx source...");
  const componentPath = path.resolve(process.cwd(), "src/components/LandingComparisonSection.tsx");
  assert.ok(fs.existsSync(componentPath), "LandingComparisonSection.tsx must exist");
  const compSrc = fs.readFileSync(componentPath, "utf8");

  // Removed old code assertions
  assert.ok(!compSrc.includes("COMPARISON_ROWS"), "Old COMPARISON_ROWS array must be removed");
  assert.ok(!compSrc.includes("CardImagePlaceholder"), "CardImagePlaceholder must be removed");
  assert.ok(!compSrc.includes("ComparisonRowItem"), "ComparisonRowItem must be removed");
  assert.ok(!compSrc.includes("ComparisonCardImage"), "ComparisonCardImage must be removed");
  assert.ok(!compSrc.includes("mascot-sad"), "Old mascot CSS keyframes must be removed");
  assert.ok(!compSrc.includes("mascot-happy"), "Old mascot CSS keyframes must be removed");
  assert.ok(!compSrc.includes("Tired of getting"), "Old heading text must be removed");
  assert.ok(!compSrc.includes("careermonke.com"), "Old footer text must be removed");
  console.log("  -> [PASS-LOCAL] Old tiles, rows, placeholders, keyframes, and headings removed from component source.");

  // 2. Rendered Static Markup Assertions
  console.log("\nTest 2: Verifying rendered HTML markup of LandingComparisonSection...");
  const renderedHtml = renderToStaticMarkup(React.createElement(LandingComparisonSection));

  // Assert exact image attributes
  assert.ok(renderedHtml.includes('src="/careermonke-comparison-boxes.gif"'), "Must render exact src '/careermonke-comparison-boxes.gif'");
  assert.ok(
    renderedHtml.includes('alt="The usual grind vs the Monke way: five comparisons"'),
    "Must render exact alt 'The usual grind vs the Monke way: five comparisons'"
  );
  assert.ok(renderedHtml.includes('width="728"'), "Must render width 728");
  assert.ok(renderedHtml.includes('height="900"'), "Must render height 900");
  assert.ok(renderedHtml.includes('loading="lazy"'), "Must render loading='lazy'");
  assert.ok(renderedHtml.includes('decoding="async"'), "Must render decoding='async'");

  // Assert wrapper styling: centered, w-full, max-w-[560px], px-4 on mobile
  assert.ok(renderedHtml.includes("w-full"), "Wrapper must have w-full");
  assert.ok(renderedHtml.includes("max-w-[560px]"), "Wrapper must have max-w-[560px]");
  assert.ok(renderedHtml.includes("mx-auto"), "Wrapper must be centered with mx-auto");
  assert.ok(renderedHtml.includes("px-4"), "Wrapper must have px-4 horizontal padding");

  // Assert NO heading, NO footer text, NO card, NO border, NO shadow, NO background, NO VS badges, NO extra text
  assert.ok(!/<h[1-6]/i.test(renderedHtml), "Must contain NO heading tags (<h1..h6>)");
  assert.ok(!/<p[\s>]/i.test(renderedHtml), "Must contain NO paragraph (<p>) tags");
  const htmlWithoutImg = renderedHtml.replace(/<img[^>]*>/g, "");
  assert.ok(!htmlWithoutImg.includes("The usual grind"), "Must contain NO text 'The usual grind' outside img alt");
  assert.ok(!htmlWithoutImg.includes("The Monke way"), "Must contain NO text 'The Monke way' outside img alt");
  assert.ok(!renderedHtml.includes("VS"), "Must contain NO VS badges");
  assert.ok(!renderedHtml.includes("Illustration"), "Must contain NO footer illustration labels");
  assert.ok(!renderedHtml.includes("border"), "Must contain NO border classes");
  assert.ok(!renderedHtml.includes("shadow"), "Must contain NO shadow classes");
  assert.ok(!renderedHtml.includes("bg-"), "Must contain NO background classes");

  // Verify only 1 img element rendered
  const imgMatches = renderedHtml.match(/<img\b/g);
  assert.strictEqual(imgMatches?.length, 1, "Must render exactly ONE image element");
  console.log("  -> [PASS-LOCAL] Rendered markup contains solely the comparison image with correct attributes and clean wrapper.");

  // 3. GIF Asset Verification
  console.log("\nTest 3: Verifying public/careermonke-comparison-boxes.gif asset on disk...");
  const gifPath = path.resolve(process.cwd(), "public/careermonke-comparison-boxes.gif");
  assert.ok(fs.existsSync(gifPath), "public/careermonke-comparison-boxes.gif must exist");
  const gifStat = fs.statSync(gifPath);
  assert.ok(gifStat.size > 1000000, `GIF size must be substantial (>1MB). Actual: ${gifStat.size} bytes`);

  // Verify GIF89a header
  const gifBuffer = fs.readFileSync(gifPath);
  const gifHeader = gifBuffer.subarray(0, 6).toString("ascii");
  assert.ok(gifHeader === "GIF89a" || gifHeader === "GIF87a", `Asset must be valid GIF format (header: ${gifHeader})`);

  // Verify dimensions from GIF logical screen descriptor (bytes 6-9 in little endian)
  const logicalWidth = gifBuffer.readUInt16LE(6);
  const logicalHeight = gifBuffer.readUInt16LE(8);
  assert.strictEqual(logicalWidth, 728, `GIF width must be 728 (actual: ${logicalWidth})`);
  assert.strictEqual(logicalHeight, 900, `GIF height must be 900 (actual: ${logicalHeight})`);
  console.log(`  -> [PASS-LOCAL] GIF file confirmed valid: 728x900 pixels, ${(gifStat.size / (1024 * 1024)).toFixed(2)} MB.`);

  // 4. Mascot Assets Preservation (do not delete public/mascot files)
  console.log("\nTest 4: Verifying public/mascot/ files were preserved...");
  const mascotDir = path.resolve(process.cwd(), "public/mascot");
  assert.ok(fs.existsSync(mascotDir), "public/mascot directory must exist");
  const expectedMascotFiles = [
    "row1-sad.png", "row1-happy.png",
    "row2-sad.png", "row2-happy.png",
    "row3-sad.png", "row3-happy.png",
    "row4-sad.png", "row4-happy.png",
    "row5-sad.png", "row5-happy.png",
  ];
  for (const file of expectedMascotFiles) {
    const filePath = path.join(mascotDir, file);
    assert.ok(fs.existsSync(filePath), `Mascot file ${file} must remain preserved`);
  }
  console.log("  -> [PASS-LOCAL] All 10 public/mascot files preserved.");

  // 5. Page Integration & Placement in src/app/page.tsx
  console.log("\nTest 5: Verifying slot placement in src/app/page.tsx...");
  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  const pageSrc = fs.readFileSync(pagePath, "utf8");

  assert.ok(
    pageSrc.includes('import LandingComparisonSection from "@/components/LandingComparisonSection";'),
    "src/app/page.tsx must import LandingComparisonSection"
  );
  assert.ok(
    pageSrc.includes("<LandingComparisonSection />"),
    "src/app/page.tsx must render <LandingComparisonSection />"
  );

  const tickerIdx = pageSrc.indexOf("<LandingJobsTickerStrip />");
  const compIdx = pageSrc.indexOf("<LandingComparisonSection />");
  const globeIdx = pageSrc.indexOf("Global map / radar");

  assert.ok(tickerIdx > -1, "Jobs ticker strip must exist in page.tsx");
  assert.ok(compIdx > -1, "Comparison section must exist in page.tsx");
  assert.ok(globeIdx > -1, "Global coverage section must exist in page.tsx");
  assert.ok(
    tickerIdx < compIdx && compIdx < globeIdx,
    "LandingComparisonSection must be placed strictly after LandingJobsTickerStrip and before global coverage section"
  );
  console.log("  -> [PASS-LOCAL] Placement in src/app/page.tsx strictly verified in original slot.");

  // 6. Negative Control Subprocess Execution
  console.log("\nTest 6: Executing negative control subprocess to verify non-zero exit code...");
  const negResult = spawnSync(process.execPath, ["-r", "tsx", __filename, "--negative-control"], {
    encoding: "utf-8",
    env: process.env,
  });

  assert.notStrictEqual(
    negResult.status,
    0,
    "Negative control MUST fail and exit with non-zero status code!"
  );
  console.log(`  -> [PASS-LOCAL] Negative control correctly exited with status code ${negResult.status}.`);

  console.log("\n================================================================================");
  console.log("ALL LANDING COMPARISON SECTION TESTS PASSED SUCCESSFULLY [PASS-LOCAL]");
  console.log("================================================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
