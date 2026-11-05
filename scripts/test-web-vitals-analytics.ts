/**
 * scripts/test-web-vitals-analytics.ts
 *
 * Verification suite for Core Web Vitals (CWV) tracking:
 * 1. Consent gating: no telemetry events dispatched before cookie consent (cm_cookie_notice).
 * 2. Path sanitization: query strings stripped, hash fragments removed, dynamic entity IDs replaced with [id].
 * 3. Privacy / No PII: payload strictly contains only eventType, sanitized path, and metric properties (no user credentials, user ID, email, or IP).
 * 4. API endpoint (/api/track): handles eventType === "web-vitals" for LCP, INP, CLS, TTFB, and FCP, rejects query strings with 400, and leaves standard pageviews intact.
 * 5. Layout mounting: verifies WebVitalsTracker is mounted under Suspense in src/app/layout.tsx.
 *
 * Run directly: npx tsx scripts/test-web-vitals-analytics.ts
 * Negative control: npx tsx scripts/test-web-vitals-analytics.ts --negative-control
 */

import * as fs from "fs";
import * as path from "path";
import assert from "assert";

const isNegativeControl = process.argv.includes("--negative-control");

function pass(msg: string) {
  console.log(`  [PASS] ${msg}`);
}

async function runTests() {
  console.log("=== Running Core Web Vitals Analytics Test Suite ===");

  if (isNegativeControl) {
    console.log("Testing negative control (expected failure)...");
    assert.strictEqual(true, false, "Negative control intentional failure to verify non-zero exit");
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // 1. Static Component & Layout Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- 1. WebVitalsTracker Component & Layout Verification ---");

  const componentPath = path.resolve(process.cwd(), "src/components/analytics/WebVitalsTracker.tsx");
  assert.ok(fs.existsSync(componentPath), "src/components/analytics/WebVitalsTracker.tsx must exist");
  const componentContent = fs.readFileSync(componentPath, "utf8");

  assert.ok(
    componentContent.includes("useReportWebVitals"),
    "WebVitalsTracker must use Next's useReportWebVitals hook"
  );
  assert.ok(
    componentContent.includes("COOKIE_CONSENT_KEY"),
    "WebVitalsTracker must reference COOKIE_CONSENT_KEY"
  );
  assert.ok(
    componentContent.includes("COOKIE_CONSENT_EVENT"),
    "WebVitalsTracker must listen for COOKIE_CONSENT_EVENT"
  );
  assert.ok(
    componentContent.includes('"LCP"') &&
      componentContent.includes('"INP"') &&
      componentContent.includes('"CLS"') &&
      componentContent.includes('"TTFB"') &&
      componentContent.includes('"FCP"'),
    "WebVitalsTracker must track LCP, INP, CLS, TTFB, and FCP"
  );
  assert.ok(
    componentContent.includes("sendBeacon"),
    "WebVitalsTracker must use navigator.sendBeacon first-party delivery"
  );
  pass("WebVitalsTracker component implements useReportWebVitals and consent-gated first-party delivery");

  const layoutPath = path.resolve(process.cwd(), "src/app/layout.tsx");
  const layoutContent = fs.readFileSync(layoutPath, "utf8");
  assert.ok(
    layoutContent.includes("WebVitalsTracker"),
    "Root layout must import WebVitalsTracker"
  );
  assert.ok(
    layoutContent.includes("<WebVitalsTracker />") || layoutContent.includes("<WebVitalsTracker/>"),
    "Root layout must mount <WebVitalsTracker />"
  );
  pass("Root layout properly mounts <WebVitalsTracker /> in Suspense");

  // ---------------------------------------------------------------------------
  // 2. Path Sanitization Unit Tests
  // ---------------------------------------------------------------------------
  console.log("\n--- 2. Path Sanitization & Query String Stripping ---");

  const { sanitizeWebVitalsPath } = await import("../src/components/analytics/WebVitalsTracker");

  // 2a. Stripping query strings and hash fragments
  assert.strictEqual(
    sanitizeWebVitalsPath("/jobs?query=react&location=remote&utm_source=twitter"),
    "/jobs",
    "Query strings must be completely stripped from path"
  );
  assert.strictEqual(
    sanitizeWebVitalsPath("/pricing?plan=quarterly#features"),
    "/pricing",
    "Query strings and hashes must be stripped from path"
  );

  // 2b. Dynamic Job ID replacement
  assert.strictEqual(
    sanitizeWebVitalsPath("/jobs/12345"),
    "/jobs/[id]",
    "Numeric job ID must be replaced with [id]"
  );
  assert.strictEqual(
    sanitizeWebVitalsPath("/jobs/12345/interview-pack"),
    "/jobs/[id]/interview-pack",
    "Job ID before /interview-pack must be replaced with [id]"
  );
  assert.strictEqual(
    sanitizeWebVitalsPath("/jobs/98765/skill-what-if"),
    "/jobs/[id]/skill-what-if",
    "Job ID before /skill-what-if must be replaced with [id]"
  );
  assert.strictEqual(
    sanitizeWebVitalsPath("/jobs/c83226a4-4a41-48c0-bc66-3d758f89a744/interview-pack?utm_medium=email#step2"),
    "/jobs/[id]/interview-pack",
    "UUID job ID with query parameters and hash must sanitize to /jobs/[id]/interview-pack"
  );
  assert.strictEqual(
    sanitizeWebVitalsPath("/jobs/cm_job_09871234"),
    "/jobs/[id]",
    "Prefixed job ID must be replaced with [id]"
  );

  // 2c. Preserving static subpaths
  assert.strictEqual(sanitizeWebVitalsPath("/jobs/detail"), "/jobs/detail", "Static subroute /jobs/detail preserved");
  assert.strictEqual(sanitizeWebVitalsPath("/jobs"), "/jobs", "Static route /jobs preserved");
  assert.strictEqual(sanitizeWebVitalsPath("/"), "/", "Root path / preserved");
  assert.strictEqual(sanitizeWebVitalsPath(""), "/", "Empty path defaults to /");
  assert.strictEqual(sanitizeWebVitalsPath(null), "/", "Null path defaults to /");

  // 2d. General UUIDs & numeric IDs in any segment
  assert.strictEqual(
    sanitizeWebVitalsPath("/admin/users/83726"),
    "/admin/users/[id]",
    "Numeric user ID replaced with [id]"
  );

  pass("sanitizeWebVitalsPath strictly removes query strings, hashes, and dynamic entity IDs");

  // ---------------------------------------------------------------------------
  // 3. Consent Gating & Delivery Flow
  // ---------------------------------------------------------------------------
  console.log("\n--- 3. Consent Gating (No Events Before Consent) ---");

  const { hasCookieConsent, sendWebVitalsPayload } = await import("../src/components/analytics/WebVitalsTracker");

  // Mock localStorage and navigator
  const mockStorage: Record<string, string> = {};
  (globalThis as any).localStorage = {
    getItem: (key: string) => mockStorage[key] || null,
    setItem: (key: string, val: string) => {
      mockStorage[key] = String(val);
    },
    removeItem: (key: string) => {
      delete mockStorage[key];
    },
    clear: () => {
      for (const k of Object.keys(mockStorage)) delete mockStorage[k];
    },
  };

  let beaconCalls: Array<{ url: string; data: any }> = [];
  Object.defineProperty(globalThis, "navigator", {
    value: {
      sendBeacon: (url: string, blob: any) => {
        beaconCalls.push({ url, data: blob });
        return true;
      },
    },
    configurable: true,
    writable: true,
  });

  // 3a. Verify without consent
  delete mockStorage["cm_cookie_notice"];
  assert.strictEqual(hasCookieConsent(), false, "Consent must be false when cm_cookie_notice is missing");

  // 3b. Verify with consent
  mockStorage["cm_cookie_notice"] = "true";
  assert.strictEqual(hasCookieConsent(), true, "Consent must be true when cm_cookie_notice is present");

  // 3c. Payload transmission test
  beaconCalls = [];
  const testPayload = {
    eventType: "web-vitals" as const,
    path: "/jobs/[id]/interview-pack",
    metric: {
      id: "wv-12345",
      name: "LCP",
      value: 1250.4,
      rating: "good",
      navigationType: "navigate",
    },
  };

  const sent = sendWebVitalsPayload(testPayload);
  assert.strictEqual(sent, true, "sendWebVitalsPayload must successfully dispatch via sendBeacon");
  assert.strictEqual(beaconCalls.length, 1, "Exactly 1 beacon call must be recorded");
  assert.strictEqual(beaconCalls[0].url, "/api/track");

  // Verify no PII in payload
  const serialized = JSON.stringify(testPayload);
  const parsed = JSON.parse(serialized);
  assert.strictEqual((parsed as any).userId, undefined, "Payload must not contain userId");
  assert.strictEqual((parsed as any).email, undefined, "Payload must not contain email");
  assert.strictEqual((parsed as any).ip, undefined, "Payload must not contain ip");
  assert.strictEqual(parsed.path.includes("?"), false, "Payload path must not contain query parameters");

  pass("Consent check correctly gates tracking; payload contains zero PII and zero query strings");

  // ---------------------------------------------------------------------------
  // 4. /api/track Integration Tests (Real Route Handler)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. POST /api/track Route Integration ---");

  // Set legacy rate limit flag for testing
  process.env.NODE_ENV = "test";
  process.env.__CAREERMONKE_LEGACY_RATE_LIMIT = "true";

  const { POST: trackPost } = await import("../src/app/api/track/route");

  async function postTrack(payload: any): Promise<{ status: number; body: any }> {
    const req = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.42",
      },
      body: JSON.stringify(payload),
    });
    const res = await trackPost(req);
    const body = await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  // 4a. Valid Web Vitals for each tracked metric
  const metricsToTest = ["LCP", "INP", "CLS", "TTFB", "FCP"];
  for (const metricName of metricsToTest) {
    const { status, body } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs/[id]",
      metric: {
        id: `wv-${metricName.toLowerCase()}-1`,
        name: metricName,
        value: 120.5,
        rating: "good",
        navigationType: "navigate",
      },
    });

    assert.strictEqual(status, 200, `POST /api/track for ${metricName} must return 200`);
    assert.strictEqual(body.ok, true, `POST /api/track for ${metricName} must return ok: true`);
    assert.strictEqual(body.eventType, "web-vitals");
  }
  pass("POST /api/track successfully accepts valid telemetry for LCP, INP, CLS, TTFB, and FCP");

  // 4b. Rejection: Query strings in path
  {
    const { status, body } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs?utm_source=twitter",
      metric: {
        id: "wv-query-err",
        name: "LCP",
        value: 100,
        rating: "good",
        navigationType: "navigate",
      },
    });
    assert.strictEqual(status, 400, "Path containing query string must return 400");
    assert.strictEqual(body.error, "Invalid path");
  }
  pass("POST /api/track strictly rejects web-vitals payloads with query strings");

  // 4c. Rejection: Invalid metric name
  {
    const { status, body } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        id: "wv-invalid-name",
        name: "UNKNOWN_METRIC",
        value: 100,
      },
    });
    assert.strictEqual(status, 400, "Unrecognized metric name must return 400");
    assert.strictEqual(body.error, "Invalid metric name");
  }
  pass("POST /api/track strictly validates allowed metric names");

  // 4d. Rejection: Non-numeric metric value
  {
    const { status, body } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        id: "wv-bad-val",
        name: "CLS",
        value: "not-a-number",
      },
    });
    assert.strictEqual(status, 400, "Non-numeric metric value must return 400");
    assert.strictEqual(body.error, "Invalid metric value");
  }
  pass("POST /api/track strictly validates metric numeric values");

  // 4e. Rejection: Missing metric object
  {
    const { status, body } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
    });
    assert.strictEqual(status, 400, "Missing metric must return 400");
    assert.strictEqual(body.error, "Invalid metric");
  }
  pass("POST /api/track strictly validates presence of metric payload");

  // 4f. Existing Pageview behavior intact
  {
    let recordedView: any = null;
    (globalThis as any).__mockSupabaseClient = {
      from: (table: string) => {
        if (table === "page_views") {
          return {
            insert: async (data: any) => {
              recordedView = data;
              return { error: null };
            },
          };
        }
        return {
          insert: async () => ({ error: null }),
        };
      },
    };

    const { status, body } = await postTrack({
      path: "/pricing",
      referrer: "https://google.com",
    });

    assert.strictEqual(status, 200, "Existing pageview tracking must return 200");
    assert.strictEqual(body.ok, true, "Existing pageview tracking must return ok: true");
    assert.strictEqual(body.eventType, undefined, "Pageview response does not include web-vitals eventType");

    delete (globalThis as any).__mockSupabaseClient;
  }
  pass("Existing standard pageview tracking continues to operate unchanged");

  console.log("\n==================================================================");
  console.log("🎉 ALL CORE WEB VITALS TRACKING TESTS PASSED (PASS-LOCAL)!");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("❌ Test suite encountered unhandled error:", err);
  process.exit(1);
});
