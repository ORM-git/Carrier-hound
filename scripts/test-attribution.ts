import assert from "assert";
import Module from "node:module";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any
) {
  if (request === "@cloudflare/next-on-pages") {
    return "virtual:@cloudflare/next-on-pages";
  }
  return originalResolve.call(this, request, parent, isMain, options);
};

require.cache["virtual:@cloudflare/next-on-pages"] = {
  id: "virtual:@cloudflare/next-on-pages",
  filename: "virtual:@cloudflare/next-on-pages",
  loaded: true,
  exports: {
    getRequestContext: () => {
      const sym = Symbol.for("__cloudflare-request-context__");
      return (globalThis as any)[sym];
    },
  },
} as any;

process.env.NODE_ENV = "test";

console.log("=".repeat(80));
console.log("           ATTRIBUTION SANITIZER + EARLY-ACCESS STORAGE AUDIT        ");
console.log("=".repeat(80) + "\n");

const { sanitizeAttribution, hasAttribution } = require("../src/lib/analytics/attribution");

async function main() {
  // 1. Known camelCase keys map to snake_case columns
  {
    const out = sanitizeAttribution({
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "launch",
      utmTerm: "jobs",
      utmContent: "ad-a",
      referrer: "https://google.com/search?q=x",
      landingPath: "/early-access",
      capturedAt: "2026-11-06T00:00:00Z",
    });
    assert.deepStrictEqual(out, {
      utm_source: "google",
      utm_medium: "cpc",
      utm_campaign: "launch",
      utm_term: "jobs",
      utm_content: "ad-a",
      referrer: "https://google.com/search?q=x",
      landing_path: "/early-access",
    });
    console.log("ok - known keys map to snake_case columns");
  }

  // 2. Non-objects and junk are dropped entirely
  {
    assert.deepStrictEqual(sanitizeAttribution(null), {});
    assert.deepStrictEqual(sanitizeAttribution("utm_source=x"), {});
    assert.deepStrictEqual(sanitizeAttribution([1, 2]), {});
    assert.deepStrictEqual(sanitizeAttribution({ utmSource: 42, utmMedium: {}, utmCampaign: "  " }), {});
    assert.ok(!hasAttribution(sanitizeAttribution(undefined)));
    console.log("ok - junk input yields no columns");
  }

  // 3. Length caps enforced (200 fields, 500 referrer)
  {
    const out = sanitizeAttribution({
      utmSource: "x".repeat(500),
      referrer: "y".repeat(900),
    });
    assert.strictEqual(out.utm_source.length, 200);
    assert.strictEqual(out.referrer.length, 500);
    console.log("ok - length caps enforced");
  }

  // 4. Verifying /api/early-access route has been removed for launch
  {
    const fs = require("node:fs");
    const path = require("node:path");
    const routeFile = path.resolve(process.cwd(), "src/app/api/early-access/route.ts");
    assert.strictEqual(fs.existsSync(routeFile), false, "/api/early-access/route.ts must be deleted");
    console.log("ok - /api/early-access route is retired and deleted from disk");
  }

  delete (globalThis as any).__mockSupabaseClient;
  console.log("\nAll attribution checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
