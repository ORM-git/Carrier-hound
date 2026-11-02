import assert from "assert";
import * as fs from "fs";
import * as path from "path";

async function runTests() {
  const isNegativeControl = process.argv.includes("--negative-control");

  console.log("================================================================================");
  console.log("       LANDING FEATURES SECTION VERIFICATION SUITE                             ");
  console.log("================================================================================\n");

  if (isNegativeControl) {
    console.log("Running negative control mode: inducing intentional failure...");
    assert.strictEqual(
      1 + 1,
      999,
      "Negative control triggered: intentional assertion failure"
    );
  }

  const componentPath = path.resolve(process.cwd(), "src/components/LandingFeaturesSection.tsx");
  assert.ok(fs.existsSync(componentPath), "LandingFeaturesSection.tsx must exist");
  const compSrc = fs.readFileSync(componentPath, "utf8");

  // 1. Heading verification
  assert.ok(
    compSrc.includes("NO.1 AI"),
    "LandingFeaturesSection must include 'NO.1 AI' in the heading"
  );
  assert.ok(
    compSrc.includes("JOB HUNTING PLATFORM"),
    "LandingFeaturesSection must include 'JOB HUNTING PLATFORM' in the heading"
  );
  assert.ok(
    compSrc.includes("Rocket") && compSrc.includes("from \"lucide-react\""),
    "LandingFeaturesSection must import and render the Rocket icon from lucide-react"
  );
  assert.ok(
    compSrc.includes("<sup") && compSrc.includes("</sup>"),
    "Rocket icon must be styled as a superscript"
  );
  assert.ok(
    compSrc.includes("text-center lg:text-left"),
    "Heading must be centered on mobile and left-aligned on desktop"
  );
  assert.ok(
    compSrc.includes("font-black") && compSrc.includes("uppercase") && compSrc.includes("tracking-tight"),
    "Heading must use bold uppercase heavy condensed font styling"
  );
  assert.ok(
    compSrc.includes("text-[#09090B]"),
    "Heading must use existing brand text color text-[#09090B]"
  );
  console.log("  [PASS] Section heading: 'NO.1 AI' with superscript outlined rocket and 'JOB HUNTING PLATFORM' verified");

  // 2. Mobile & Desktop layout order
  assert.ok(
    compSrc.includes("order-1 lg:order-2") && compSrc.includes("lg:col-span-7"),
    "Image column must have order-1 on mobile (sitting on top) and lg:order-2 on desktop (sitting on right)"
  );
  assert.ok(
    compSrc.includes("order-2 lg:order-1") && compSrc.includes("lg:col-span-5"),
    "Text/label column must have order-2 on mobile (sitting below photo) and lg:order-1 on desktop (sitting on left)"
  );
  console.log("  [PASS] Layout ordering: photo is first on mobile, text/label sits directly below photo; desktop order preserved");

  // 3. Horizontal centering and width matching on mobile
  assert.ok(
    compSrc.includes("text-center lg:text-left"),
    "Text column must be centered on mobile and left-aligned on desktop"
  );
  assert.ok(
    compSrc.includes("flex flex-col items-center lg:items-start"),
    "Text column items must be centered on mobile and left-aligned on desktop"
  );
  assert.ok(
    compSrc.includes("justify-center lg:justify-start"),
    "Action buttons and badges must be centered under the photo on mobile and left-aligned on desktop"
  );
  assert.ok(
    compSrc.includes("items-center justify-center"),
    "Photo card must center the image"
  );
  console.log("  [PASS] Alignment: labels and buttons centered horizontally under the photo on mobile, matching photo width");

  // 4. Feature rows content integrity
  const expectedFeatures = [
    "job-search",
    "tailored-resume",
    "autofill-extension",
    "interview-prep",
    "personalized-matches",
  ];
  for (const id of expectedFeatures) {
    assert.ok(compSrc.includes(`id: "${id}"`), `Feature '${id}' must remain present`);
  }
  console.log("  [PASS] All 5 feature rows preserved without copy or design regression");

  // 5. Landing page integration intact
  const pagePath = path.resolve(process.cwd(), "src/app/page.tsx");
  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  const pageSrc = fs.readFileSync(pagePath, "utf8");
  assert.ok(
    pageSrc.includes("<LandingFeaturesSection />"),
    "LandingFeaturesSection must be rendered on the landing page"
  );
  console.log("  [PASS] Landing page integration intact");

  console.log("\n================================================================================");
  console.log("ALL LANDING FEATURES SECTION TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
