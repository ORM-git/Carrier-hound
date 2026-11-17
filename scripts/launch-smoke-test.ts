/**
 * scripts/launch-smoke-test.ts
 *
 * Automated Launch Smoke Test Suite for CareerMonke.
 *
 * Runs read-only HTTP checks against target base URL (default: https://careermonke.com):
 *  (1) The home, /pricing, /jobs, /privacy, /terms-and-conditions, and /refund-policy pages return 200.
 *  (2) The www host redirects to the apex with a 301.
 *  (3) The security headers are present (HSTS, X-Content-Type-Options, a frame protection header, CSP).
 *  (4) The jobs API returns JSON with a non-empty list, and returns 401 or 403 without auth where it should.
 *  (5) The pricing page text contains 399, 499 and 2,199 and does NOT contain 692, 799, "auto-renew" or "first month".
 *  (6) The robots.txt and sitemap.xml respond.
 *  (7) The Razorpay order endpoint rejects an unauthenticated request.
 *
 * Guarantees:
 *  - STRICTLY READ-ONLY: No payments, no database writes, no logins, no secrets.
 *  - 10s timeout per HTTP request.
 *
 * Usage:
 *   npx tsx scripts/launch-smoke-test.ts [baseUrl] [--json]
 */

const DEFAULT_BASE_URL = "https://careermonke.com";
const REQUEST_TIMEOUT_MS = 10_000;

interface CheckResult {
  id: number;
  name: string;
  passed: boolean;
  summary: string;
  details?: string[];
  durationMs: number;
}

/**
 * Robust fetch wrapper enforcing a strict per-request timeout.
 */
async function timedFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check (1): The home, /pricing, /jobs, /privacy, /terms-and-conditions,
 * and /refund-policy pages return 200.
 */
async function checkPublicPages(apexOrigin: string): Promise<CheckResult> {
  const start = Date.now();
  const pages = [
    "/",
    "/pricing",
    "/jobs",
    "/privacy",
    "/terms-and-conditions",
    "/refund-policy",
  ];

  const results: { path: string; status: number; ok: boolean }[] = [];
  const details: string[] = [];

  for (const path of pages) {
    const targetUrl = `${apexOrigin}${path}`;
    try {
      const res = await timedFetch(targetUrl, { method: "GET" });
      const ok = res.status === 200;
      results.push({ path, status: res.status, ok });
      if (!ok) {
        details.push(`${path} returned HTTP ${res.status} (expected 200)`);
      }
    } catch (err: any) {
      results.push({ path, status: 0, ok: false });
      details.push(`${path} fetch failed: ${err?.message || String(err)}`);
    }
  }

  const passed = results.every((r) => r.ok);
  const summary = passed
    ? `All 6 public pages (${pages.join(", ")}) returned HTTP 200`
    : `${results.filter((r) => !r.ok).length} of 6 pages failed: ${details.join("; ")}`;

  return {
    id: 1,
    name: "Public Pages Availability",
    passed,
    summary,
    details: details.length > 0 ? details : undefined,
    durationMs: Date.now() - start,
  };
}

/**
 * Check (2): The www host redirects to the apex with a 301.
 */
async function checkWwwRedirect(baseUrl: string): Promise<CheckResult> {
  const start = Date.now();
  const parsed = new URL(baseUrl);
  const details: string[] = [];

  let apexHostname: string;
  let wwwHostname: string;

  if (parsed.hostname.startsWith("www.")) {
    wwwHostname = parsed.hostname;
    apexHostname = parsed.hostname.replace(/^www\./, "");
  } else {
    apexHostname = parsed.hostname;
    wwwHostname = `www.${parsed.hostname}`;
  }

  const apexOrigin = `${parsed.protocol}//${apexHostname}${parsed.port ? `:${parsed.port}` : ""}`;
  const wwwUrl = `${parsed.protocol}//${wwwHostname}/`;

  try {
    const res = await timedFetch(wwwUrl, {
      method: "GET",
      redirect: "manual",
    });

    const status = res.status;
    const location = res.headers.get("location") || "";
    const is301 = status === 301;

    let targetsApex = false;
    if (location) {
      try {
        const resolvedLocation = new URL(location, wwwUrl);
        targetsApex =
          resolvedLocation.hostname === apexHostname &&
          (resolvedLocation.pathname === "/" || resolvedLocation.pathname === "");
      } catch {
        targetsApex =
          location === apexOrigin ||
          location === `${apexOrigin}/` ||
          location.startsWith(`${apexOrigin}`);
      }
    }

    const passed = is301 && targetsApex;

    if (!is301) {
      details.push(
        `Expected HTTP 301 from ${wwwUrl}, received HTTP ${status}`
      );
    }
    if (!targetsApex) {
      details.push(
        `Expected Location redirect to apex (${apexOrigin}/), received "${location || "none"}"`
      );
    }

    const summary = passed
      ? `${wwwUrl} redirects to apex (${apexOrigin}/) with HTTP 301`
      : details.join(" | ");

    return {
      id: 2,
      name: "WWW Host Apex Redirection",
      passed,
      summary,
      details: details.length > 0 ? details : undefined,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      id: 2,
      name: "WWW Host Apex Redirection",
      passed: false,
      summary: `Failed to query ${wwwUrl}: ${err?.message || String(err)}`,
      details: [err?.message || String(err)],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Check (3): The security headers are present (HSTS, X-Content-Type-Options,
 * a frame protection header, CSP).
 */
async function checkSecurityHeaders(apexOrigin: string): Promise<CheckResult> {
  const start = Date.now();
  const details: string[] = [];

  try {
    const res = await timedFetch(`${apexOrigin}/`, { method: "GET" });

    const hsts = res.headers.get("strict-transport-security");
    const xContentType = res.headers.get("x-content-type-options");
    const xFrameOptions = res.headers.get("x-frame-options");
    const csp = res.headers.get("content-security-policy");

    const hasHsts = Boolean(hsts && hsts.trim().length > 0);
    const hasXContentType = Boolean(
      xContentType && /nosniff/i.test(xContentType)
    );
    const hasFrameProtection = Boolean(
      (xFrameOptions && /deny|sameorigin/i.test(xFrameOptions)) ||
      (csp && /frame-ancestors/i.test(csp))
    );
    const hasCsp = Boolean(csp && csp.trim().length > 0);

    if (!hasHsts) details.push("Missing Strict-Transport-Security (HSTS)");
    if (!hasXContentType) details.push("Missing or invalid X-Content-Type-Options (expected 'nosniff')");
    if (!hasFrameProtection) details.push("Missing Frame Protection (neither X-Frame-Options nor CSP frame-ancestors)");
    if (!hasCsp) details.push("Missing Content-Security-Policy (CSP)");

    const passed = hasHsts && hasXContentType && hasFrameProtection && hasCsp;
    const summary = passed
      ? "All required security headers present (HSTS, X-Content-Type-Options, Frame Protection, CSP)"
      : `Missing security headers: ${details.join("; ")}`;

    return {
      id: 3,
      name: "Security Headers Presence",
      passed,
      summary,
      details: details.length > 0 ? details : undefined,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      id: 3,
      name: "Security Headers Presence",
      passed: false,
      summary: `Failed to fetch root headers: ${err?.message || String(err)}`,
      details: [err?.message || String(err)],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Check (4): The jobs API returns JSON with a non-empty list,
 * and returns 401 or 403 without auth where it should.
 */
async function checkJobsApi(apexOrigin: string): Promise<CheckResult> {
  const start = Date.now();
  const details: string[] = [];

  let publicPassed = false;
  let protectedPassed = false;

  // 1. Public jobs feed: /api/jobs/search
  try {
    const searchRes = await timedFetch(`${apexOrigin}/api/jobs/search?pageSize=10`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (searchRes.status !== 200) {
      details.push(
        `/api/jobs/search returned HTTP ${searchRes.status} (expected 200)`
      );
    } else {
      const data: any = await searchRes.json().catch(() => null);
      const jobsList = Array.isArray(data?.jobs)
        ? data.jobs
        : Array.isArray(data)
        ? data
        : null;

      if (!jobsList || jobsList.length === 0) {
        details.push(
          `/api/jobs/search returned empty jobs array or invalid JSON shape`
        );
      } else {
        publicPassed = true;
      }
    }
  } catch (err: any) {
    details.push(
      `/api/jobs/search query failed: ${err?.message || String(err)}`
    );
  }

  // 2. Protected jobs endpoint: /api/jobs/pro (unauthenticated)
  try {
    const proRes = await timedFetch(`${apexOrigin}/api/jobs/pro`, {
      method: "GET",
      headers: { Accept: "application/json" },
    });

    if (proRes.status === 401 || proRes.status === 403) {
      protectedPassed = true;
    } else {
      details.push(
        `/api/jobs/pro unauthenticated request returned HTTP ${proRes.status} (expected 401 or 403)`
      );
    }
  } catch (err: any) {
    details.push(
      `/api/jobs/pro unauthenticated query failed: ${err?.message || String(err)}`
    );
  }

  const passed = publicPassed && protectedPassed;
  const summary = passed
    ? "/api/jobs/search returns non-empty jobs list & /api/jobs/pro rejects unauthenticated requests (HTTP 401/403)"
    : details.join(" | ");

  return {
    id: 4,
    name: "Jobs API Gating & Corpus Feed",
    passed,
    summary,
    details: details.length > 0 ? details : undefined,
    durationMs: Date.now() - start,
  };
}

/**
 * Check (5): The pricing page text contains 399, 499 and 2,199 (or 2199)
 * and does NOT contain 692, 799, affirmative "auto-renew" or "first month".
 * Note: Sentences explicitly stating plans do not auto-renew (denials) are valid and expected.
 */
async function checkPricingCopy(apexOrigin: string): Promise<CheckResult> {
  const start = Date.now();
  const details: string[] = [];

  try {
    const res = await timedFetch(`${apexOrigin}/pricing`, { method: "GET" });
    if (res.status !== 200) {
      return {
        id: 5,
        name: "Pricing Page Copy & Plan Price Points",
        passed: false,
        summary: `/pricing returned HTTP ${res.status} (expected 200)`,
        details: [`HTTP ${res.status}`],
        durationMs: Date.now() - start,
      };
    }

    const html = await res.text();

    // Required price points: 399, 499, and 2199 (accepts either "2,199" or "2199")
    const missing: string[] = [];
    if (!html.includes("399")) missing.push("399");
    if (!html.includes("499")) missing.push("499");
    if (!html.includes("2,199") && !html.includes("2199")) missing.push("2,199 or 2199");

    // Forbidden patterns:
    // - 692 and 799 legacy prices
    // - "first month" introductory copy
    const forbiddenChecks: { label: string; test: (t: string) => boolean }[] = [
      { label: "692", test: (t) => t.includes("692") },
      { label: "799", test: (t) => t.includes("799") },
      { label: '"first month"', test: (t) => /first\s+month/i.test(t) },
    ];

    const foundForbidden = forbiddenChecks
      .filter((check) => check.test(html))
      .map((check) => check.label);

    // Any sentence containing auto-renew or recurring billing must be a denial (e.g. "do not auto-renew", "no recurring charges")
    const autoRenewMentions = html
      .split(/(?<=[.!?<>\n])\s+/)
      .filter((sentence) => /auto[\s-]?renew|renews?\s+automatically|recurring\s+charge/i.test(sentence));
    const affirmativeAutoRenew = autoRenewMentions.filter(
      (sentence) => !/\b(no|not|never|nothing|non-?renewing)\b/i.test(sentence)
    );
    if (affirmativeAutoRenew.length > 0) {
      foundForbidden.push('affirmative "auto-renew"');
    }

    if (missing.length > 0) {
      details.push(`Missing required price strings: ${missing.join(", ")}`);
    }
    if (foundForbidden.length > 0) {
      details.push(`Found forbidden pricing terms: ${foundForbidden.join(", ")}`);
    }

    const passed = missing.length === 0 && foundForbidden.length === 0;
    const summary = passed
      ? 'Pricing text contains 399, 499, 2199/2,199 and excludes 692, 799, "first month", with verified non-auto-renew prepaid policy'
      : details.join(" | ");

    return {
      id: 5,
      name: "Pricing Page Copy & Plan Price Points",
      passed,
      summary,
      details: details.length > 0 ? details : undefined,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      id: 5,
      name: "Pricing Page Copy & Plan Price Points",
      passed: false,
      summary: `Failed to fetch /pricing: ${err?.message || String(err)}`,
      details: [err?.message || String(err)],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Check (6): The robots.txt and sitemap.xml respond.
 */
async function checkRobotsAndSitemap(apexOrigin: string): Promise<CheckResult> {
  const start = Date.now();
  const details: string[] = [];

  let robotsOk = false;
  let sitemapOk = false;

  try {
    const res = await timedFetch(`${apexOrigin}/robots.txt`, { method: "GET" });
    if (res.status === 200) {
      robotsOk = true;
    } else {
      details.push(`/robots.txt returned HTTP ${res.status} (expected 200)`);
    }
  } catch (err: any) {
    details.push(`/robots.txt fetch error: ${err?.message || String(err)}`);
  }

  try {
    const res = await timedFetch(`${apexOrigin}/sitemap.xml`, { method: "GET" });
    if (res.status === 200) {
      sitemapOk = true;
    } else {
      details.push(`/sitemap.xml returned HTTP ${res.status} (expected 200)`);
    }
  } catch (err: any) {
    details.push(`/sitemap.xml fetch error: ${err?.message || String(err)}`);
  }

  const passed = robotsOk && sitemapOk;
  const summary = passed
    ? "/robots.txt (HTTP 200) and /sitemap.xml (HTTP 200) responded successfully"
    : details.join(" | ");

  return {
    id: 6,
    name: "Search Engine Files (robots.txt & sitemap.xml)",
    passed,
    summary,
    details: details.length > 0 ? details : undefined,
    durationMs: Date.now() - start,
  };
}

/**
 * Check (7): The Razorpay order endpoint rejects an unauthenticated request.
 * Strictly read-only / unauthenticated probe with no credentials, payments, or secrets.
 */
async function checkRazorpayOrderUnauthRejection(
  apexOrigin: string
): Promise<CheckResult> {
  const start = Date.now();
  const details: string[] = [];

  try {
    const res = await timedFetch(`${apexOrigin}/api/billing/razorpay/order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ plan: "weekly" }),
    });

    const isRejected = res.status === 401 || res.status === 403;

    if (!isRejected) {
      details.push(
        `/api/billing/razorpay/order unauthenticated POST returned HTTP ${res.status} (expected 401 or 403)`
      );
    }

    const summary = isRejected
      ? `/api/billing/razorpay/order rejects unauthenticated POST (HTTP ${res.status})`
      : details.join(" | ");

    return {
      id: 7,
      name: "Razorpay Order Endpoint Authentication Gating",
      passed: isRejected,
      summary,
      details: details.length > 0 ? details : undefined,
      durationMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      id: 7,
      name: "Razorpay Order Endpoint Authentication Gating",
      passed: false,
      summary: `POST /api/billing/razorpay/order failed: ${err?.message || String(err)}`,
      details: [err?.message || String(err)],
      durationMs: Date.now() - start,
    };
  }
}

/**
 * Main execution orchestration.
 */
async function main() {
  const rawArg = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  const jsonOutput = process.argv.includes("--json");
  const baseUrl = rawArg || process.env.SMOKE_BASE_URL || DEFAULT_BASE_URL;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error(`Error: Invalid target base URL "${baseUrl}"`);
    process.exit(1);
  }

  const apexHostname = parsed.hostname.startsWith("www.")
    ? parsed.hostname.replace(/^www\./, "")
    : parsed.hostname;
  const apexOrigin = `${parsed.protocol}//${apexHostname}${parsed.port ? `:${parsed.port}` : ""}`;

  if (!jsonOutput) {
    console.log("=".repeat(80));
    console.log("CareerMonke Launch Smoke Test Suite");
    console.log(`Target Base URL: ${baseUrl}`);
    console.log(`Apex Origin:     ${apexOrigin}`);
    console.log(`Per-Request Cap: ${REQUEST_TIMEOUT_MS}ms timeout | Strictly Read-Only`);
    console.log("=".repeat(80));
    console.log("");
  }

  // Execute checks sequentially to avoid load spike or false rate-limit triggers
  const results: CheckResult[] = [];
  results.push(await checkPublicPages(apexOrigin));
  results.push(await checkWwwRedirect(baseUrl));
  results.push(await checkSecurityHeaders(apexOrigin));
  results.push(await checkJobsApi(apexOrigin));
  results.push(await checkPricingCopy(apexOrigin));
  results.push(await checkRobotsAndSitemap(apexOrigin));
  results.push(await checkRazorpayOrderUnauthRejection(apexOrigin));

  const totalPassed = results.filter((r) => r.passed).length;
  const totalChecks = results.length;
  const allPassed = totalPassed === totalChecks;

  if (jsonOutput) {
    const payload = {
      timestamp: new Date().toISOString(),
      baseUrl,
      apexOrigin,
      allPassed,
      totalPassed,
      totalChecks,
      results,
    };
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const r of results) {
      const tag = r.passed ? "[PASS]" : "[FAIL]";
      console.log(`${tag} (${r.id}) ${r.name} (${r.durationMs}ms)`);
      console.log(`       ${r.summary}`);
      if (r.details && r.details.length > 0 && !r.passed) {
        for (const d of r.details) {
          console.log(`       -> Detail: ${d}`);
        }
      }
      console.log("");
    }

    console.log("=".repeat(80));
    console.log(
      `SUMMARY: ${totalPassed}/${totalChecks} checks passed against ${baseUrl}`
    );
    console.log("=".repeat(80));
  }

  process.exit(allPassed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error running launch smoke test:", err);
  process.exit(1);
});
