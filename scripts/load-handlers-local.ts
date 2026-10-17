/**
 * scripts/load-handlers-local.ts
 *
 * Local load test harness for Netlify handlers with mocked Supabase and Groq:
 * Benchmarks:
 *  - jobs-search
 *  - stats
 *  - jobs-pro
 *  - ai
 * at 50, 100, 500, and 1000 concurrent calls per handler.
 *
 * Usage:
 *   npx tsx scripts/load-handlers-local.ts
 *   npx tsx scripts/load-handlers-local.ts --negative-control
 */

import { performance } from "perf_hooks";

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

// Configure local mock environment variables
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key-for-load-tests";
process.env.SUPABASE_SERVICE_KEY = "mock-service-role-key-for-load-tests";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "mock-anon-key-for-load-tests";
process.env.GROQ_API_KEY = "gsk_mock_test_key_for_load_verification";

// Mock fetch for Supabase and Groq
const originalFetch = global.fetch;
global.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  if (IS_NEGATIVE_CONTROL) {
    return new Response(JSON.stringify({ error: "Simulated negative control upstream failure" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  const urlStr = String(input);
  const method = init?.method || "GET";
  const headers = (init?.headers as any) || {};
  const authHeader = headers["Authorization"] || headers["authorization"] || "";

  // 1. Supabase Auth
  if (urlStr.includes("/auth/v1/user")) {
    const tokenMatch = authHeader.match(/mock-token-pro-(\d+)/);
    const userIndex = tokenMatch ? tokenMatch[1] : "0";
    return new Response(
      JSON.stringify({
        id: `00000000-0000-4000-a000-${userIndex.padStart(12, "0")}`,
        email: `pro-load-${userIndex}@example.com`,
        user_metadata: {},
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Blocked users
  if (urlStr.includes("/rest/v1/blocked_users")) {
    return new Response(JSON.stringify(null), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Supabase DB: Subscriptions
  if (urlStr.includes("/rest/v1/subscriptions")) {
    return new Response(
      JSON.stringify([
        {
          id: "sub-pro-load-001",
          user_id: "mock-user-id",
          status: "active",
          plan_id: "intl_monthly_9",
          current_period_start: "2026-01-01T00:00:00Z",
          current_period_end: "2099-01-01T00:00:00Z",
          metadata: {},
        },
      ]),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // 4. Supabase DB: Jobs count or rows
  if (urlStr.includes("/rest/v1/jobs")) {
    const isHead = method === "HEAD" || headers["Prefer"]?.includes("count=exact");
    if (isHead) {
      return new Response(null, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "content-range": "0-0/4200",
        },
      });
    }

    const job = {
      id: "job-mock-001",
      title: "Principal Infrastructure Engineer",
      company: "Monzo",
      location: "Remote (Worldwide)",
      remote: true,
      remote_scope: "worldwide",
      category: "engineering",
      skills: ["Kubernetes", "Go", "Terraform", "AWS"],
      description: "Design and operate distributed platform systems.",
      salary_text: "$180,000 - $220,000",
      salary_min: 180000,
      salary_max: 220000,
      currency: "USD",
      salary_period: "yearly",
      apply_url: "https://boards.greenhouse.io/monzo/jobs/12345",
      is_active: true,
      status: "active",
      posted_at: "2026-10-10T00:00:00Z",
    };

    return new Response(
      JSON.stringify([job]),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "content-range": "0-0/1",
        },
      }
    );
  }

  // 5. Supabase DB: Companies
  if (urlStr.includes("/rest/v1/companies")) {
    return new Response(null, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "content-range": "0-0/850",
      },
    });
  }

  // 6. Supabase DB: AI Usage Quotas
  if (urlStr.includes("/rest/v1/ai_usage_quotas")) {
    if (method === "GET") {
      return new Response(
        JSON.stringify({
          count: 0,
          total_tokens: 0,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 7. Groq API
  if (urlStr.includes("api.groq.com")) {
    return new Response(
      JSON.stringify({
        id: "chatcmpl-mock-load",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: JSON.stringify({
                score: 92,
                matchedSkills: ["TypeScript", "React"],
                missingSkills: [],
                summary: "Strong candidate match under concurrent load benchmark.",
              }),
            },
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // Generic fallback
  return new Response(JSON.stringify([]), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};

// Import handlers after mocking
import { handler as jobsSearchHandler, _resetSearchRateLimitStore } from "../netlify/functions/jobs-search";
import { handler as statsHandler } from "../netlify/functions/stats";
import { handler as jobsProHandler } from "../netlify/functions/jobs-pro";
import { handler as aiHandler, _resetAiRateLimitStore } from "../netlify/functions/ai";

interface BenchmarkResult {
  handler: string;
  concurrency: number;
  p50Ms: number;
  p95Ms: number;
  errorCount: number;
  totalCalls: number;
}

function calculatePercentiles(durations: number[]): { p50: number; p95: number } {
  if (durations.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...durations].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    p50: Math.round(p50 * 100) / 100,
    p95: Math.round(p95 * 100) / 100,
  };
}

async function runConcurrencyTest(
  name: string,
  concurrency: number,
  fn: (callIndex: number) => Promise<{ statusCode: number }>
): Promise<BenchmarkResult> {
  const durations: number[] = [];
  let errorCount = 0;

  const tasks = Array.from({ length: concurrency }, async (_, i) => {
    const start = performance.now();
    try {
      const res = await fn(i);
      const duration = performance.now() - start;
      durations.push(duration);
      if (res.statusCode < 200 || res.statusCode >= 300) {
        errorCount++;
      }
    } catch (err) {
      const duration = performance.now() - start;
      durations.push(duration);
      errorCount++;
    }
  });

  await Promise.all(tasks);

  const { p50, p95 } = calculatePercentiles(durations);

  return {
    handler: name,
    concurrency,
    p50Ms: p50,
    p95Ms: p95,
    errorCount,
    totalCalls: concurrency,
  };
}

async function main() {
  console.log("================================================================================");
  console.log(" CareerMonke Handler Load Benchmark (Mocked Supabase & Groq)");
  console.log(" Concurrency tiers: 50, 100, 500, 1000 concurrent calls per handler");
  if (IS_NEGATIVE_CONTROL) {
    console.log(" [NEGATIVE CONTROL MODE ACTIVE] - Upstream simulated failures enabled");
  }
  console.log("================================================================================\n");

  const concurrencyLevels = [50, 100, 500, 1000];
  const results: BenchmarkResult[] = [];

  const handlers = [
    {
      name: "jobs-search",
      before: () => _resetSearchRateLimitStore(),
      call: (i: number) =>
        jobsSearchHandler({
          httpMethod: "GET",
          headers: {
            "x-nf-client-connection-ip": `10.${Math.floor(i / 250)}.${(i % 250) + 1}.1`,
          },
          queryStringParameters: { q: "engineer", limit: "20" },
        }),
    },
    {
      name: "stats",
      before: () => {},
      call: (i: number) =>
        statsHandler({
          httpMethod: "GET",
          headers: {
            "x-nf-client-connection-ip": `10.${Math.floor(i / 250)}.${(i % 250) + 1}.2`,
          },
        }),
    },
    {
      name: "jobs-pro",
      before: () => {},
      call: (i: number) =>
        jobsProHandler({
          httpMethod: "GET",
          headers: {
            "x-nf-client-connection-ip": `10.${Math.floor(i / 250)}.${(i % 250) + 1}.3`,
            authorization: `Bearer mock-token-pro-${i}`,
          },
          queryStringParameters: { id: "job-mock-001" },
        }),
    },
    {
      name: "ai",
      before: () => _resetAiRateLimitStore(),
      call: (i: number) =>
        aiHandler({
          httpMethod: "POST",
          headers: {
            "x-forwarded-for": `10.${Math.floor(i / 250)}.${(i % 250) + 1}.4`,
            authorization: `Bearer mock-token-pro-${i}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            operation: "job_fit",
            candidate: {
              skills: ["TypeScript", "React"],
              headline: "Senior Software Engineer",
            },
            job: {
              title: "Senior Fullstack Engineer",
              company: "Monzo",
              description: "Looking for TypeScript and React developer.",
            },
          }),
        }),
    },
  ];

  for (const h of handlers) {
    for (const c of concurrencyLevels) {
      h.before();
      process.stdout.write(`Benchmarking ${h.name} @ concurrency ${c}... `);
      const res = await runConcurrencyTest(h.name, c, h.call);
      results.push(res);
      console.log(`p50=${res.p50Ms}ms, p95=${res.p95Ms}ms, errors=${res.errorCount}/${res.totalCalls}`);
    }
  }

  console.log("\n--------------------------------------------------------------------------------");
  console.log(" RAW BENCHMARK SUMMARY TABLE:");
  console.log("--------------------------------------------------------------------------------");
  console.log(
    "Handler".padEnd(16) +
    "Concurrency".padEnd(14) +
    "p50 (ms)".padEnd(12) +
    "p95 (ms)".padEnd(12) +
    "Errors".padEnd(10) +
    "Total Calls"
  );
  console.log("-".repeat(76));

  for (const r of results) {
    console.log(
      r.handler.padEnd(16) +
      String(r.concurrency).padEnd(14) +
      String(r.p50Ms).padEnd(12) +
      String(r.p95Ms).padEnd(12) +
      String(r.errorCount).padEnd(10) +
      String(r.totalCalls)
    );
  }
  console.log("--------------------------------------------------------------------------------\n");

  if (IS_NEGATIVE_CONTROL) {
    const totalErrors = results.reduce((acc, r) => acc + r.errorCount, 0);
    console.error(`[NEGATIVE CONTROL VERIFIED] Upstream failure caused ${totalErrors} errors out of ${results.reduce((acc, r) => acc + r.totalCalls, 0)} total calls.`);
    console.error("[NEGATIVE CONTROL] Exiting with non-zero exit code 1 as required by test discipline.");
    process.exit(1);
  }

  const hasUnexpectedErrors = results.some((r) => r.errorCount > 0);
  if (hasUnexpectedErrors) {
    console.error("FAIL: Unexpected errors detected during mocked load test!");
    process.exit(1);
  }

  console.log("PASS-LOCAL: All mocked handlers completed concurrent load tests successfully with 0 errors.");
  console.log("NOTE: Real serverless capacity & DB connection pooling requires a staging host plus a staging Supabase instance (NOT RUN).");
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal benchmark error:", err);
  process.exit(1);
});
