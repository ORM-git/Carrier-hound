/**
 * Bundle analyzer (Performance row: Bundle analyzer).
 * Lists the JS chunks a built route loads and their uncompressed size.
 *
 *   node scripts/analyze-bundle.js [route]      (default route: jobs)
 *   npm run analyze:bundle -- dashboard
 *
 * Reads the built HTML for the route from out/<route>.html (static export) or
 * .next/server/app/<route>.html, then sizes each referenced chunk under the
 * same build directory. Run after `next build`. The blocking size gate is
 * scripts/check-bundle-budget.mjs (CI "Bundle Size Budget"); this script is
 * the per-route breakdown for investigating a budget failure.
 */
const fs = require("fs");
const path = require("path");

const CHUNK_RE = /\/_next\/static\/chunks\/[a-zA-Z0-9._\/-]+\.js/g;

function safeRoute(route) {
  const r = String(route || "jobs").replace(/^\/+|\/+$/g, "");
  if (!r || !/^[a-zA-Z0-9_\-\/]+$/.test(r) || r.split("/").includes("..")) {
    throw new Error("Invalid route: " + route);
  }
  return r;
}

/** Returns { html, staticRoot } or null when no build output exists for the route. */
function findRouteHtml(root, route) {
  const r = safeRoute(route);
  const candidates = [
    { html: path.join(root, "out", r + ".html"), staticRoot: path.join(root, "out") },
    { html: path.join(root, "out", r, "index.html"), staticRoot: path.join(root, "out") },
    { html: path.join(root, ".next", "server", "app", r + ".html"), staticRoot: path.join(root, ".next") },
  ];
  return candidates.find((c) => fs.existsSync(c.html)) || null;
}

/** Unique chunk paths referenced by the HTML, with sizes for those present on disk. */
function collectChunks(htmlText, staticRoot) {
  const matches = [...new Set(htmlText.match(CHUNK_RE) || [])];
  const chunks = [];
  for (const scriptPath of matches) {
    const rel = scriptPath.replace(/^\/_next\//, "");
    const local = staticRoot.endsWith(".next")
      ? path.join(staticRoot, rel)
      : path.join(staticRoot, scriptPath);
    if (fs.existsSync(local)) chunks.push({ path: scriptPath, bytes: fs.statSync(local).size });
  }
  return chunks;
}

function analyze(root, route) {
  const found = findRouteHtml(root, route);
  if (!found) return null;
  const chunks = collectChunks(fs.readFileSync(found.html, "utf8"), found.staticRoot);
  const totalBytes = chunks.reduce((sum, c) => sum + c.bytes, 0);
  return { route: safeRoute(route), chunks, totalBytes };
}

function main() {
  const route = process.argv[2] || "jobs";
  const result = analyze(process.cwd(), route);
  if (!result) {
    console.error(`No build output for route "${route}" (looked in out/ and .next/server/app/). Run next build first.`);
    process.exit(1);
  }
  console.log(`--- Scripts on /${result.route} route ---`);
  for (const c of result.chunks) console.log(`${c.path}: ${(c.bytes / 1024).toFixed(1)} KB`);
  console.log("------------------------------");
  console.log(
    `Total initial uncompressed JS: ${(result.totalBytes / 1024).toFixed(1)} KB (${(result.totalBytes / 1024 / 1024).toFixed(2)} MB)`
  );
}

if (require.main === module) main();

module.exports = { safeRoute, findRouteHtml, collectChunks, analyze };
