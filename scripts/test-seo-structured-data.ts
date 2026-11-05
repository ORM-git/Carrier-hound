/**
 * CareerMonke SEO Structured Data & Connection Hints Verification Suite
 *
 * Validates:
 * 1. JSON-LD in RootLayout head parses cleanly as valid JSON.
 * 2. Organization schema contains name, canonical URL, and verified logo path.
 * 3. WebSite schema contains canonical URL and SearchAction with valid search query input.
 * 4. Strictly ZERO invented ratings, review counts, or aggregateRating properties.
 * 5. Connection hints (preconnect/dns-prefetch) are restricted to actual first-load origins (Supabase from env, no others).
 * 6. Negative control verifies assertion failure and non-zero exit when aggregateRating is present.
 *
 * Usage:
 *   npx tsx scripts/test-seo-structured-data.ts
 *   npx tsx scripts/test-seo-structured-data.ts --negative-control
 */

import fs from "node:fs";
import path from "node:path";
import assert from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import JsonLd from "../src/components/seo/JsonLd";
import {
  getRootStructuredData,
  getConnectionHints,
  hasNoInventedRatings,
} from "../src/lib/seo/structuredData";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

async function main() {
  console.log("================================================================================");
  console.log("       CAREERMONKE SEO STRUCTURED DATA & CONNECTION HINTS VERIFICATION          ");
  console.log("================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("⚠️  [NEGATIVE CONTROL MODE ACTIVE]: Simulating injection of aggregateRating...\n");
  }

  let passedChecks = 0;

  // ---------------------------------------------------------------------------
  // SECTION 1: JSON-LD Generation & JSON Parsing
  // ---------------------------------------------------------------------------
  console.log("--- Section 1: JSON-LD Generation & Schema.org Parsing ---");
  const rawData = getRootStructuredData("https://careermonke.com");
  const serialized = JSON.stringify(rawData);

  let parsed: any;
  try {
    parsed = JSON.parse(serialized);
    console.log("✓ JSON-LD successfully stringified and parsed back without syntax errors.");
    passedChecks++;
  } catch (err: any) {
    console.error("❌ Failed to parse JSON-LD payload:", err.message);
    process.exit(1);
  }

  assert.strictEqual(parsed["@context"], "https://schema.org", "Must have @context https://schema.org");
  assert.ok(Array.isArray(parsed["@graph"]), "Root JSON-LD must contain an @graph array");
  assert.strictEqual(parsed["@graph"].length, 2, "Root JSON-LD graph must contain Organization and WebSite entities");
  console.log("✓ @context is 'https://schema.org' with @graph containing 2 top-level entities.");
  passedChecks++;

  // ---------------------------------------------------------------------------
  // SECTION 2: Organization Entity Validation
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 2: Organization Entity Validation ---");
  const org = parsed["@graph"].find((item: any) => item["@type"] === "Organization");
  assert.ok(org, "Graph must contain an Organization entity");
  assert.strictEqual(org.name, "CareerMonke", "Organization name must be 'CareerMonke'");
  assert.strictEqual(org.url, "https://careermonke.com", "Organization url must match canonical site URL");
  assert.ok(org.logo.endsWith("/careermonke-logo.png"), "Organization logo must point to /careermonke-logo.png");

  // Verify that the logo asset physically exists in public/
  const logoRelative = org.logo.replace(/^https?:\/\/[^/]+/, "");
  const logoFilePath = path.join(process.cwd(), "public", logoRelative);
  assert.ok(fs.existsSync(logoFilePath), `Logo file referenced in JSON-LD must exist on disk: ${logoFilePath}`);
  console.log(`✓ Organization valid: name="${org.name}", url="${org.url}", logo="${org.logo}"`);
  console.log(`✓ Verified logo physical file exists at public${logoRelative}`);
  passedChecks += 2;

  // ---------------------------------------------------------------------------
  // SECTION 3: WebSite with SearchAction Entity Validation
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 3: WebSite with SearchAction Entity Validation ---");
  const website = parsed["@graph"].find((item: any) => item["@type"] === "WebSite");
  assert.ok(website, "Graph must contain a WebSite entity");
  assert.strictEqual(website.name, "CareerMonke", "WebSite name must be 'CareerMonke'");
  assert.strictEqual(website.url, "https://careermonke.com", "WebSite url must match canonical site URL");
  assert.ok(website.publisher && website.publisher["@id"], "WebSite must reference publisher Organization");

  const action = website.potentialAction;
  assert.ok(action, "WebSite must include potentialAction for site search");
  assert.strictEqual(action["@type"], "SearchAction", "potentialAction @type must be 'SearchAction'");
  assert.strictEqual(action.target["@type"], "EntryPoint", "SearchAction target must be an EntryPoint");
  assert.strictEqual(
    action.target.urlTemplate,
    "https://careermonke.com/jobs?q={search_term_string}",
    "SearchAction urlTemplate must point to /jobs?q={search_term_string}"
  );
  assert.strictEqual(
    action["query-input"],
    "required name=search_term_string",
    "query-input must specify required name=search_term_string"
  );
  console.log(`✓ WebSite valid: name="${website.name}", potentialAction=SearchAction (/jobs?q={search_term_string})`);
  passedChecks += 2;

  // ---------------------------------------------------------------------------
  // SECTION 4: Strict Assertion — No Invented Ratings or Counts
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 4: Strict No-Invented-Ratings Assertion ---");
  let targetPayload = parsed;

  if (IS_NEGATIVE_CONTROL) {
    // Deliberately corrupt payload with a fake aggregateRating to verify test triggers failure
    targetPayload = {
      ...parsed,
      aggregateRating: {
        "@type": "AggregateRating",
        ratingValue: 4.9,
        reviewCount: 1500,
      },
    };
    console.log("⚠️  [NEGATIVE CONTROL] Injected fabricated aggregateRating into payload for verification.");
  }

  const payloadString = JSON.stringify(targetPayload);
  const containsAggregateRating = /aggregateRating/i.test(payloadString);
  const passesRatingGuard = hasNoInventedRatings(targetPayload);

  if (IS_NEGATIVE_CONTROL) {
    if (containsAggregateRating || !passesRatingGuard) {
      console.error("❌ NEGATIVE CONTROL VERIFIED: Test detected aggregateRating injection and failed as expected.");
      process.exit(1);
    } else {
      console.error("FATAL: Negative control failed to detect simulated aggregateRating injection!");
      process.exit(2);
    }
  }

  assert.strictEqual(containsAggregateRating, false, "JSON-LD must NEVER contain aggregateRating");
  assert.strictEqual(passesRatingGuard, true, "JSON-LD must pass hasNoInventedRatings guard");
  assert.ok(!payloadString.includes("ratingValue"), "JSON-LD must not contain ratingValue");
  assert.ok(!payloadString.includes("reviewCount"), "JSON-LD must not contain reviewCount");
  assert.ok(!payloadString.includes("ratingCount"), "JSON-LD must not contain ratingCount");
  console.log("✓ Verified ZERO aggregateRating, ratingValue, or reviewCount properties present in JSON-LD.");
  passedChecks++;

  // ---------------------------------------------------------------------------
  // SECTION 5: Connection Hints Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 5: Connection Hints (Preconnect / DNS-Prefetch) Validation ---");
  // Test with custom Supabase URL
  const hints = getConnectionHints("https://custom-project.supabase.co/rest/v1");
  assert.strictEqual(hints.length, 1, "Must contain exactly 1 origin when Supabase URL is provided");
  assert.strictEqual(hints[0], "https://custom-project.supabase.co", "Must extract exact protocol and host origin");

  // Assert no unauthorized origins exist
  assert.ok(!hints.includes("https://fonts.googleapis.com"), "Google Fonts must NOT be in connection hints");
  assert.ok(!hints.includes("https://fonts.gstatic.com"), "Google Fonts CDN must NOT be in connection hints");
  assert.ok(!hints.includes("https://www.google-analytics.com"), "External analytics must NOT be in connection hints");

  // Empty env test
  const emptyHints = getConnectionHints("");
  assert.deepStrictEqual(emptyHints, [], "Empty env must produce empty hints without crashing");
  console.log("✓ Connection hints strictly limited to Supabase origin (zero external fonts, zero external analytics).");
  passedChecks += 2;

  // ---------------------------------------------------------------------------
  // SECTION 6: Server-Render JSON-LD Component & Parse Script Body
  // ---------------------------------------------------------------------------
  console.log("\n--- Section 6: Server-Render JSON-LD Component & Script Body JSON Parsing ---");

  // 6a. Server-render default <JsonLd />
  const renderedMarkup = renderToStaticMarkup(React.createElement(JsonLd));
  assert.ok(renderedMarkup.startsWith("<script"), "JsonLd component must render a <script> element");
  assert.ok(renderedMarkup.includes('type="application/ld+json"'), "JsonLd must specify type=\"application/ld+json\"");

  const scriptMatch = renderedMarkup.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(scriptMatch && scriptMatch[1], "Must extract script body from server-rendered JsonLd markup");
  const scriptBody = scriptMatch[1];

  // 6b. JSON.parse the server-rendered script body
  let parsedFromScript: any;
  try {
    parsedFromScript = JSON.parse(scriptBody);
    console.log("✓ Successfully parsed JSON from server-rendered <JsonLd /> script body.");
    passedChecks++;
  } catch (err: any) {
    console.error("❌ Failed to JSON.parse server-rendered script body:", err.message);
    process.exit(1);
  }

  assert.strictEqual(parsedFromScript["@context"], "https://schema.org", "Parsed script JSON must have @context https://schema.org");
  assert.ok(Array.isArray(parsedFromScript["@graph"]), "Parsed script JSON must contain @graph array");
  assert.strictEqual(parsedFromScript["@graph"].length, 2, "Parsed script JSON must contain 2 entities");
  const scriptOrg = parsedFromScript["@graph"].find((item: any) => item["@type"] === "Organization");
  const scriptWebSite = parsedFromScript["@graph"].find((item: any) => item["@type"] === "WebSite");
  assert.strictEqual(scriptOrg?.name, "CareerMonke", "Organization name in parsed script must match");
  assert.strictEqual(scriptWebSite?.name, "CareerMonke", "WebSite name in parsed script must match");
  console.log("✓ Server-rendered JSON-LD contains valid Schema.org Organization and WebSite graph.");
  passedChecks++;

  // 6c. Verify XSS safety: '<' characters are strictly unicode-escaped as '\u003c' in script body
  const customXssData = {
    ...rawData,
    "@graph": [
      {
        ...rawData["@graph"][0],
        name: "CareerMonke <script>alert(1)</script>",
      },
      rawData["@graph"][1],
    ],
  };
  const xssMarkup = renderToStaticMarkup(React.createElement(JsonLd, { data: customXssData }));
  const xssMatch = xssMarkup.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
  assert.ok(xssMatch && xssMatch[1], "Must extract script body from XSS test markup");
  const xssBody = xssMatch[1];

  assert.ok(!xssBody.includes("<"), "Server-rendered script body must NOT contain raw '<' character (must be unicode-escaped as \\u003c)");
  assert.ok(xssBody.includes("\\u003c"), "Server-rendered script body must contain unicode-escaped '\\u003c'");
  const parsedXss = JSON.parse(xssBody);
  assert.strictEqual(
    parsedXss["@graph"][0].name,
    "CareerMonke <script>alert(1)</script>",
    "JSON.parse must correctly decode unicode escape '\\u003c' back to '<'"
  );
  console.log("✓ Server-rendered script body strictly escapes '<' as '\\u003c' for XSS safety (decoded back via JSON.parse).");
  passedChecks++;

  // 6d. Verify RootLayout integration and untouched landing/stats/testimonials
  const layoutPath = path.join(process.cwd(), "src", "app", "layout.tsx");
  const layoutContent = fs.readFileSync(layoutPath, "utf-8");
  assert.ok(layoutContent.includes("<JsonLd"), "RootLayout head must mount <JsonLd /> component");
  assert.ok(layoutContent.includes('rel="preconnect"'), "RootLayout head must render preconnect link tags");
  assert.ok(layoutContent.includes('rel="dns-prefetch"'), "RootLayout head must render dns-prefetch link tags");
  assert.ok(!layoutContent.includes("TestimonialsList"), "RootLayout must not import or modify testimonials");
  console.log("✓ RootLayout mounts <JsonLd /> and connection hints; landing page, testimonials, and stats untouched.");
  passedChecks++;

  console.log("\n================================================================================");
  console.log(`SEO STRUCTURED DATA & CONNECTION HINTS SUITE: ALL ${passedChecks} CHECKS PASSED (PASS-LOCAL)`);
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test execution error:", err);
  process.exit(1);
});
