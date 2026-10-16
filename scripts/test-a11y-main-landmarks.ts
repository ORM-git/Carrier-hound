import fs from "fs";
import path from "path";

const TARGET_FILES = [
  "src/app/login/page.tsx",
  "src/app/signup/page.tsx",
  "src/app/radar/page.tsx",
  "src/app/privacy-policy/page.tsx",
  "src/app/terms-and-conditions/page.tsx",
];

export function verifyMainLandmarks(fileContents: Record<string, string>): {
  passed: boolean;
  results: Array<{ file: string; hasMainOpening: boolean; hasMainClosing: boolean }>;
} {
  const results = [];
  let passed = true;

  for (const file of TARGET_FILES) {
    const content = fileContents[file] || "";
    const hasMainOpening = /<main(\s+[^>]*|>)/.test(content);
    const hasMainClosing = /<\/main>/.test(content);

    if (!hasMainOpening || !hasMainClosing) {
      passed = false;
    }

    results.push({
      file,
      hasMainOpening,
      hasMainClosing,
    });
  }

  return { passed, results };
}

function main() {
  const isNegativeControl = process.argv.includes("--negative-control");
  console.log("==================================================================================");
  console.log("            TEST: MAIN LANDMARK PRESENCE ON AUTH, RADAR & LEGAL PAGES             ");
  if (isNegativeControl) {
    console.log("            MODE: NEGATIVE CONTROL (Simulating missing <main> tag in memory)      ");
  }
  console.log("==================================================================================\n");

  const fileContents: Record<string, string> = {};
  for (const relPath of TARGET_FILES) {
    const fullPath = path.join(process.cwd(), relPath);
    fileContents[relPath] = fs.readFileSync(fullPath, "utf8");
  }

  if (isNegativeControl) {
    // Invert in memory: strip <main> tags from login page
    fileContents["src/app/login/page.tsx"] = fileContents["src/app/login/page.tsx"]
      .replace(/<main/g, "<div")
      .replace(/<\/main>/g, "</div>");
  }

  const { passed, results } = verifyMainLandmarks(fileContents);

  for (const r of results) {
    const status = r.hasMainOpening && r.hasMainClosing ? "PASS" : "FAIL";
    console.log(`[${status}] ${r.file.padEnd(42)} -> <main>: ${r.hasMainOpening}, </main>: ${r.hasMainClosing}`);
  }

  if (isNegativeControl) {
    if (!passed) {
      console.log("\n[NEGATIVE CONTROL] PASS-LOCAL: Missing <main> tag correctly caused test failure.");
      process.exit(1);
    } else {
      console.error("\n[NEGATIVE CONTROL] FAIL: Negative control did not trigger failure!");
      process.exit(0);
    }
  }

  if (!passed) {
    console.error("\nVERDICT: FAIL - One or more files are missing <main> landmarks.");
    process.exit(1);
  }

  console.log("\nVERDICT: PASS-LOCAL (All 5 pages have valid <main> landmarks)");
  process.exit(0);
}

if (require.main === module) {
  main();
}
