/**
 * CareerMonke Environment Guard & Payments-Disabled Verification Suite
 * 
 * Verifies that:
 * 1. Missing required environment variables return standardized JSON naming the missing variable.
 * 2. Missing-variable errors return HTTP 500 across Next.js Edge routes and Netlify handlers.
 * 3. Payment simulation is strictly blocked (HTTP 404) in production or when SIMULATE_PAYMENTS is off.
 * 4. Razorpay billing fails safe with a clean "Payments not enabled" error when keys are absent.
 * 5. Negative control (--negative-control) fails closed with non-zero exit code.
 * 
 * Run with: npx tsx scripts/test-env-guards.ts
 * Run negative control: npx tsx scripts/test-env-guards.ts --negative-control
 */

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
}

const results: TestResult[] = [];

function assert(condition: boolean, testName: string, failureMsg: string) {
  if (!condition) {
    results.push({ name: testName, passed: false, error: failureMsg });
    console.error(`  ❌ FAIL: ${testName} - ${failureMsg}`);
  } else {
    results.push({ name: testName, passed: true });
    console.log(`  ✅ PASS: ${testName}`);
  }
}

import Module from "module";

// Register Node test hook for @cloudflare/next-on-pages in unit test environment
const originalResolve = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
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

// Preserve original environment
const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

async function runSuite() {
  console.log("================================================================================");
  console.log("     CAREERMONKE ENVIRONMENT VARIABLE GUARDS & PAYMENTS-OFF VERIFICATION       ");
  console.log("================================================================================\n");

  if (IS_NEGATIVE_CONTROL) {
    console.log("🧪 RUNNING IN NEGATIVE CONTROL MODE: Forcing deliberate assertion failure...\n");
    assert(false, "Negative Control Assertion", "Deliberate negative control failure to verify test harness.");
    console.error("\n❌ Negative control mode completed: Exiting with code 1 as expected.\n");
    process.exit(1);
  }

  // ============================================================================
  // SECTION 1: Missing Required Env Vars on Next.js Edge Routes
  // ============================================================================
  console.log("--- SECTION 1: Next.js Edge Routes Missing Variable Failures ---");

  // 1.1 /api/stats GET (Missing SUPABASE_SERVICE_ROLE_KEY)
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { GET } = await import("../src/app/api/stats/route");
    const res = await GET();
    const data = await res.json();

    assert(
      res.status === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Next.js GET /api/stats fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected status 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 1.2 /api/stats GET (Missing NEXT_PUBLIC_SUPABASE_URL)
  {
    restoreEnv();
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_URL;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-key";

    const { GET } = await import("../src/app/api/stats/route");
    const res = await GET();
    const data = await res.json();

    assert(
      res.status === 500 && data.missingVariable === "NEXT_PUBLIC_SUPABASE_URL",
      "Next.js GET /api/stats fails with 500 and names NEXT_PUBLIC_SUPABASE_URL",
      `Expected status 500 and missingVariable NEXT_PUBLIC_SUPABASE_URL, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 1.3 /api/jobs/search GET (Missing SUPABASE_SERVICE_ROLE_KEY)
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { GET } = await import("../src/app/api/jobs/search/route");
    const req = new Request("http://localhost:3000/api/jobs/search?q=engineer");
    const res = await GET(req);
    const data = await res.json();

    assert(
      res.status === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Next.js GET /api/jobs/search fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected status 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 1.4 /api/jobs/pro GET (Missing SUPABASE_SERVICE_ROLE_KEY)
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { GET } = await import("../src/app/api/jobs/pro/route");
    const req = new Request("http://localhost:3000/api/jobs/pro?id=123", {
      headers: { Authorization: "Bearer mock-token" },
    });
    const res = await GET(req);
    const data = await res.json();

    assert(
      res.status === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Next.js GET /api/jobs/pro fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected status 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 1.5 /api/jobs/top10 POST (Missing SUPABASE_SERVICE_ROLE_KEY)
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { POST } = await import("../src/app/api/jobs/top10/route");
    const req = new Request("http://localhost:3000/api/jobs/top10", {
      method: "POST",
      headers: {
        Authorization: "Bearer mock-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ candidate: { skills: ["TypeScript"] } }),
    });
    const res = await POST(req);
    const data = await res.json();

    assert(
      res.status === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Next.js POST /api/jobs/top10 fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected status 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 1.6 /api/ai POST (Missing GROQ_API_KEY)
  {
    restoreEnv();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";
    delete process.env.GROQ_API_KEY;

    // Mock global fetch for auth verification & quota check
    const origFetch = global.fetch;
    global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "mock-pro-user-id", user_metadata: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/rest/v1/subscriptions")) {
        return new Response(
          JSON.stringify([{ status: "active", plan_id: "domestic_monthly_199" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/rest/v1/blocked_users")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/rest/v1/ai_usage_quotas")) {
        return new Response(
          JSON.stringify([{ count: 0, estimated_tokens: 0 }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const { POST } = await import("../src/app/api/ai/route");
      const req = new Request("http://localhost:3000/api/ai", {
        method: "POST",
        headers: {
          Authorization: "Bearer mock-token-pro",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation: "resume_extraction",
          params: { rawText: "Software Engineer with React experience." },
        }),
      });
      const res = await POST(req);
      const data = await res.json();

      assert(
        res.status === 500 && data.missingVariable === "GROQ_API_KEY",
        "Next.js POST /api/ai fails with 500 and names GROQ_API_KEY",
        `Expected status 500 and missingVariable GROQ_API_KEY, got status ${res.status}: ${JSON.stringify(data)}`
      );
    } finally {
      global.fetch = origFetch;
    }
  }

  // 1.7 /api/ai POST (Missing SUPABASE_SERVICE_ROLE_KEY even when NEXT_PUBLIC_SUPABASE_ANON_KEY is present)
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dummy-anon-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.GROQ_API_KEY = "mock-groq-key";

    const { POST } = await import("../src/app/api/ai/route");
    const req = new Request("http://localhost:3000/api/ai", {
      method: "POST",
      headers: {
        Authorization: "Bearer mock-token-pro",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        operation: "resume_extraction",
        params: { rawText: "Software Engineer with React experience." },
      }),
    });
    const res = await POST(req);
    const data = await res.json();

    assert(
      res.status === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Next.js POST /api/ai fails closed with 500 and names SUPABASE_SERVICE_ROLE_KEY when service-role key is missing (anon key ignored)",
      `Expected status 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // ============================================================================
  // SECTION 2: Missing Required Env Vars on Netlify Serverless Functions
  // ============================================================================
  console.log("\n--- SECTION 2: Netlify Function Handlers Missing Variable Failures ---");

  // 2.1 Netlify stats handler
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { handler: statsHandler } = await import("../netlify/functions/stats");
    const res = await statsHandler();
    const data = JSON.parse(res.body);

    assert(
      res.statusCode === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Netlify stats handler fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected statusCode 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got ${res.statusCode}: ${res.body}`
    );
  }

  // 2.2 Netlify jobs-search handler
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { handler: searchHandler } = await import("../netlify/functions/jobs-search");
    const res = await searchHandler({
      httpMethod: "GET",
      queryStringParameters: { q: "frontend" },
      headers: {},
    });
    const data = JSON.parse(res.body);

    assert(
      res.statusCode === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Netlify jobs-search handler fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected statusCode 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got ${res.statusCode}: ${res.body}`
    );
  }

  // 2.3 Netlify jobs-pro handler
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";

    const { handler: proHandler } = await import("../netlify/functions/jobs-pro");
    const res = await proHandler({
      httpMethod: "GET",
      queryStringParameters: { id: "test-id" },
      headers: { authorization: "Bearer mock-token" },
    });
    const data = JSON.parse(res.body);

    assert(
      res.statusCode === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Netlify jobs-pro handler fails with 500 and names SUPABASE_SERVICE_ROLE_KEY",
      `Expected statusCode 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got ${res.statusCode}: ${res.body}`
    );
  }

  // 2.4 Netlify ai handler (Missing GROQ_API_KEY)
  {
    restoreEnv();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-key";
    delete process.env.GROQ_API_KEY;

    const origFetch = global.fetch;
    global.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "mock-pro-user-id", user_metadata: {} }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/rest/v1/subscriptions")) {
        return new Response(
          JSON.stringify([{ status: "active", plan_id: "domestic_monthly_199" }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes("/rest/v1/blocked_users")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/rest/v1/ai_usage_quotas")) {
        return new Response(
          JSON.stringify([{ count: 0, estimated_tokens: 0 }]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    };

    try {
      const { handler: aiHandler } = await import("../netlify/functions/ai");
      const res = await aiHandler({
        httpMethod: "POST",
        headers: { authorization: "Bearer mock-token-pro" },
        body: JSON.stringify({
          operation: "resume_extraction",
          params: { rawText: "Software Engineer resume text" },
        }),
      });
      const data = JSON.parse(res.body);

      assert(
        res.statusCode === 500 && data.missingVariable === "GROQ_API_KEY",
        "Netlify ai handler fails with 500 and names GROQ_API_KEY",
        `Expected statusCode 500 and missingVariable GROQ_API_KEY, got ${res.statusCode}: ${res.body}`
      );
    } finally {
      global.fetch = origFetch;
    }
  }

  // 2.5 Netlify ai handler (Missing SUPABASE_SERVICE_ROLE_KEY even when NEXT_PUBLIC_SUPABASE_ANON_KEY is present)
  {
    restoreEnv();
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "dummy-anon-key";
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
    process.env.GROQ_API_KEY = "mock-groq-key";

    const { handler: aiHandler } = await import("../netlify/functions/ai");
    const res = await aiHandler({
      httpMethod: "POST",
      headers: { authorization: "Bearer mock-token-pro" },
      body: JSON.stringify({
        operation: "resume_extraction",
        params: { rawText: "Software Engineer resume text" },
      }),
    });
    const data = JSON.parse(res.body);

    assert(
      res.statusCode === 500 && data.missingVariable === "SUPABASE_SERVICE_ROLE_KEY",
      "Netlify ai handler fails closed with 500 and names SUPABASE_SERVICE_ROLE_KEY when service-role key is missing (anon key ignored)",
      `Expected statusCode 500 and missingVariable SUPABASE_SERVICE_ROLE_KEY, got ${res.statusCode}: ${res.body}`
    );
  }

  // ============================================================================
  // SECTION 3: Payments-Disabled Behavior Verification
  // ============================================================================
  console.log("\n--- SECTION 3: Payments-Disabled Verification ---");

  // 3.1 Next.js /api/simulate-checkout in production (NODE_ENV=production)
  {
    restoreEnv();
    process.env.NODE_ENV = "production";
    process.env.SIMULATE_PAYMENTS = "true";

    const { POST } = await import("../src/app/api/simulate-checkout/route");
    const req = new Request("http://localhost:3000/api/simulate-checkout", { method: "POST" });
    const res = await POST(req);
    const data = await res.json();

    assert(
      res.status === 404 && data.code === "PAYMENTS_DISABLED",
      "Next.js /api/simulate-checkout returns 404 PAYMENTS_DISABLED in production",
      `Expected status 404 and code PAYMENTS_DISABLED, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 3.2 Next.js /api/simulate-checkout when SIMULATE_PAYMENTS is false
  {
    restoreEnv();
    process.env.NODE_ENV = "development";
    process.env.SIMULATE_PAYMENTS = "false";

    const { POST } = await import("../src/app/api/simulate-checkout/route");
    const req = new Request("http://localhost:3000/api/simulate-checkout", { method: "POST" });
    const res = await POST(req);
    const data = await res.json();

    assert(
      res.status === 404 && data.code === "PAYMENTS_DISABLED",
      "Next.js /api/simulate-checkout returns 404 PAYMENTS_DISABLED when SIMULATE_PAYMENTS=false",
      `Expected status 404 and code PAYMENTS_DISABLED, got status ${res.status}: ${JSON.stringify(data)}`
    );
  }

  // 3.3 Netlify simulate-checkout in production (CONTEXT=production)
  {
    restoreEnv();
    process.env.CONTEXT = "production";
    process.env.SIMULATE_PAYMENTS = "true";

    const { handler: simHandler } = await import("../netlify/functions/simulate-checkout");
    const res = await simHandler({ httpMethod: "POST", headers: {} });
    const data = JSON.parse(res.body);

    assert(
      res.statusCode === 404 && data.code === "PAYMENTS_DISABLED",
      "Netlify simulate-checkout returns 404 PAYMENTS_DISABLED in production context",
      `Expected statusCode 404 and code PAYMENTS_DISABLED, got ${res.statusCode}: ${res.body}`
    );
  }

  // 3.4 Netlify simulate-checkout when SIMULATE_PAYMENTS is false
  {
    restoreEnv();
    delete process.env.SIMULATE_PAYMENTS;

    const { handler: simHandler } = await import("../netlify/functions/simulate-checkout");
    const res = await simHandler({ httpMethod: "POST", headers: {} });
    const data = JSON.parse(res.body);

    assert(
      res.statusCode === 404 && data.code === "PAYMENTS_DISABLED",
      "Netlify simulate-checkout returns 404 PAYMENTS_DISABLED when SIMULATE_PAYMENTS undefined",
      `Expected statusCode 404 and code PAYMENTS_DISABLED, got ${res.statusCode}: ${res.body}`
    );
  }

  // 3.5 openRazorpayCheckout fails safe when Razorpay keys are not configured
  {
    restoreEnv();
    delete process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID;
    delete process.env.RAZORPAY_KEY_ID;

    const { openRazorpayCheckout } = await import("../src/lib/billing/razorpay");

    let receivedError: Error | null = null;
    await openRazorpayCheckout({
      onSuccess: () => {},
      onError: (err: any) => {
        receivedError = err;
      },
    });

    assert(
      Boolean(receivedError && receivedError.message.includes("Payments not enabled")),
      "openRazorpayCheckout reports 'Payments not enabled' when keys are missing",
      `Expected error containing 'Payments not enabled', got: ${receivedError?.message}`
    );
  }

  // Restore environment after all tests
  restoreEnv();

  // Summary
  console.log("\n================================================================================");
  const passedCount = results.filter((r) => r.passed).length;
  const failedCount = results.filter((r) => !r.passed).length;
  console.log(`RESULTS: ${passedCount} passed, ${failedCount} failed out of ${results.length} assertions.`);
  console.log("================================================================================\n");

  if (failedCount > 0) {
    process.exit(1);
  }
}

runSuite().catch((err) => {
  console.error("Unexpected error in test-env-guards:", err);
  process.exit(1);
});
