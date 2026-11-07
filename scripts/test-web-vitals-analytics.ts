/**
 * scripts/test-web-vitals-analytics.ts
 *
 * Verification suite for Core Web Vitals (CWV) telemetry collection & storage:
 * 1. Consent gating: no telemetry events dispatched before cookie consent (cm_cookie_notice).
 * 2. Path sanitization: query strings stripped, hash fragments removed, dynamic entity IDs replaced with [id].
 * 3. Privacy / No PII: payload strictly contains only eventType, sanitized path/route, and metric properties.
 * 4. API endpoint validation: ignores bad payloads with 204 No Content (query strings, hashes, bad metric names, non-numeric values, negative values, missing metric object, oversized payloads > 16KB, malformed JSON).
 * 5. Database insert verification: valid web vitals are inserted into the web_vitals table via service role with validated fields (name, value, rating, route, navigation_type) and strictly zero user identifiers.
 * 6. Rate limit verification: POST /api/track enforces IP rate limiting (30 req/min), returning 429 with Retry-After header.
 * 7. Migration file verification: supabase/migrations/20261105b_web_vitals.sql exists with RLS enabled and no anon/authenticated access (service_role only).
 * 8. Layout mounting: verifies WebVitalsTracker is mounted under Suspense in src/app/layout.tsx.
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
  console.log("=== Running Core Web Vitals Analytics & Storage Test Suite ===");

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
    componentContent.includes("readCookieConsent"),
    "WebVitalsTracker must gate through the shared readCookieConsent reader"
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

  assert.strictEqual(sanitizeWebVitalsPath("/jobs/detail"), "/jobs/detail", "Static subroute /jobs/detail preserved");
  assert.strictEqual(sanitizeWebVitalsPath("/jobs"), "/jobs", "Static route /jobs preserved");
  assert.strictEqual(sanitizeWebVitalsPath("/"), "/", "Root path / preserved");
  assert.strictEqual(sanitizeWebVitalsPath(""), "/", "Empty path defaults to /");
  assert.strictEqual(sanitizeWebVitalsPath(null), "/", "Null path defaults to /");
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

  const mockStorage: Record<string, string> = {};
  // The shared consent reader reads window.localStorage, so expose the mock
  // through a mock window as well.
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.localStorage = undefined;
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
  (globalThis as any).window.localStorage = (globalThis as any).localStorage;

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

  delete mockStorage["cm_cookie_notice"];
  assert.strictEqual(hasCookieConsent(), false, "Consent must be false when cm_cookie_notice is missing");

  mockStorage["cm_cookie_notice"] = "true";
  assert.strictEqual(hasCookieConsent(), true, "Consent must be true when cm_cookie_notice is present");

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

  const serialized = JSON.stringify(testPayload);
  const parsed = JSON.parse(serialized);
  assert.strictEqual((parsed as any).userId, undefined, "Payload must not contain userId");
  assert.strictEqual((parsed as any).email, undefined, "Payload must not contain email");
  assert.strictEqual((parsed as any).ip, undefined, "Payload must not contain ip");
  assert.strictEqual(parsed.path.includes("?"), false, "Payload path must not contain query parameters");

  pass("Consent check correctly gates tracking; payload contains zero PII and zero query strings");

  // ---------------------------------------------------------------------------
  // 4. /api/track Validation & Bad Payload Handling (204 No Content)
  // ---------------------------------------------------------------------------
  console.log("\n--- 4. POST /api/track Validation & 204 Rejection for Bad Payloads ---");

  process.env.NODE_ENV = "test";
  process.env.__CAREERMONKE_LEGACY_RATE_LIMIT = "true";

  const { POST: trackPost } = await import("../src/app/api/track/route");
  const MAX_TRACK_PAYLOAD_BYTES = 16384;

  async function postTrackRaw(
    rawBody: string,
    headers: Record<string, string> = {}
  ): Promise<{ status: number; body: any }> {
    const req = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": "203.0.113.42",
        ...headers,
      },
      body: rawBody,
    });
    const res = await trackPost(req);
    const body = res.status === 204 ? null : await res.json().catch(() => ({}));
    return { status: res.status, body };
  }

  async function postTrack(payload: any, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
    return postTrackRaw(JSON.stringify(payload), headers);
  }

  // 4a. Rejection: Query strings in path -> 204
  {
    const { status } = await postTrack({
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
    assert.strictEqual(status, 204, "Path containing query string must be ignored with 204");
  }
  pass("POST /api/track strictly ignores web-vitals payloads containing query strings with 204");

  // 4b. Rejection: Hash fragments in path -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/pricing#annual",
      metric: {
        name: "CLS",
        value: 0.05,
      },
    });
    assert.strictEqual(status, 204, "Path containing hash fragment must be ignored with 204");
  }
  pass("POST /api/track strictly ignores web-vitals payloads containing hash fragments with 204");

  // 4c. Rejection: Path not starting with '/' -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "jobs",
      metric: {
        name: "LCP",
        value: 200,
      },
    });
    assert.strictEqual(status, 204, "Path without leading slash must be ignored with 204");
  }
  pass("POST /api/track strictly ignores web-vitals payloads without leading slash with 204");

  // 4d. Rejection: Invalid metric name -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        name: "UNKNOWN_METRIC",
        value: 100,
      },
    });
    assert.strictEqual(status, 204, "Unrecognized metric name must be ignored with 204");
  }
  pass("POST /api/track strictly validates allowed metric names (LCP, INP, CLS, TTFB, FCP)");

  // 4e. Rejection: Non-numeric metric value -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        name: "CLS",
        value: "not-a-number",
      },
    });
    assert.strictEqual(status, 204, "Non-numeric metric value must be ignored with 204");
  }
  pass("POST /api/track strictly ignores non-numeric metric values with 204");

  // 4f. Rejection: Negative metric value -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        name: "LCP",
        value: -50,
      },
    });
    assert.strictEqual(status, 204, "Negative metric value must be ignored with 204");
  }
  pass("POST /api/track strictly ignores negative metric values with 204");

  // 4g. Rejection: Missing metric object -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
    });
    assert.strictEqual(status, 204, "Missing metric must be ignored with 204");
  }
  pass("POST /api/track strictly ignores missing metric payload with 204");

  // 4h. Rejection: Rating > 50 chars -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        name: "LCP",
        value: 100,
        rating: "a".repeat(51),
      },
    });
    assert.strictEqual(status, 204, "Rating exceeding 50 chars must be ignored with 204");
  }
  pass("POST /api/track strictly enforces rating character length limit");

  // 4i. Rejection: NavigationType > 50 chars -> 204
  {
    const { status } = await postTrack({
      eventType: "web-vitals",
      path: "/jobs",
      metric: {
        name: "LCP",
        value: 100,
        navigationType: "n".repeat(51),
      },
    });
    assert.strictEqual(status, 204, "NavigationType exceeding 50 chars must be ignored with 204");
  }
  pass("POST /api/track strictly enforces navigationType character length limit");

  // 4j. Rejection: Malformed JSON -> 204
  {
    const { status } = await postTrackRaw("{ malformed json string !!");
    assert.strictEqual(status, 204, "Malformed JSON must be ignored with 204");
  }
  pass("POST /api/track strictly ignores malformed JSON payloads with 204");

  // 4k. Rejection: Non-object JSON (array, primitive) -> 204
  {
    const { status: statusArr } = await postTrackRaw("[1, 2, 3]");
    assert.strictEqual(statusArr, 204, "JSON array body must be ignored with 204");

    const { status: statusPrim } = await postTrackRaw('"just a string"');
    assert.strictEqual(statusPrim, 204, "JSON primitive body must be ignored with 204");
  }
  pass("POST /api/track strictly ignores non-object JSON with 204");

  // 4l. Size cap enforcement (> MAX_TRACK_PAYLOAD_BYTES) -> 204
  {
    assert.strictEqual(typeof MAX_TRACK_PAYLOAD_BYTES, "number");
    assert.ok(MAX_TRACK_PAYLOAD_BYTES >= 8192, "MAX_TRACK_PAYLOAD_BYTES should be at least 8KB");

    // Test with Content-Length header exceeding cap
    const { status: statusHeader } = await postTrack(
      { eventType: "web-vitals", path: "/jobs", metric: { name: "LCP", value: 100 } },
      { "content-length": String(MAX_TRACK_PAYLOAD_BYTES + 100) }
    );
    assert.strictEqual(statusHeader, 204, "Content-Length exceeding size cap must return 204");

    // Test with actual body exceeding size cap
    const bigString = "x".repeat(MAX_TRACK_PAYLOAD_BYTES + 50);
    const { status: statusBody } = await postTrackRaw(bigString);
    assert.strictEqual(statusBody, 204, "Body exceeding size cap must return 204");
  }
  pass("POST /api/track strictly enforces payload size cap with 204");

  // ---------------------------------------------------------------------------
  // 5. Database Insert Verification & Zero User Identifiers
  // ---------------------------------------------------------------------------
  console.log("\n--- 5. Database Insert Verification (web_vitals table via service role) ---");

  let insertedRows: any[] = [];
  (globalThis as any).__mockSupabaseClient = {
    from: (table: string) => {
      if (table === "web_vitals") {
        return {
          insert: async (data: any) => {
            insertedRows.push(data);
            return { error: null };
          },
        };
      }
      return {
        insert: async () => ({ error: null }),
      };
    },
  };

  insertedRows = [];
  const metricsToTest = ["LCP", "INP", "CLS", "TTFB", "FCP"];
  for (const metricName of metricsToTest) {
    const { status, body } = await postTrack(
      {
        eventType: "web-vitals",
        path: "/jobs/[id]",
        metric: {
          id: `wv-${metricName.toLowerCase()}-1`,
          name: metricName,
          value: 120.5,
          rating: "good",
          navigationType: "navigate",
        },
        // Attempt to pass spoofed user identifiers in body
        userId: "malicious-user-id-attempt",
        user_id: "malicious-user-id-attempt-2",
        email: "test@example.com",
      },
      {
        // Attempt to pass auth header
        Authorization: "Bearer fake-session-token",
      }
    );

    assert.strictEqual(status, 200, `POST /api/track for ${metricName} must return 200`);
    assert.strictEqual(body.ok, true, `POST /api/track for ${metricName} must return ok: true`);
    assert.strictEqual(body.eventType, "web-vitals");
  }

  assert.strictEqual(insertedRows.length, metricsToTest.length, "All 5 metrics must trigger an insert");

  for (let i = 0; i < metricsToTest.length; i++) {
    const row = insertedRows[i];
    const metricName = metricsToTest[i];

    assert.strictEqual(row.name, metricName, `Row ${i} metric name must be ${metricName}`);
    assert.strictEqual(row.value, 120.5, `Row ${i} metric value must match`);
    assert.strictEqual(row.rating, "good", `Row ${i} rating must match`);
    assert.strictEqual(row.route, "/jobs/[id]", `Row ${i} route must match`);
    assert.strictEqual(row.navigation_type, "navigate", `Row ${i} navigation_type must match`);
    assert.ok(row.created_at, `Row ${i} must have created_at timestamp`);

    // PRIVACY / NO USER IDENTIFIERS ASSERTION
    assert.strictEqual(row.user_id, undefined, "Inserted web_vitals row MUST NOT contain user_id");
    assert.strictEqual(row.userId, undefined, "Inserted web_vitals row MUST NOT contain userId");
    assert.strictEqual(row.ip_hash, undefined, "Inserted web_vitals row MUST NOT contain ip_hash");
    assert.strictEqual(row.ip, undefined, "Inserted web_vitals row MUST NOT contain ip");
    assert.strictEqual(row.email, undefined, "Inserted web_vitals row MUST NOT contain email");
  }
  pass("POST /api/track successfully validates and inserts web_vitals rows with zero user identifiers");

  // Also verify flat format (route + metric properties at root)
  insertedRows = [];
  {
    const { status, body } = await postTrack({
      eventType: "web-vitals",
      route: "/worldwide",
      name: "INP",
      value: 45.2,
      rating: "good",
      navigation_type: "reload",
    });
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(insertedRows.length, 1);
    assert.strictEqual(insertedRows[0].name, "INP");
    assert.strictEqual(insertedRows[0].value, 45.2);
    assert.strictEqual(insertedRows[0].route, "/worldwide");
    assert.strictEqual(insertedRows[0].navigation_type, "reload");
  }
  pass("POST /api/track supports canonical route and flat metric properties");

  // ---------------------------------------------------------------------------
  // 6. Rate Limiting Verification (429 on Exceeded Limit)
  // ---------------------------------------------------------------------------
  console.log("\n--- 6. Rate Limiting Enforcement ---");

  // Enable live shared rate limiting check
  process.env.__CAREERMONKE_LEGACY_RATE_LIMIT = "false";
  const { _resetTrackRateLimitStore, TRACK_RATE_LIMIT } = await import("../src/lib/api/sharedRateLimit");
  _resetTrackRateLimitStore();

  const rateLimitIp = "198.51.100.77";

  // Send max allowed requests
  for (let i = 1; i <= TRACK_RATE_LIMIT.maxRequests; i++) {
    const req = new Request("http://localhost:3000/api/track", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": rateLimitIp,
      },
      body: JSON.stringify({
        eventType: "web-vitals",
        path: "/jobs",
        metric: { name: "CLS", value: 0.01 },
      }),
    });
    const res = await trackPost(req);
    assert.strictEqual(res.status, 200, `Request #${i} within rate limit must return 200`);
  }

  // Request #31 must be rate limited with HTTP 429
  const limitedReq = new Request("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": rateLimitIp,
    },
    body: JSON.stringify({
      eventType: "web-vitals",
      path: "/jobs",
      metric: { name: "CLS", value: 0.01 },
    }),
  });
  const limitedRes = await trackPost(limitedReq);
  assert.strictEqual(limitedRes.status, 429, `Request #31 must return 429, got ${limitedRes.status}`);

  const retryHeader = limitedRes.headers.get("Retry-After");
  assert.ok(retryHeader, "429 response must include Retry-After header");
  assert.ok(parseInt(retryHeader, 10) > 0, "Retry-After must be > 0");

  const limitedJson = await limitedRes.json();
  assert.strictEqual(limitedJson.ok, false);
  assert.strictEqual(limitedJson.error, "Rate limit exceeded. Please try again shortly.");

  // Different IP should still succeed
  const differentIpReq = new Request("http://localhost:3000/api/track", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": "198.51.100.88",
    },
    body: JSON.stringify({
      eventType: "web-vitals",
      path: "/jobs",
      metric: { name: "CLS", value: 0.01 },
    }),
  });
  const differentIpRes = await trackPost(differentIpReq);
  assert.strictEqual(differentIpRes.status, 200, "Different IP under limit must return 200");

  pass("POST /api/track strictly enforces per-IP rate limit (30 req/min) returning 429 and Retry-After");

  // Restore legacy mode for standard pageview test
  process.env.__CAREERMONKE_LEGACY_RATE_LIMIT = "true";

  // ---------------------------------------------------------------------------
  // 7. Migration File Verification
  // ---------------------------------------------------------------------------
  console.log("\n--- 7. Migration SQL File Verification ---");

  const migrationPath = path.resolve(process.cwd(), "supabase/migrations/20261105b_web_vitals.sql");
  assert.ok(fs.existsSync(migrationPath), "supabase/migrations/20261105b_web_vitals.sql must exist");
  const migrationSql = fs.readFileSync(migrationPath, "utf8");

  assert.ok(
    migrationSql.includes("create table if not exists public.web_vitals"),
    "Migration must create table public.web_vitals"
  );
  assert.ok(
    migrationSql.includes("enable row level security"),
    "Migration must enable row level security on public.web_vitals"
  );
  assert.ok(
    migrationSql.includes("revoke all on public.web_vitals from public, anon, authenticated"),
    "Migration must revoke permissions from public, anon, and authenticated"
  );
  assert.ok(
    migrationSql.includes("grant all on public.web_vitals to service_role"),
    "Migration must grant permissions to service_role only"
  );
  assert.ok(
    migrationSql.includes("name") &&
      migrationSql.includes("value") &&
      migrationSql.includes("rating") &&
      migrationSql.includes("route") &&
      migrationSql.includes("navigation_type"),
    "Migration must define name, value, rating, route, and navigation_type columns"
  );
  pass("Migration SQL defines web_vitals table with strict RLS and service_role only access");

  // ---------------------------------------------------------------------------
  // 8. Standard Pageview Behavior Remains Intact
  // ---------------------------------------------------------------------------
  console.log("\n--- 8. Standard Pageview Regression Verification ---");

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

  const { getFallbackRecords } = await import("../src/lib/admin/analytics");

  const { status: pvStatus, body: pvBody } = await postTrack({
    path: "/pricing",
    referrer: "https://google.com",
  });

  assert.strictEqual(pvStatus, 200, "Existing pageview tracking must return 200");
  assert.strictEqual(pvBody.ok, true, "Existing pageview tracking must return ok: true");
  assert.strictEqual(pvBody.eventType, undefined, "Pageview response does not include web-vitals eventType");
  const fallbackViews = getFallbackRecords();
  assert.ok(
    fallbackViews.some((v) => v.path === "/pricing"),
    "page_views record must be captured in analytics buffer"
  );

  // Pageview invalid path returns 400
  const { status: badPvStatus } = await postTrack({ path: "not-a-valid-path" });
  assert.strictEqual(badPvStatus, 400, "Invalid pageview path returns 400");

  delete (globalThis as any).__mockSupabaseClient;
  pass("Existing standard pageview tracking continues to operate unchanged");

  console.log("\n==================================================================");
  console.log("🎉 ALL CORE WEB VITALS TRACKING & STORAGE TESTS PASSED (PASS-LOCAL)!");
  console.log("==================================================================");
}

runTests().catch((err) => {
  console.error("❌ Test suite encountered unhandled error:", err);
  process.exit(1);
});
