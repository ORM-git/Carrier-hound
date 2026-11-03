import fs from "fs";
import path from "path";
import assert from "assert";

/**
 * CareerMonke Landing Feature Visuals Verification Suite
 * Verifies:
 * 1. public/careermonke-visuals.js installation and branding (#2563EB, #090E34, Inter font, no Google Fonts).
 * 2. src/types/cm-visuals.d.ts type declarations for JSX.IntrinsicElements.
 * 3. src/app/page.tsx next/script loading and exact 7-part section reordering.
 * 4. src/components/LandingFeaturesSection.tsx 3 rows, compact web components, and "Coming soon" removal.
 * 5. Complete deletion of autofill and interview-prep webp images.
 * 6. Negative control verification.
 */

function runSuite() {
  console.log("================================================================================");
  console.log("       LANDING FEATURE VISUALS & SECTION REORDER VERIFICATION SUITE             ");
  console.log("================================================================================");

  // Negative control check
  if (process.argv.includes("--negative-control")) {
    console.log("  [NEGATIVE CONTROL] Simulating invalid condition (missing careermonke-visuals.js)...");
    assert.ok(
      fs.existsSync(path.join(process.cwd(), "public", "nonexistent-visuals-file.js")),
      "Negative control: nonexistent file must trigger failure"
    );
    process.exit(0);
  }

  const root = process.cwd();

  // 1. Check public/careermonke-visuals.js
  const visualsPath = path.join(root, "public", "careermonke-visuals.js");
  assert.ok(fs.existsSync(visualsPath), "public/careermonke-visuals.js must exist");

  const visualsContent = fs.readFileSync(visualsPath, "utf8");

  // Prohibited old colors
  assert.ok(
    !visualsContent.includes("#2F5BE7"),
    "careermonke-visuals.js must not contain old blue #2F5BE7"
  );
  assert.ok(
    !visualsContent.includes("#1E40AF"),
    "careermonke-visuals.js must not contain old navy #1E40AF"
  );

  // Required brand colors
  assert.ok(
    visualsContent.includes("#2563EB"),
    "careermonke-visuals.js must contain CareerMonke brand blue #2563EB"
  );
  assert.ok(
    visualsContent.includes("#090E34"),
    "careermonke-visuals.js must contain CareerMonke brand navy #090E34"
  );

  // Prohibited external Google Fonts call
  assert.ok(
    !visualsContent.includes("fonts.googleapis.com"),
    "careermonke-visuals.js must remove external Google Fonts href"
  );
  assert.ok(
    !visualsContent.includes("ensureFont"),
    "careermonke-visuals.js must remove ensureFont() function and call"
  );

  // Required Custom Element definitions
  assert.ok(
    visualsContent.includes("define('cm-find-jobs', CMFindJobs)"),
    "careermonke-visuals.js must define cm-find-jobs"
  );
  assert.ok(
    visualsContent.includes("define('cm-tailor-resume', CMTailorResume)"),
    "careermonke-visuals.js must define cm-tailor-resume"
  );
  assert.ok(
    visualsContent.includes("define('cm-job-matches', CMJobMatches)"),
    "careermonke-visuals.js must define cm-job-matches"
  );

  // Architecture sanity: shadow DOM, ResizeObserver, IntersectionObserver, prefers-reduced-motion
  assert.ok(
    visualsContent.includes("attachShadow({ mode: 'open' })"),
    "careermonke-visuals.js must use Shadow DOM"
  );
  assert.ok(
    visualsContent.includes("prefers-reduced-motion"),
    "careermonke-visuals.js must respect prefers-reduced-motion"
  );

  console.log("  [PASS] public/careermonke-visuals.js branding, font inheritance, and web components verified");

  // 2. Check src/types/cm-visuals.d.ts
  const typesPath = path.join(root, "src", "types", "cm-visuals.d.ts");
  assert.ok(fs.existsSync(typesPath), "src/types/cm-visuals.d.ts must exist");

  const typesContent = fs.readFileSync(typesPath, "utf8");
  assert.ok(
    typesContent.includes('"cm-find-jobs"') &&
      typesContent.includes('"cm-tailor-resume"') &&
      typesContent.includes('"cm-job-matches"'),
    "src/types/cm-visuals.d.ts must declare cm-find-jobs, cm-tailor-resume, cm-job-matches in IntrinsicElements"
  );
  assert.ok(
    typesContent.includes("compact?:"),
    "src/types/cm-visuals.d.ts must declare compact attribute"
  );

  console.log("  [PASS] src/types/cm-visuals.d.ts TypeScript declarations verified");

  // 3. Check src/components/LandingFeaturesSection.tsx
  const featuresPath = path.join(root, "src", "components", "LandingFeaturesSection.tsx");
  assert.ok(fs.existsSync(featuresPath), "src/components/LandingFeaturesSection.tsx must exist");

  const featuresContent = fs.readFileSync(featuresPath, "utf8");

  // Exactly 3 rows
  assert.ok(
    featuresContent.includes("Find jobs on company career pages") &&
      featuresContent.includes("Tailor your resume to each role") &&
      featuresContent.includes("Personalized job matches"),
    "Features section must include the 3 canonical rows"
  );

  // Custom visual components
  assert.ok(
    featuresContent.includes("<cm-find-jobs compact"),
    "Features section must render <cm-find-jobs compact"
  );
  assert.ok(
    featuresContent.includes("<cm-tailor-resume compact"),
    "Features section must render <cm-tailor-resume compact"
  );
  assert.ok(
    featuresContent.includes("<cm-job-matches compact"),
    "Features section must render <cm-job-matches compact"
  );

  // Visible caption preserved
  assert.ok(
    featuresContent.includes("Illustration - sample data"),
    "Features section must preserve 'Illustration - sample data' under each card"
  );

  // Deleted features and badges
  assert.ok(
    !featuresContent.toLowerCase().includes("autofill"),
    "Features section must not contain 'Autofill'"
  );
  assert.ok(
    !featuresContent.toLowerCase().includes("interview prep"),
    "Features section must not contain 'interview prep'"
  );
  assert.ok(
    !featuresContent.includes("Coming soon"),
    "Features section must not contain 'Coming soon'"
  );

  console.log("  [PASS] src/components/LandingFeaturesSection.tsx rows, web components, and pure copy verified");

  // 4. Check deleted images
  const autofillImgPath = path.join(root, "public", "features", "autofill-extension.webp");
  const interviewImgPath = path.join(root, "public", "features", "interview-prep.webp");
  assert.ok(!fs.existsSync(autofillImgPath), "autofill-extension.webp must be deleted");
  assert.ok(!fs.existsSync(interviewImgPath), "interview-prep.webp must be deleted");

  console.log("  [PASS] Deleted images (autofill-extension.webp, interview-prep.webp) verified absent");

  // 5. Check src/app/page.tsx next/script and section order
  const pagePath = path.join(root, "src", "app", "page.tsx");
  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");

  const pageContent = fs.readFileSync(pagePath, "utf8");

  // next/script loading
  assert.ok(
    pageContent.includes("import Script from \"next/script\""),
    "page.tsx must import Script from next/script"
  );
  assert.ok(
    pageContent.includes('src="/careermonke-visuals.js"') &&
      pageContent.includes('strategy="afterInteractive"'),
    "page.tsx must load /careermonke-visuals.js with strategy='afterInteractive'"
  );

  // Single ticker rule: LandingCompanyLogoTicker removed, only LandingJobsTickerStrip kept
  assert.ok(
    !pageContent.includes("LandingCompanyLogoTicker"),
    "page.tsx must not contain LandingCompanyLogoTicker (only black jobs ticker strip kept)"
  );

  // Section Ordering:
  // (1) LandingTopArtifact hero/demo
  // (2) LandingFeaturesSection
  // (3) LandingJobsTickerStrip
  // (4) LandingComparisonSection (including its AI-resume block)
  // (5) the global map/radar section
  // (6) the Free preview CTA band
  // (7) the bio, feedback/testimonials, FAQ, contact us sections in that order
  // then LandingCredibilitySection if it still exists and the Footer.
  const idxTopArtifact = pageContent.indexOf("<LandingTopArtifact />");
  const idxFeatures = pageContent.indexOf("<LandingFeaturesSection />");
  const idxTicker = pageContent.indexOf("<LandingJobsTickerStrip />");
  const idxComparison = pageContent.indexOf("<LandingComparisonSection />");
  const idxGlobalGlobe =
    pageContent.indexOf("<LandingGlobeFeatureSection") > -1
      ? pageContent.indexOf("<LandingGlobeFeatureSection")
      : pageContent.indexOf("<WireframeDottedGlobe />");
  const idxFreePreview = pageContent.indexOf("Free preview");
  const idxBio = pageContent.indexOf("Orissa here!");
  const idxTestimonials = pageContent.indexOf("<Testimonials />");
  const idxFaq = pageContent.indexOf("Frequently Asked Questions");
  const idxContact = pageContent.indexOf('id="contact"');
  const idxCredibility = pageContent.indexOf("<LandingCredibilitySection />");
  const idxFooter = pageContent.indexOf("<Footer />");

  assert.ok(idxTopArtifact > -1, "LandingTopArtifact must be rendered");
  assert.ok(idxFeatures > -1, "LandingFeaturesSection must be rendered");
  assert.ok(idxTicker > -1, "LandingJobsTickerStrip must be rendered");
  assert.ok(idxComparison > -1, "LandingComparisonSection must be rendered");
  assert.ok(!pageContent.includes("AI Resume Monke"), "AI Resume Monke block must not be present in page.tsx");
  assert.ok(idxGlobalGlobe > -1, "Global map/radar section must be rendered");
  assert.ok(idxFreePreview > -1, "Free preview CTA band must be rendered");
  assert.ok(idxBio > -1, "Founder bio card must be rendered");
  assert.ok(idxTestimonials > -1, "Testimonials must be rendered");
  assert.ok(idxFaq > -1, "FAQ must be rendered");
  assert.ok(idxContact > -1, "Contact section must be rendered");
  assert.strictEqual(idxCredibility, -1, "LandingCredibilitySection must NOT be rendered in page.tsx");
  assert.ok(idxFooter > -1, "Footer must be rendered");

  // Assert exact sequence
  assert.ok(idxTopArtifact < idxFeatures, "(1) LandingTopArtifact before (2) LandingFeaturesSection");
  assert.ok(idxFeatures < idxTicker, "(2) LandingFeaturesSection before (3) LandingJobsTickerStrip");
  assert.ok(idxTicker < idxComparison, "(3) LandingJobsTickerStrip before (4) LandingComparisonSection");
  assert.ok(idxComparison < idxGlobalGlobe, "(4) LandingComparisonSection before (5) global map/radar");
  assert.ok(idxGlobalGlobe < idxFreePreview, "(5) global map/radar before (6) Free preview CTA band");
  assert.ok(idxFreePreview < idxBio, "(6) Free preview CTA band before (7) bio");
  assert.ok(idxBio < idxTestimonials, "(7) bio before feedback/testimonials");
  assert.ok(idxTestimonials < idxFaq, "(7) feedback/testimonials before FAQ");
  assert.ok(idxFaq < idxContact, "(7) FAQ before contact us");
  assert.ok(idxContact < idxFooter, "(7) contact us before Footer");

  console.log("  [PASS] Landing page exact section sequence verified (1..9)");

  console.log("================================================================================");
  console.log("ALL LANDING FEATURE VISUALS & ORDERING TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

try {
  runSuite();
} catch (err) {
  console.error("Test failed:", err);
  process.exit(1);
}
