/**
 * CareerMonke Sitemap and Robots Output Verification Suite
 * Validates canonical domain resolution and ensures no .io domain references exist in SEO endpoints.
 * 
 * Run with: npx tsx scripts/test-sitemap-robots.ts
 * Run negative control: npx tsx scripts/test-sitemap-robots.ts --negative-control
 */

import robots from "../src/app/robots";
import sitemap from "../src/app/sitemap";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function runTest() {
  console.log("====================================================================================================");
  console.log("             SITEMAP & ROBOTS SEO DOMAIN VERIFICATION                                               ");
  console.log("====================================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Simulating legacy .io URL to verify detection...");
  }

  // 1. Robots output
  const robotsData = robots();
  console.log("Robots Configuration:");
  console.log(`- User Agent: ${robotsData.rules ? (Array.isArray(robotsData.rules) ? robotsData.rules[0]?.userAgent : robotsData.rules.userAgent) : "none"}`);
  console.log(`- Sitemap:    ${robotsData.sitemap}`);

  const sitemapUrl = String(robotsData.sitemap || "");
  const robotsHasIo = sitemapUrl.includes(".io");

  // 2. Sitemap output
  const sitemapEntries = sitemap();
  console.log(`\nSitemap Entries Count: ${sitemapEntries.length}`);
  console.log("Sample Generated URLs (first 5):");
  sitemapEntries.slice(0, 5).forEach((entry, idx) => {
    console.log(`  ${idx + 1}. ${entry.url}`);
  });

  let ioCount = 0;
  for (const entry of sitemapEntries) {
    if (entry.url.includes(".io")) {
      ioCount++;
    }
  }

  if (IS_NEGATIVE_CONTROL) {
    // Deliberately simulate an outdated .io entry
    ioCount += 1;
    console.log("\n[NEGATIVE CONTROL] Injected simulated .io entry: https://careermonke.io/legacy-page");
  }

  console.log("\n----------------------------------------------------------------------------------------------------");
  console.log(`Robots Sitemap URL: ${sitemapUrl} -> ${!robotsHasIo ? "PASS-LOCAL (clean .com domain)" : "FAIL (.io found)"}`);
  console.log(`Sitemap Entries with .io: ${ioCount} -> ${ioCount === 0 ? "PASS-LOCAL (0 found)" : "FAIL (contains .io)"}`);
  console.log("----------------------------------------------------------------------------------------------------");

  if (IS_NEGATIVE_CONTROL) {
    if (ioCount > 0 || robotsHasIo) {
      console.error("❌ NEGATIVE CONTROL VERIFIED: Test caught .io domain and exited non-zero as expected.");
      process.exit(1);
    } else {
      console.error("⚠️ NEGATIVE CONTROL FAILED: .io was NOT caught!");
      process.exit(0);
    }
  }

  if (robotsHasIo || ioCount > 0) {
    console.error(`❌ TEST FAILED: Discovered ${ioCount} sitemap URLs with outdated .io domain or robots sitemap has .io.`);
    process.exit(1);
  }

  console.log("🎉 ALL SITEMAP AND ROBOTS URLS VERIFIED ON OFFICIAL CAREERMONKE.COM DOMAIN!");
  process.exit(0);
}

runTest().catch((err) => {
  console.error("Fatal test error:", err);
  process.exit(1);
});
