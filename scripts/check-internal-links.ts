import fs from "fs";
import path from "path";
import assert from "assert";

console.log("==================================================================================");
console.log("           INTERNAL ROUTE & NAVIGATION LINK AUDIT (src/ vs Real Routes)          ");
console.log("==================================================================================\n");

// Known real routes statically exported or redirected in CareerMonke:
const KNOWN_STATIC_ROUTES = new Set([
  "/",
  "/jobs",
  "/jobs/detail",
  "/job-detail",
  "/job-search",
  "/job-search/all",
  "/job-search/remote",
  "/worldwide",
  "/remote",
  "/login",
  "/signup",
  "/dashboard",
  "/tracker",
  "/applications",
  "/resume",
  "/settings",
  "/radar",
  "/admin",
  "/admin/users",
  "/privacy-policy",
  "/terms-and-conditions",
  "/auth/callback",
  "/paywall",
  "/pricing",
]);

// Dynamic route patterns (Next.js slug routes)
const DYNAMIC_ROUTE_PATTERNS = [
  /^\/remote\/[a-zA-Z0-9_-]+$/,
  /^\/remote\/[a-zA-Z0-9_-]+\/titles$/,
  /^\/remote\/jobs\/[a-zA-Z0-9_-]+$/,
  /^\/jobs\/[a-zA-Z0-9_.-]+$/,
];

function isRouteValid(route: string): boolean {
  if (route === "") return true;
  // Clean query and hash
  const clean = route.split("?")[0].split("#")[0];
  if (KNOWN_STATIC_ROUTES.has(clean)) return true;
  return DYNAMIC_ROUTE_PATTERNS.some((p) => p.test(clean));
}

function getAllFiles(dir: string, exts = [".ts", ".tsx", ".js"]): string[] {
  let files: string[] = [];
  if (!fs.existsSync(dir)) return files;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      files = files.concat(getAllFiles(full, exts));
    } else if (item.isFile() && exts.some((e) => item.name.endsWith(e))) {
      files.push(full);
    }
  }
  return files;
}

const srcFiles = getAllFiles("src");
const collectedLinks: { file: string; line: number; raw: string; clean: string }[] = [];

for (const file of srcFiles) {
  const content = fs.readFileSync(file, "utf8");
  const lines = content.split("\n");

  lines.forEach((line, idx) => {
    // 1. href="path"
    const hrefMatches = line.matchAll(/href=["'](\/[^"']*)["']/g);
    for (const m of hrefMatches) {
      collectedLinks.push({
        file: file.replace(/\\/g, "/"),
        line: idx + 1,
        raw: m[1],
        clean: m[1].split("?")[0].split("#")[0],
      });
    }

    // 2. router.push("path")
    const pushMatches = line.matchAll(/router\.push\(["'](\/[^"']*)["']\)/g);
    for (const m of pushMatches) {
      collectedLinks.push({
        file: file.replace(/\\/g, "/"),
        line: idx + 1,
        raw: m[1],
        clean: m[1].split("?")[0].split("#")[0],
      });
    }
  });
}

console.log(`Discovered ${collectedLinks.length} internal links across ${srcFiles.length} source files.`);

const deadLinks: { file: string; line: number; raw: string }[] = [];
const validLinks: { file: string; line: number; raw: string }[] = [];

for (const link of collectedLinks) {
  if (isRouteValid(link.clean)) {
    validLinks.push(link);
  } else {
    deadLinks.push(link);
  }
}

// Special check for "Applications" navigation
const appLinks = collectedLinks.filter((l) => l.clean === "/applications");
console.log(`\nNav 'Applications' links found: ${appLinks.length}`);
appLinks.forEach((l) => console.log(`  - ${l.file}:${l.line} -> ${l.raw}`));

if (deadLinks.length > 0) {
  console.log(`\n⚠️ DEAD LINKS FOUND (${deadLinks.length}):`);
  deadLinks.forEach((d) => console.log(`  - ${d.file}:${d.line} -> ${d.raw}`));
} else {
  console.log(`\n✅ All ${collectedLinks.length} internal links point to valid, reachable routes!`);
}

// -------------------------------------------------------------------------------------
// NEGATIVE CONTROL: Deliberately test an invalid internal route
// -------------------------------------------------------------------------------------
console.log("\n--- RUNNING NEGATIVE CONTROL (verifies validator catches dead link) ---");
const fakeDeadLink = "/non-existent-career-dog-404";
const isFakeValid = isRouteValid(fakeDeadLink);

let negativeControlPassed = false;
try {
  assert.strictEqual(isFakeValid, false, "Fake dead link must NOT be accepted as valid");
  negativeControlPassed = true;
  console.log(`✅ Negative control passed: '${fakeDeadLink}' correctly detected as dead link.`);
} catch (err: any) {
  console.error("Negative control failed:", err);
}

assert(negativeControlPassed, "Negative control failed to catch fake dead link!");

console.log("\n==================================================================================");
console.log(`INTERNAL LINK AUDIT: Valid: ${validLinks.length}, Dead: ${deadLinks.length}`);
console.log("==================================================================================");
