/**
 * Row 64 (index bloat / canonical route cleanup): guards that the /privacy
 * alias cannot drift back into a duplicate-content route.
 * 1. netlify.toml carries a 301 /privacy -> /privacy-policy edge redirect.
 * 2. The legacy alias page (kept for non-Netlify static hosts) re-exports
 *    the primary page, so its rendered canonical always tracks the primary.
 * 3. The sitemap lists only canonical public URLs (no aliases).
 */
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..");
let passed = 0;
let failed = 0;
function check(cond: boolean, label: string): void {
  if (cond) { passed += 1; console.log(`PASS: ${label}`); }
  else { failed += 1; console.log(`FAIL: ${label}`); }
}

const netlify = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf8");
check(
  /from\s*=\s*"\/privacy"\s*\n\s*to\s*=\s*"\/privacy-policy"\s*\n\s*status\s*=\s*301/.test(netlify),
  "netlify.toml: /privacy 301-redirects to /privacy-policy"
);

const alias = fs.readFileSync(path.join(ROOT, "src/app/privacy/page.tsx"), "utf8").trim();
check(
  alias === 'export { default, metadata } from "../privacy-policy/page";',
  "alias page re-exports the primary page (canonical inherits /privacy-policy)"
);

const primary = fs.readFileSync(path.join(ROOT, "src/app/privacy-policy/page.tsx"), "utf8");
check(
  primary.includes('canonical: "https://careermonke.com/privacy-policy"'),
  "primary page canonical is the absolute /privacy-policy URL"
);

const sitemap = fs.readFileSync(path.join(ROOT, "src/app/sitemap.ts"), "utf8");
check(sitemap.includes("/privacy-policy"), "sitemap lists /privacy-policy");
check(!sitemap.includes("`${baseUrl}/privacy`") && !sitemap.includes('"/privacy"'), "sitemap does not list the /privacy alias");

console.log(`\ncanonical-routes: ${passed} PASS, ${failed} FAIL`);
process.exit(failed === 0 ? 0 : 1);
