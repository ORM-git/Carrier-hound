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

  // 4. Route stores sanitized attribution with the signup insert
  {
    let inserted: any = null;
    (globalThis as any).__mockSupabaseClient = {
      from: (table: string) => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: (row: any) => { inserted = row; return Promise.resolve({ error: null }); },
      }),
    };
    const { POST } = require("../src/app/api/early-access/route");
    const req: any = {
      headers: { get: () => null },
      json: async () => ({
        email: "attrib@example.com",
        attribution: { utmSource: "linkedin", utmCampaign: "waitlist", bogusKey: "drop-me" },
      }),
    };
    const res = await POST(req);
    const body = await res.json();
    assert.ok(body.ok, `request must succeed, got ${JSON.stringify(body)}`);
    assert.ok(inserted, "insert must have happened");
    assert.strictEqual(inserted.email, "attrib@example.com");
    assert.strictEqual(inserted.utm_source, "linkedin");
    assert.strictEqual(inserted.utm_campaign, "waitlist");
    assert.ok(!("bogusKey" in inserted) && !("bogus_key" in inserted), "unknown keys must not reach the insert");
    console.log("ok - /api/early-access stores sanitized attribution, drops unknown keys");
  }

  // 5. Route works unchanged when attribution is absent
  {
    let inserted: any = null;
    (globalThis as any).__mockSupabaseClient = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: (row: any) => { inserted = row; return Promise.resolve({ error: null }); },
      }),
    };
    const { POST } = require("../src/app/api/early-access/route");
    const req: any = { headers: { get: () => null }, json: async () => ({ email: "plain@example.com" }) };
    const res = await POST(req);
    assert.ok((await res.json()).ok);
    assert.deepStrictEqual(Object.keys(inserted).sort(), ["created_at", "email"], "no attribution keys when absent");
    console.log("ok - plain signup payload unchanged (no attribution keys)");
  }

  // 6. Migration pending: insert with columns 42703s -> retried without them
  {
    const attempts: any[] = [];
    (globalThis as any).__mockSupabaseClient = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: (row: any) => {
          attempts.push(row);
          if (attempts.length === 1) {
            return Promise.resolve({ error: { code: "42703", message: 'column "utm_source" does not exist' } });
          }
          return Promise.resolve({ error: null });
        },
      }),
    };
    const { POST } = require("../src/app/api/early-access/route");
    const req: any = {
      headers: { get: () => null },
      json: async () => ({ email: "retry@example.com", attribution: { utmSource: "x" } }),
    };
    const res = await POST(req);
    assert.ok((await res.json()).ok, "signup must succeed via the retry path");
    assert.strictEqual(attempts.length, 2, "one retry expected");
    assert.ok("utm_source" in attempts[0], "first attempt carries attribution");
    assert.ok(!("utm_source" in attempts[1]), "retry drops attribution columns");
    console.log("ok - pending-migration insert retries without attribution, signup succeeds");
  }

  // 7. Non-column insert errors are NOT retried
  {
    const attempts: any[] = [];
    (globalThis as any).__mockSupabaseClient = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
        insert: (row: any) => { attempts.push(row); return Promise.resolve({ error: { code: "23505", message: "duplicate key" } }); },
      }),
    };
    const { POST } = require("../src/app/api/early-access/route");
    const req: any = {
      headers: { get: () => null },
      json: async () => ({ email: "dup@example.com", attribution: { utmSource: "x" } }),
    };
    await POST(req);
    assert.strictEqual(attempts.length, 1, "duplicate-key errors must not trigger the retry");
    console.log("ok - non-column errors are not retried");
  }

  delete (globalThis as any).__mockSupabaseClient;
  console.log("\nAll attribution checks passed.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
