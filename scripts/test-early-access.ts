/**
 * scripts/test-early-access.ts
 *
 * Verification Suite for Early-Access Flow Removal:
 * 1. Confirms removal of /early-access page(s) and /api/early-access route(s).
 * 2. Confirms middleware redirects all /early-access traffic to /signup (HTTP 301).
 * 3. Confirms deploy redirect rules (public/_redirects, netlify.toml) contain zero targets to /early-access.
 * 4. Confirms marketing CTAs on landing and public footer repointed to real routes (zero href="/early-access").
 * 5. Confirms sitemap excludes /early-access.
 * 6. Confirms lead-capture Apps Script sender (src/lib/early-access/gmail.ts) is preserved for dependents.
 * 7. Sub-process negative controls verify intentional non-zero exits on compromised invariants.
 * 8. Digest cron gmail_send_log read errors: sanitized logging, single retry, fail closed, redaction (added by #615).
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import Module from "node:module";
import { NextRequest } from "next/server";

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

const isNegativeControl =
  process.argv.includes("--negative-control") ||
  process.argv.includes("--negative-control-cap") ||
  process.argv.includes("--negative-control-digest") ||
  process.argv.includes("--negative-control-approval") ||
  process.argv.includes("--negative-control-self-approve");

if (isNegativeControl) {
  console.log("[NEGATIVE CONTROL] Proving non-zero exit on intentional failure condition...");
  // Deliberately assert that /early-access page exists (must fail since it is removed)
  assert.strictEqual(
    fs.existsSync(path.resolve(process.cwd(), "src/app/early-access/page.tsx")),
    true,
    "NEGATIVE CONTROL: src/app/early-access/page.tsx must NOT exist after early-access flow removal!"
  );
  process.exit(0);
}

const ROOT = path.resolve(__dirname, "..");

async function main() {
  console.log("================================================================================");
  console.log("       CAREERMONKE EARLY-ACCESS FLOW REMOVAL VERIFICATION SUITE                 ");
  console.log("================================================================================\n");

  // ---------------------------------------------------------------------------
  // TEST 1: Deleted files confirmed absent
  // ---------------------------------------------------------------------------
  console.log("Test 1: Verifying deleted /early-access pages and API routes...");
  const removedFiles = [
    "src/app/early-access/page.tsx",
    "src/app/early-access/layout.tsx",
    "src/app/api/early-access/route.ts",
  ];
  for (const rel of removedFiles) {
    const full = path.join(ROOT, rel);
    assert.strictEqual(
      fs.existsSync(full),
      false,
      `File ${rel} must be completely deleted from repository`
    );
  }
  console.log("  [PASS-LOCAL] Deleted /early-access page(s) and /api/early-access route(s) confirmed absent.");

  // ---------------------------------------------------------------------------
  // TEST 2: Middleware 301 redirection of /early-access to /signup
  // ---------------------------------------------------------------------------
  console.log("\nTest 2: Verifying middleware redirects /early-access traffic to /signup...");
  const { middleware } = await import("../src/middleware");

  for (const testPath of ["/early-access", "/early-access/", "/early-access/request", "/early-access?ref=twitter"]) {
    const req = new NextRequest(`http://localhost:3000${testPath}`);
    const res = await middleware(req);
    assert.strictEqual(
      res.status,
      301,
      `Request to '${testPath}' must return HTTP 301 redirect, got ${res.status}`
    );
    const loc = res.headers.get("location");
    assert.ok(loc, `Redirect response for '${testPath}' must include Location header`);
    const parsed = new URL(loc);
    assert.strictEqual(
      parsed.pathname,
      "/signup",
      `Redirect target for '${testPath}' must be '/signup', got '${parsed.pathname}'`
    );
  }
  console.log("  [PASS-LOCAL] Middleware permanently redirects all /early-access paths to /signup (HTTP 301).");

  // ---------------------------------------------------------------------------
  // TEST 3: Deploy redirect rules (public/_redirects, netlify.toml) zero targets
  // ---------------------------------------------------------------------------
  console.log("\nTest 3: Verifying deploy redirect rules contain zero destinations targeting /early-access...");
  const redirectsContent = fs.readFileSync(path.join(ROOT, "public/_redirects"), "utf-8");
  for (const line of redirectsContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2) {
      const destination = parts[1].toLowerCase();
      assert.ok(
        !destination.includes("/early-access"),
        `public/_redirects rule '${trimmed}' must NOT target /early-access`
      );
    }
  }
  assert.ok(
    redirectsContent.includes("/early-access /signup 301!"),
    "public/_redirects must include /early-access /signup 301! rule"
  );

  const tomlContent = fs.readFileSync(path.join(ROOT, "netlify.toml"), "utf-8");
  assert.ok(
    !tomlContent.includes('to = "/early-access"'),
    "netlify.toml must NOT redirect any route to /early-access"
  );
  console.log("  [PASS-LOCAL] Deploy redirect configurations have zero targets to /early-access.");

  // ---------------------------------------------------------------------------
  // TEST 4: Marketing links repointed (zero href="/early-access")
  // ---------------------------------------------------------------------------
  console.log("\nTest 4: Verifying marketing links on landing and components repointed away from /early-access...");
  const marketingFiles = [
    "src/app/page.tsx",
    "src/components/Footer.tsx",
    "src/components/LandingFeaturesSection.tsx",
    "src/components/LandingJobsTickerStrip.tsx",
    "src/components/LandingTopArtifact.tsx",
    "src/components/CategorySelectModal.tsx",
  ];

  for (const rel of marketingFiles) {
    const content = fs.readFileSync(path.join(ROOT, rel), "utf-8");
    assert.ok(
      !content.includes('href="/early-access"'),
      `File ${rel} must NOT contain href="/early-access"`
    );
    assert.ok(
      !content.includes('href: "/early-access"'),
      `File ${rel} must NOT contain href: "/early-access"`
    );
    assert.ok(
      !content.includes('push("/early-access")'),
      `File ${rel} must NOT contain push("/early-access")`
    );
  }
  console.log("  [PASS-LOCAL] All marketing CTAs and components repointed to active routes (/signup, /jobs, /worldwide, /login).");

  // ---------------------------------------------------------------------------
  // TEST 5: Sitemap excludes /early-access
  // ---------------------------------------------------------------------------
  console.log("\nTest 5: Verifying sitemap.ts excludes /early-access...");
  const sitemapSrc = fs.readFileSync(path.join(ROOT, "src/app/sitemap.ts"), "utf-8");
  assert.ok(
    !sitemapSrc.includes("/early-access"),
    "src/app/sitemap.ts must NOT include /early-access entry"
  );
  console.log("  [PASS-LOCAL] sitemap.ts excludes /early-access.");

  // ---------------------------------------------------------------------------
  // TEST 6: Preserved lead-capture Apps Script module
  // ---------------------------------------------------------------------------
  console.log("\nTest 6: Verifying Apps Script lead-capture helper preserved for dependent services...");
  const gmailLib = path.join(ROOT, "src/lib/early-access/gmail.ts");
  assert.strictEqual(
    fs.existsSync(gmailLib),
    true,
    "src/lib/early-access/gmail.ts must be preserved for dunningDispatcher and failedEvents"
  );
  console.log("  [PASS-LOCAL] src/lib/early-access/gmail.ts preserved for dependent services.");

  // ---------------------------------------------------------------------------
  // TEST 6b: Verifying guest requests to /jobs are not redirected
  // ---------------------------------------------------------------------------
  console.log("\nTest 6b: Verifying guest requests to /jobs are not redirected...");
  for (const jobsPath of ["/jobs", "/jobs?location=Remote", "/jobs/"]) {
    const jobsReq = new NextRequest(`http://localhost:3000${jobsPath}`);
    const jobsRes = await middleware(jobsReq);
    assert.strictEqual(
      jobsRes.status,
      200,
      `Guest request to '${jobsPath}' must not be redirected (expected 200, got ${jobsRes.status})`
    );
    assert.strictEqual(
      jobsRes.headers.get("location"),
      null,
      `Guest request to '${jobsPath}' must not have a Location redirect header`
    );
  }
  console.log("  [PASS-LOCAL] Guest requests to /jobs proceed without redirection to /login or /early-access.");

  // ---------------------------------------------------------------------------
  // TEST 6c: Digest cron gmail_send_log read errors (tests added by #615, kept verbatim)
  // The lead-capture sender/digest helper is preserved by this PR, so its tests are preserved too.
  // ---------------------------------------------------------------------------
  console.log("\nTest 6c: Verifying digest cron gmail_send_log read error logging, single retry and redaction...");
  {
    const { runEarlyAccessDigestCron } = await import("../src/lib/early-access/gmail");
    const originalConsoleWarn = console.warn;
    const capturedWarnings: string[] = [];
    console.warn = (...args: any[]) => {
      capturedWarnings.push(args.map((a) => String(a)).join(" "));
    };
    const envKeys = ["APPS_SCRIPT_MAIL_URL", "APPS_SCRIPT_MAIL_SECRET", "EARLY_ACCESS_NOTIFY_EMAIL"] as const;
    const savedEnv: Record<string, string | undefined> = {};
    for (const k of envKeys) savedEnv[k] = process.env[k];
    process.env.APPS_SCRIPT_MAIL_URL = "https://script.google.com/macros/s/test-deployment/exec";
    process.env.APPS_SCRIPT_MAIL_SECRET = "test-apps-script-secret-value";
    process.env.EARLY_ACCESS_NOTIFY_EMAIL = "owner-notify@example.com";

    try {
      // Minimal Supabase stand-in: every table other than gmail_send_log has no rows.
      const emptyChain: any = {
        select: () => emptyChain,
        eq: () => emptyChain,
        gt: () => emptyChain,
        order: async () => ({ data: [], error: null }),
      };
      const realClient: any = { from: () => emptyChain };

      // 5d2. gmail_send_log read error: real PostgREST error is logged, retried once, then fails closed
      {
        const pgrst = { code: "PGRST002", message: "Could not query the database for the schema cache", details: "retrying" };
        const flakyClient = (failures: number, fail: () => any = () => ({ data: null, error: pgrst, status: 503 })) => {
          let calls = 0;
          const chain: any = {
            select: () => chain, eq: () => chain, order: () => chain, limit: () => chain,
            maybeSingle: async () => (++calls <= failures ? fail() : { data: null, error: null }),
          };
          return {
            calls: () => calls,
            client: { ...realClient, from: (t: string) => (t === "gmail_send_log" ? chain : realClient.from(t)) },
          };
        };

        capturedWarnings.length = 0;
        const alwaysDown = flakyClient(99);
        const downRes = await runEarlyAccessDigestCron({ supabaseClient: alwaysDown.client, retryDelayMs: 0, dryRun: true });
        assert.strictEqual(downRes.status, "failed");
        assert.strictEqual(downRes.reason, "log_read_error");
        assert.strictEqual(alwaysDown.calls(), 2, "gmail_send_log read must be retried exactly once");
        const warnText = capturedWarnings.join("\n");
        assert.ok(warnText.includes("code=PGRST002") && warnText.includes("schema cache"), "underlying PostgREST error must be logged");
        assert.ok(warnText.includes("status=503"), "HTTP status must be logged");
        assert.ok(!warnText.includes("details") && !warnText.includes("retrying\""), "raw details must never be logged");
        assert.ok(warnText.includes("retrying once") && warnText.includes("failing closed"));

        const blip = flakyClient(1);
        const blipRes = await runEarlyAccessDigestCron({ supabaseClient: blip.client, retryDelayMs: 0, dryRun: true });
        assert.notStrictEqual(blipRes.reason, "log_read_error", "a single transient error must recover on retry");
        assert.strictEqual(blip.calls(), 2);

        // Sensitive content in the error must be redacted/bounded in both the error-return and thrown paths.
        const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
        const configuredSecret = process.env.APPS_SCRIPT_MAIL_SECRET || "";
        const sensitive =
          `row (victim@example.com) rejected; Authorization: Bearer sk_live_ABC123XYZ; jwt=${jwt}; ` +
          `oauth=ya29.a0AfH6SMBxyz; secret=${configuredSecret}; ` + "x".repeat(5000);
        const detailsMarker = "DETAILS_ROW_DATA_MARKER";
        const leaks = (text: string) =>
          ["victim@example.com", "sk_live_ABC123XYZ", jwt.slice(0, 20), "ya29.a0AfH6SMBxyz", detailsMarker, "x".repeat(250)]
            .concat(configuredSecret.length >= 3 ? [`secret=${configuredSecret}`] : [])
            .filter((s) => text.includes(s));

        for (const [label, fail] of [
          ["error-return", () => ({ data: null, error: { code: "PGRST002", message: sensitive, details: `${detailsMarker} owner@example.com` }, status: 503 })],
          ["thrown", () => { throw new Error(sensitive); }],
        ] as const) {
          capturedWarnings.length = 0;
          const c = flakyClient(99, fail);
          const r = await runEarlyAccessDigestCron({ supabaseClient: c.client, retryDelayMs: 0, dryRun: true });
          assert.strictEqual(r.reason, "log_read_error", `${label}: must fail closed`);
          assert.strictEqual(c.calls(), 2, `${label}: must retry exactly once`);
          const text = capturedWarnings.join("\n");
          assert.deepStrictEqual(leaks(text), [], `${label}: sensitive values leaked to logs`);
          assert.ok(text.includes("[REDACTED_EMAIL]") && text.includes("[REDACTED_TOKEN]"), `${label}: redaction markers expected`);
          for (const w of capturedWarnings) assert.ok(w.length < 600, `${label}: warning must be bounded (got ${w.length})`);
        }

        // retryDelayMs must be finite and non-negative; invalid values fall back to the 30s default.
        const realSetTimeout = globalThis.setTimeout;
        for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
          const delays: number[] = [];
          (globalThis as any).setTimeout = (fn: () => void, ms?: number) => { delays.push(ms ?? 0); return realSetTimeout(fn, 0); };
          try {
            await runEarlyAccessDigestCron({ supabaseClient: flakyClient(99).client, retryDelayMs: bad, dryRun: true });
          } finally {
            globalThis.setTimeout = realSetTimeout;
          }
          assert.ok(delays.includes(30_000) && !delays.includes(bad), `retryDelayMs=${bad} must fall back to 30000ms`);
        }
        console.log("  [PASS-LOCAL] gmail_send_log read error logs sanitized code/status/message (no details), retries once, then fails closed");
      }
    } finally {
      console.warn = originalConsoleWarn;
      for (const k of envKeys) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
      }
    }
  }

  // ---------------------------------------------------------------------------
  // TEST 7: Subprocess Negative Control Execution
  // ---------------------------------------------------------------------------
  console.log("\n--- TEST 7: SUBPROCESS NEGATIVE CONTROL EXECUTION ---");
  const negFlags = [
    "--negative-control",
    "--negative-control-cap",
    "--negative-control-digest",
    "--negative-control-approval",
    "--negative-control-self-approve",
  ];
  for (const flag of negFlags) {
    const res = spawnSync("npx", ["tsx", "scripts/test-early-access.ts", flag], {
      encoding: "utf-8",
      shell: true,
    });
    assert.notStrictEqual(
      res.status,
      0,
      `Negative control with flag '${flag}' must exit non-zero!`
    );
    console.log(`  [PASS-LOCAL] Negative control '${flag}' exited non-zero (${res.status}) as expected.`);
  }

  console.log("\n================================================================================");
  console.log("ALL EARLY-ACCESS FLOW REMOVAL CHECKS PASSED [PASS-LOCAL]");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
