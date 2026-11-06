/**
 * Rich Results QA validation (offline, runs in test:all).
 *
 * Validates the JSON-LD builders against the fields Google requires for the
 * rich result types we ship (Organization, WebSite + SearchAction,
 * BreadcrumbList), so a regression in src/lib/seo/structuredData.ts fails CI
 * before Google's Rich Results Test ever sees it. No network calls.
 *
 * Rules checked (per Google Search documentation):
 * - Organization: name, url, logo (absolute URLs)
 * - WebSite: name, url; SearchAction with EntryPoint urlTemplate containing
 *   {search_term_string} and a query-input
 * - BreadcrumbList: 2+ ListItems, sequential positions from 1, name and
 *   absolute item URL each
 */

import assert from "node:assert";
import {
  getRootStructuredData,
  getBreadcrumbJsonLd,
} from "../src/lib/seo/structuredData";

const SITE = "https://careermonke.com";

function assertAbsoluteUrl(value: unknown, label: string): void {
  assert.ok(typeof value === "string" && /^https:\/\/.+/.test(value as string), `${label} must be an absolute https URL, got: ${String(value)}`);
}

let checks = 0;
function ok(message: string): void {
  checks += 1;
  console.log(`  -> [PASS] ${message}`);
}

console.log("Rich Results structured-data validation (offline)");

// 1. Root graph: Organization + WebSite
const root = getRootStructuredData(SITE) as unknown as {
  "@context": string;
  "@graph": Array<Record<string, unknown>>;
};
assert.strictEqual(root["@context"], "https://schema.org", "root @context");
ok("root graph has schema.org context");

const org = root["@graph"].find((n) => n["@type"] === "Organization");
assert.ok(org, "Organization node present");
assert.ok(org!.name && String(org!.name).length > 0, "Organization.name required");
assertAbsoluteUrl(org!.url, "Organization.url");
assertAbsoluteUrl(org!.logo, "Organization.logo");
ok("Organization has required name, url, logo (absolute)");

const site = root["@graph"].find((n) => n["@type"] === "WebSite");
assert.ok(site, "WebSite node present");
assert.ok(site!.name && String(site!.name).length > 0, "WebSite.name required");
assertAbsoluteUrl(site!.url, "WebSite.url");
ok("WebSite has required name, url");

const action = site!.potentialAction as Record<string, unknown> | undefined;
assert.ok(action && action["@type"] === "SearchAction", "WebSite.potentialAction is SearchAction");
const target = action!.target as Record<string, unknown> | undefined;
assert.ok(target && target["@type"] === "EntryPoint", "SearchAction.target is EntryPoint");
const urlTemplate = String(target!.urlTemplate || "");
assert.ok(urlTemplate.includes("{search_term_string}"), "urlTemplate must contain {search_term_string}");
assert.ok(/^https:\/\//.test(urlTemplate), "urlTemplate must be absolute https");
assert.ok(typeof action!["query-input"] === "string" && (action!["query-input"] as string).includes("search_term_string"), "query-input required");
ok("SearchAction has EntryPoint urlTemplate + query-input");

// 2. BreadcrumbList
const trail = [
  { name: "Home", path: "/" },
  { name: "Remote Jobs", path: "/remote" },
  { name: "Pricing", path: "/pricing" },
];
const crumbs = getBreadcrumbJsonLd(trail, SITE) as unknown as {
  "@type": string;
  itemListElement: Array<Record<string, unknown>>;
};
assert.strictEqual(crumbs["@type"], "BreadcrumbList", "breadcrumb @type");
assert.ok(Array.isArray(crumbs.itemListElement) && crumbs.itemListElement.length >= 2, "BreadcrumbList needs at least 2 ListItems");
crumbs.itemListElement.forEach((item, i) => {
  assert.strictEqual(item["@type"], "ListItem", `item ${i} @type`);
  assert.strictEqual(item.position, i + 1, `item ${i} position must be ${i + 1}`);
  assert.ok(item.name && String(item.name).length > 0, `item ${i} name required`);
  assertAbsoluteUrl(item.item, `item ${i} item URL`);
});
ok(`BreadcrumbList valid: ${crumbs.itemListElement.length} ListItems, sequential positions, absolute URLs`);

// 3. Stability: no invented rich-result fields we do not qualify for
const serialized = JSON.stringify(root);
for (const banned of ["aggregateRating", "review", "priceRange"]) {
  assert.ok(!serialized.includes(`"${banned}"`), `root graph must not invent ${banned}`);
}
ok("no invented aggregateRating/review/priceRange fields");

console.log(`\nAll ${checks} structured-data validation groups passed.`);
