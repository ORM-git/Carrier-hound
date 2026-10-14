/**
 * CareerMonke Read-Only Internal Links Checker & Crawler
 * Run with: npx tsx scripts/check-internal-links.ts
 */

import fs from "fs";
import path from "path";

const BASE_URL = process.env.APP_URL || "http://localhost:3000";

function getAllSourceFiles(dirPath: string, arrayOfFiles: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return arrayOfFiles;
  const files = fs.readdirSync(dirPath);
  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      getAllSourceFiles(fullPath, arrayOfFiles);
    } else if (/\.(tsx|ts|jsx|js)$/.test(file) && !file.endsWith(".d.ts")) {
      arrayOfFiles.push(fullPath);
    }
  });
  return arrayOfFiles;
}

interface DiscoveredLink {
  target: string;
  sourceFile: string;
}

function extractInternalLinksFromSource(): { links: DiscoveredLink[]; uniqueTargets: string[] } {
  const sourceFiles = getAllSourceFiles(path.resolve("src"));
  const discovered: DiscoveredLink[] = [];
  const targetSet = new Set<string>();

  const hrefRegex = /href\s*=\s*["'](\/[a-zA-Z0-9_\-\/#?]*)["']/g;
  const linkToRegex = /to\s*=\s*["'](\/[a-zA-Z0-9_\-\/#?]*)["']/g;
  const routerPushRegex = /router\.push\(\s*["'](\/[a-zA-Z0-9_\-\/#?]*)["']/g;

  for (const file of sourceFiles) {
    const content = fs.readFileSync(file, "utf8");
    const relPath = path.relative(".", file).replace(/\\/g, "/");

    let match: RegExpExecArray | null;

    while ((match = hrefRegex.exec(content)) !== null) {
      const cleanPath = match[1].split("#")[0].split("?")[0] || "/";
      discovered.push({ target: cleanPath, sourceFile: relPath });
      targetSet.add(cleanPath);
    }

    while ((match = linkToRegex.exec(content)) !== null) {
      const cleanPath = match[1].split("#")[0].split("?")[0] || "/";
      discovered.push({ target: cleanPath, sourceFile: relPath });
      targetSet.add(cleanPath);
    }

    while ((match = routerPushRegex.exec(content)) !== null) {
      const cleanPath = match[1].split("#")[0].split("?")[0] || "/";
      discovered.push({ target: cleanPath, sourceFile: relPath });
      targetSet.add(cleanPath);
    }
  }

  // Also include key canonical routes to ensure complete coverage
  const canonicalRoutes = [
    "/",
    "/job-search/all",
    "/jobs",
    "/dashboard",
    "/tracker",
    "/radar",
    "/login",
    "/privacy-policy",
    "/terms-and-conditions",
    "/admin",
    "/applications",
  ];
  canonicalRoutes.forEach((r) => targetSet.add(r));

  return { links: discovered, uniqueTargets: Array.from(targetSet).sort() };
}

async function testRoute(route: string): Promise<{ route: string; status: number; ok: boolean; title?: string }> {
  try {
    const res = await fetch(`${BASE_URL}${route}`, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 LinkChecker/1.0",
      },
    });

    const text = await res.text();
    const titleMatch = text.match(/<title>([^<]*)<\/title>/i);
    const isCustom404 = text.includes("404 - Page Not Found") || text.includes("Page Not Found | CareerMonke");

    // Next.js static dev or export: 404 route returns 404 status or custom 404 page
    const ok = res.status >= 200 && res.status < 400 && !isCustom404;

    return {
      route,
      status: res.status,
      ok,
      title: titleMatch ? titleMatch[1].trim() : undefined,
    };
  } catch (err: any) {
    return {
      route,
      status: 0,
      ok: false,
      title: `Network Error: ${err.message}`,
    };
  }
}

async function main() {
  console.log("===============================================================");
  console.log("       CAREERMONKE READ-ONLY INTERNAL LINK CHECKER & CRAWLER  ");
  console.log("===============================================================\n");

  console.log(`Checking running build on ${BASE_URL}...\n`);

  // 1. Verify custom 404 test on deliberately non-existent route /abc123xyz
  console.log("--- 1. Testing deliberate non-existent route: /abc123xyz ---");
  const test404 = await testRoute("/abc123xyz");
  console.log(`Route:  /abc123xyz`);
  console.log(`Status: ${test404.status}`);
  console.log(`Title:  ${test404.title}`);
  const custom404Confirmed = test404.status === 404 && (test404.title?.includes("404") || test404.title?.includes("Not Found"));
  console.log(`Custom 404 Confirmed: ${custom404Confirmed ? "YES (PASS)" : "NO"}\n`);

  // 2. Parse source for all href and Link targets
  console.log("--- 2. Parsing source code for internal href and Link targets ---");
  const { links, uniqueTargets } = extractInternalLinksFromSource();
  console.log(`Found ${links.length} link references across source code.`);
  console.log(`Extracted ${uniqueTargets.length} unique internal routes to test.\n`);

  // 3. Test each unique internal route
  console.log("--- 3. Crawling / verifying all discovered internal routes ---");
  const results = [];
  const brokenRoutes: { route: string; status: number; sources: string[] }[] = [];

  for (const route of uniqueTargets) {
    const res = await testRoute(route);
    results.push(res);

    if (!res.ok) {
      const sources = links.filter((l) => l.target === route).map((l) => l.sourceFile);
      brokenRoutes.push({
        route,
        status: res.status,
        sources: Array.from(new Set(sources)),
      });
      console.log(`❌ BROKEN: ${route} (Status: ${res.status}) - Title: ${res.title}`);
    } else {
      console.log(`✅ OK:     ${route} (Status: ${res.status}) - Title: ${res.title || "OK"}`);
    }
  }

  console.log("\n===============================================================");
  console.log("                     INTERNAL CRAWL SUMMARY                    ");
  console.log("===============================================================");
  console.log(`Total unique internal routes scanned: ${uniqueTargets.length}`);
  console.log(`Healthy existing routes (2xx):        ${results.filter((r) => r.ok).length}`);
  console.log(`Broken internal routes (4xx/5xx/err): ${brokenRoutes.length}`);
  console.log(`Custom 404 handler verified:          ${custom404Confirmed ? "PASS (404 status)" : "FAIL"}`);
  console.log("===============================================================\n");

  if (brokenRoutes.length > 0) {
    console.log("Broken internal links list:");
    brokenRoutes.forEach((b, i) => {
      console.log(`[${i + 1}] Target: ${b.route} (Status: ${b.status})`);
      console.log(`    Referenced in: ${b.sources.join(", ") || "Canonical list"}`);
    });
    console.log("");
  } else {
    console.log("🎉 Zero broken internal links found! All internal routes resolve properly.\n");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
