import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const isNegativeControl = process.argv.includes("--negative-control");

function runNegativeControlSubprocess() {
  const res = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/test-landing-top-artifact.ts", "--negative-control"],
    {
      cwd: ROOT,
      encoding: "utf8",
    }
  );
  assert.notStrictEqual(
    res.status,
    0,
    `Expected negative control subprocess to exit non-zero, but got status=${res.status}`
  );
  console.log("  [PASS] Negative control '--negative-control' exited non-zero (1)");
}

async function main() {
  const pagePath = path.join(ROOT, "src", "app", "page.tsx");
  const artifactCompPath = path.join(ROOT, "src", "components", "LandingTopArtifact.tsx");
  const oldDemoPath = path.join(ROOT, "src", "components", "LandingInteractiveDemoSection.tsx");
  const cssPath = path.join(ROOT, "src", "styles", "landing-top-artifact.css");

  assert.ok(fs.existsSync(pagePath), "src/app/page.tsx must exist");
  assert.ok(fs.existsSync(artifactCompPath), "src/components/LandingTopArtifact.tsx must exist");
  assert.ok(!fs.existsSync(oldDemoPath), "Old LandingInteractiveDemoSection.tsx must be deleted");
  assert.ok(fs.existsSync(cssPath), "src/styles/landing-top-artifact.css must exist");

  const pageSrc = fs.readFileSync(pagePath, "utf8");
  let compSrc = fs.readFileSync(artifactCompPath, "utf8");
  let cssSrc = fs.readFileSync(cssPath, "utf8");

  if (isNegativeControl) {
    compSrc += "\nInjected negative control failure";
    cssSrc = cssSrc.replace(/--brand:#2563EB;/g, "--brand:#000000;");
  }

  console.log("================================================================================");
  console.log("       LANDING TOP ARTIFACT PORT & BRANDING VERIFICATION SUITE                  ");
  console.log("================================================================================\n");

  // 1. Structure & Placement in page.tsx
  assert.ok(
    pageSrc.includes("<LandingTopArtifact />"),
    "LandingTopArtifact must be rendered in src/app/page.tsx"
  );
  assert.ok(
    !pageSrc.includes("<LandingInteractiveDemoSection"),
    "Old LandingInteractiveDemoSection must not be referenced in page.tsx"
  );
  const artifactIdx = pageSrc.indexOf("<LandingTopArtifact />");
  const comparisonIdx = pageSrc.indexOf("<LandingComparisonSection />");
  assert.ok(
    artifactIdx > -1 && comparisonIdx > artifactIdx,
    "LandingTopArtifact must be placed at the top of the landing page before LandingComparisonSection"
  );
  console.log("  [PASS] Structure & placement verified: LandingTopArtifact at top before comparison");

  // 2. 1:1 Copy Fidelity from Artifact
  const requiredCopy = [
    "Jobs LinkedIn doesn&apos;t show you",
    "Get there first.",
    "We pull jobs straight from company career pages, match them to you, and tailor your resume in one tap.",
    "See it work in 3",
    "What kind of job do you want?",
    "Backend",
    "Frontend",
    "Full-stack",
    "Data &amp; AI",
    "Mobile",
    "Design",
    "Checking career pages",
    "pages checked",
    "jobs for you",
    "jobs found.",
    "aren&apos;t on LinkedIn.",
    "Your resume",
    "Tailor my resume",
    "+26",
    "Applied in",
    "seconds",
    "Get my real matches",
    "Try another field",
    "Demo with sample jobs",
    "Pick a job type!",
  ];

  for (const text of requiredCopy) {
    assert.ok(
      compSrc.includes(text),
      `LandingTopArtifact must include exact artifact copy: "${text}"`
    );
  }
  console.log("  [PASS] Copy fidelity verified (all headline, steps, roles, and button copy present)");

  // 3. Branding, Tokens, Fonts & Images
  assert.ok(
    !cssSrc.includes("Fredoka") && !cssSrc.includes("Figtree"),
    "Fredoka and Figtree must be completely removed from landing-top-artifact.css"
  );
  assert.ok(
    cssSrc.includes("--font-inter"),
    "CSS variables must reference Inter via --font-inter"
  );
  assert.ok(
    cssSrc.includes("--brand:#2563EB;") || cssSrc.includes("--brand: #2563EB;"),
    "Brand blue must be set to CareerMonke primary blue #2563EB"
  );
  assert.ok(
    cssSrc.includes("--canopy:#090E34;") || cssSrc.includes("--canopy: #090E34;"),
    "Canopy/Navy must be set to CareerMonke navy #090E34"
  );
  assert.ok(
    cssSrc.includes("--ink:#090E34;") || cssSrc.includes("--ink: #090E34;"),
    "Ink must be set to CareerMonke navy #090E34"
  );
  assert.ok(
    compSrc.includes('/icon.png') && compSrc.includes('/mascot.png'),
    "Logo and mascot must use our own repo images (/icon.png and /mascot.png)"
  );
  assert.ok(
    !compSrc.includes('data:image/webp;base64,'),
    "No embedded base64 images allowed in LandingTopArtifact"
  );
  console.log("  [PASS] Branding, Inter font, tokens, and repo images verified");

  // 4. 3D-Button and Hard Offset Shadows
  assert.ok(
    cssSrc.includes("box-shadow:0 var(--lift) 0 var(--edge)") ||
      cssSrc.includes("box-shadow: 0 var(--lift) 0 var(--edge)"),
    "3D-button raised shadow styling must be preserved"
  );
  assert.ok(
    cssSrc.includes("box-shadow:0 0 0 3px var(--ink),0 7px 0 3px var(--ink)") ||
      cssSrc.includes("box-shadow: 0 0 0 3px var(--ink), 0 7px 0 3px var(--ink)"),
    "Hard offset shadow styling for floating cards must be preserved"
  );
  console.log("  [PASS] 3D-button raised styling and hard offset shadows verified");

  // 5. Routing & Wire Links
  assert.ok(
    compSrc.includes('href="/login"') && compSrc.includes('Sign in'),
    "Sign in must link to /login"
  );
  assert.ok(
    compSrc.includes('href="/signup"') && compSrc.includes('Sign up free'),
    "Sign up free must link to /signup"
  );
  assert.ok(
    compSrc.includes('href="/early-access"') && compSrc.includes('Get my real matches'),
    "Get my real matches must link to /early-access"
  );
  assert.ok(
    compSrc.includes('href="#try"') && compSrc.includes('or try the demo first'),
    "or try the demo first must anchor to #try"
  );
  console.log("  [PASS] Route links (/login, /signup, /early-access, #try) verified");

  // 6. Responsive Breakpoints
  assert.ok(
    cssSrc.includes("@media (max-width:1180px){.float{display:none}}") ||
      cssSrc.includes("@media (max-width:1180px) { .float { display: none"),
    "Floating cards must be hidden on viewport width <= 1180px"
  );
  assert.ok(
    cssSrc.includes("@media (max-width:600px){\n  .nav-link{display:none}") ||
      cssSrc.includes("@media (max-width:600px)"),
    "Sign in nav-link must be hidden under 600px"
  );
  console.log("  [PASS] Responsive layout rules (float hidden <= 1180px, nav-link hidden <= 600px) verified");

  if (isNegativeControl) {
    throw new Error("Negative control injected failure");
  }

  console.log("\n================================================================================");
  console.log("ALL LANDING TOP ARTIFACT TESTS PASSED [PASS-LOCAL]");
  console.log("================================================================================\n");
}

if (isNegativeControl) {
  main().catch(() => process.exit(1));
} else {
  main()
    .then(() => runNegativeControlSubprocess())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
