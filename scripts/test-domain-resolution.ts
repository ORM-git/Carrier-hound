/**
 * CareerMonke Domain Resolution Verification Suite
 * Verifies sitemap, robots, and canonical URL resolution across:
 * 1. https://careermonke12.netlify.app
 * 2. https://carrier-hound.pages.dev
 * 3. https://careermonke.com
 * 4. Fallback (undefined / empty env)
 * 
 * Run with: npx tsx scripts/test-domain-resolution.ts
 * Run negative control: npx tsx scripts/test-domain-resolution.ts --negative-control
 */

import assert from "node:assert";
import { getSiteUrl } from "../src/lib/siteUrl";
import sitemap from "../src/app/sitemap";
import robots from "../src/app/robots";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function runDomainResolutionSuite() {
  console.log("===============================================================================");
  console.log("           CAREERMONKE DOMAIN RESOLUTION & CANONICAL VERIFICATION              ");
  console.log("===============================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️ [NEGATIVE CONTROL MODE ACTIVE]: Simulating domain mismatch expectation...\n");
  }

  const testDomains = [
    { name: "Netlify Production", url: "https://careermonke12.netlify.app" },
    { name: "Cloudflare Preview", url: "https://carrier-hound.pages.dev" },
    { name: "Custom Production Domain", url: "https://careermonke.com" },
    { name: "Trailing Slash Normalization", url: "https://careermonke.com///", expected: "https://careermonke.com" },
  ];

  let passCount = 0;
  let failCount = 0;

  const originalEnv = process.env.NEXT_PUBLIC_SITE_URL;

  for (const item of testDomains) {
    process.env.NEXT_PUBLIC_SITE_URL = item.url;
    const expectedBase = item.expected || item.url;

    // 1. Check getSiteUrl()
    const resolvedBase = getSiteUrl();
    if (resolvedBase === expectedBase) {
      console.log(`[PASS] getSiteUrl() for ${item.name}: ${resolvedBase}`);
      passCount++;
    } else {
      console.error(`[FAIL] getSiteUrl() for ${item.name}: got ${resolvedBase}, expected ${expectedBase}`);
      failCount++;
    }

    // 2. Check sitemap()
    const sitemapEntries = sitemap();
    const allMatchSitemap = sitemapEntries.every((entry) => entry.url.startsWith("https://careermonke.com"));
    if (allMatchSitemap && sitemapEntries.length > 0) {
      console.log(`[PASS] sitemap() for ${item.name}: all ${sitemapEntries.length} entries start with https://careermonke.com`);
      passCount++;
    } else {
      console.error(`[FAIL] sitemap() for ${item.name}: some entries do not start with https://careermonke.com`);
      failCount++;
    }

    // 3. Check robots()
    const robotsEntry = robots();
    const expectedRobotsSitemap = "https://careermonke.com/sitemap.xml";
    if (robotsEntry.sitemap === expectedRobotsSitemap) {
      console.log(`[PASS] robots() for ${item.name}: sitemap points to ${robotsEntry.sitemap}`);
      passCount++;
    } else {
      console.error(`[FAIL] robots() for ${item.name}: got ${robotsEntry.sitemap}, expected ${expectedRobotsSitemap}`);
      failCount++;
    }
  }

  // 4. Test Fallback when NEXT_PUBLIC_SITE_URL is unset
  delete process.env.NEXT_PUBLIC_SITE_URL;
  const fallbackBase = getSiteUrl();
  if (fallbackBase === "https://careermonke.com") {
    console.log(`[PASS] getSiteUrl() fallback (env unset): defaults to https://careermonke.com`);
    passCount++;
  } else {
    console.error(`[FAIL] getSiteUrl() fallback: got ${fallbackBase}, expected https://careermonke.com`);
    failCount++;
  }

  const fallbackSitemap = sitemap();
  if (fallbackSitemap.every((entry) => entry.url.startsWith("https://careermonke.com"))) {
    console.log(`[PASS] sitemap() fallback (env unset): all ${fallbackSitemap.length} entries start with https://careermonke.com`);
    passCount++;
  } else {
    console.error(`[FAIL] sitemap() fallback failed`);
    failCount++;
  }

  const fallbackRobots = robots();
  if (fallbackRobots.sitemap === "https://careermonke.com/sitemap.xml") {
    console.log(`[PASS] robots() fallback (env unset): sitemap is https://careermonke.com/sitemap.xml`);
    passCount++;
  } else {
    console.error(`[FAIL] robots() fallback failed`);
    failCount++;
  }

  // Restore env
  if (originalEnv) {
    process.env.NEXT_PUBLIC_SITE_URL = originalEnv;
  } else {
    delete process.env.NEXT_PUBLIC_SITE_URL;
  }

  // Negative control verification
  if (IS_NEGATIVE_CONTROL) {
    // Assert a deliberately wrong expectation to prove non-zero exit
    console.log("\n[NEGATIVE CONTROL] Intentionally checking if invalid domain matches...");
    assert.strictEqual(fallbackBase, "https://untrusted-fake-domain.org", "Negative control triggered intentional failure");
  }

  console.log(`\n===============================================================================`);
  console.log(`DOMAIN RESOLUTION SUMMARY: ${passCount} PASSED, ${failCount} FAILED`);
  console.log(`===============================================================================\n`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runDomainResolutionSuite().catch((err) => {
  console.error("Test execution failed:", err.message);
  process.exit(1);
});
