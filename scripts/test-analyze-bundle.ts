/**
 * Guard for scripts/analyze-bundle.js (Performance row: Bundle analyzer).
 * Offline: builds a tiny fake out/ tree in a temp dir and checks route lookup,
 * chunk sizing, path-traversal rejection, and that the npm script and the
 * blocking CI budget step both exist.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const analyzer = require("./analyze-bundle.js");

const ROOT = path.resolve(__dirname, "..");
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) console.log(`PASS: ${label}`);
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "analyze-bundle-"));
try {
  const chunks = path.join(tmp, "out", "_next", "static", "chunks");
  fs.mkdirSync(chunks, { recursive: true });
  fs.writeFileSync(path.join(chunks, "a.js"), "x".repeat(1000));
  fs.writeFileSync(path.join(chunks, "b.js"), "y".repeat(2500));
  fs.writeFileSync(
    path.join(tmp, "out", "jobs.html"),
    '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/b.js"></script>' +
      '<script src="/_next/static/chunks/a.js"></script><script src="/_next/static/chunks/missing.js"></script>'
  );
  const r = analyzer.analyze(tmp, "jobs");
  check(r !== null && r.chunks.length === 2, "dedupes chunks and skips ones missing on disk");
  check(r !== null && r.totalBytes === 3500, "sums chunk bytes");
  check(analyzer.analyze(tmp, "dashboard") === null, "returns null for a route with no build output");
  let threw = false;
  try { analyzer.safeRoute("../etc/passwd"); } catch { threw = true; }
  check(threw, "rejects path traversal in route");
  check(analyzer.safeRoute("/jobs/") === "jobs", "normalises leading/trailing slashes");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
check(pkg.scripts["analyze:bundle"] === "node scripts/analyze-bundle.js", "package.json has analyze:bundle script");
check(/check-bundle-budget\.mjs/.test(pkg.scripts["check:budget"] || ""), "check:budget script still runs the budget gate");
const ci = fs.readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
check(/Bundle Size Budget\s*\n\s*run: npm run check:budget/.test(ci), "CI runs the blocking Bundle Size Budget step");

if (failed > 0) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log("All analyze-bundle checks passed");
