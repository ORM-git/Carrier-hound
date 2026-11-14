import assert from "assert";
import Module from "module";

// Ensure test environment variables
process.env.NODE_ENV = "test";
process.env.NEXT_PUBLIC_SITE_URL = "https://careermonke.com";
process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_URL = "https://mock-supabase.local";
process.env.SUPABASE_SERVICE_ROLE_KEY = "mock-service-role-key-test-value-12345678901234567890";
process.env.SUPABASE_SERVICE_KEY = "mock-service-role-key-test-value-12345678901234567890";
process.env.SUPABASE_ANON_KEY = "mock-anon-key-test-value-1234567890";

// Register virtual @cloudflare/next-on-pages shim for Node.js test environment
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

const isNegativeControl = process.argv.includes("--negative-control");

const MOCK_PRO_TOKEN = "Bearer mock-pro-jwt-token-12345";
const MOCK_USER_ID = "00000000-0000-4000-a000-000000000099";

const MOCK_JOBS: Record<string, any> = {
  "job-null-desc": {
    id: "job-null-desc",
    title: "Senior Full Stack Engineer",
    company: "Stripe",
    location: "Remote (US)",
    salary_min: 160000,
    salary_max: 200000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$160k - $200k",
    description: null, // NULL in jobs table
    skills: ["React", "TypeScript", "Node.js"],
    apply_url: "https://stripe.com/apply/1",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    job_type: "full-time",
    category: "engineering",
    country: "US",
    country_code: "US",
    posted_at: "2026-11-14T00:00:00Z",
    first_seen_at: "2026-11-14T00:00:00Z",
    status: "active",
    is_active: true,
  },
  "job-nonempty-desc": {
    id: "job-nonempty-desc",
    title: "Staff Platform Engineer",
    company: "GitHub",
    location: "Remote (US)",
    salary_min: 190000,
    salary_max: 240000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$190k - $240k",
    description: "Existing non-empty description from jobs table.", // Non-empty in jobs
    skills: ["Go", "Kubernetes", "AWS"],
    apply_url: "https://github.com/apply/2",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    job_type: "full-time",
    category: "engineering",
    country: "US",
    country_code: "US",
    posted_at: "2026-11-14T01:00:00Z",
    first_seen_at: "2026-11-14T01:00:00Z",
    status: "active",
    is_active: true,
  },
  "job-both-empty": {
    id: "job-both-empty",
    title: "Junior QA Engineer",
    company: "Acme Corp",
    location: "Remote (US)",
    salary_min: 70000,
    salary_max: 90000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$70k - $90k",
    description: null, // NULL in jobs
    skills: ["Jest", "Cypress"],
    apply_url: "https://acme.com/apply/3",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    job_type: "full-time",
    category: "engineering",
    country: "US",
    country_code: "US",
    posted_at: "2026-11-14T02:00:00Z",
    first_seen_at: "2026-11-14T02:00:00Z",
    status: "active",
    is_active: true,
  },
  "job-both-whitespace": {
    id: "job-both-whitespace",
    title: "Documentation Writer",
    company: "OpenSource Org",
    location: "Remote (US)",
    salary_min: 60000,
    salary_max: 80000,
    currency: "USD",
    salary_period: "year",
    salary_text: "$60k - $80k",
    description: "   ", // Whitespace in jobs
    skills: ["Markdown", "Git"],
    apply_url: "https://opensource.org/apply/4",
    remote: true,
    remote_scope: "worldwide",
    remote_eligibility: "worldwide",
    job_type: "full-time",
    category: "content",
    country: "US",
    country_code: "US",
    posted_at: "2026-11-14T03:00:00Z",
    first_seen_at: "2026-11-14T03:00:00Z",
    status: "active",
    is_active: true,
  },
};

const MOCK_JOB_DESCRIPTIONS: Record<string, string> = {
  "job-null-desc": "Requirements from job_descriptions table: 5+ years React, TypeScript, Next.js architecture.",
  "job-nonempty-desc": "Shadow description in job_descriptions table that should NOT be used because jobs.description is non-empty.",
  "job-both-whitespace": "   ", // Whitespace in job_descriptions as well
};

const originalFetch = global.fetch;

function setupMockFetch() {
  global.fetch = async (input: any, init?: any): Promise<Response> => {
    const urlStr = typeof input === "string" ? input : input?.url || String(input);

    // 1. Supabase Auth getUser
    if (urlStr.includes("/auth/v1/user")) {
      return new Response(
        JSON.stringify({
          id: MOCK_USER_ID,
          email: "pro@careermonke.com",
          user_metadata: {},
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 2. Blocked users check (ban check)
    if (urlStr.includes("/rest/v1/blocked_users")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Subscriptions check (Pro entitlement)
    if (urlStr.includes("/rest/v1/subscriptions")) {
      return new Response(
        JSON.stringify([
          {
            id: "sub-12345",
            user_id: MOCK_USER_ID,
            status: "active",
            plan_id: "monthly_tier_1",
            current_period_start: "2026-01-01T00:00:00Z",
            current_period_end: "2099-01-01T00:00:00Z",
          },
        ]),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    // 4. User preferences
    if (urlStr.includes("/rest/v1/user_preferences")) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 5. Job descriptions query (public.job_descriptions)
    if (urlStr.includes("/rest/v1/job_descriptions")) {
      const parsedUrl = new URL(urlStr);
      const inParam = parsedUrl.searchParams.get("job_id");
      let requestedIds: string[] = [];

      if (inParam) {
        // PostgREST format: in.(id1,id2,...) or eq.id
        const clean = inParam.replace(/^in\.\(/, "").replace(/\)$/, "").replace(/^eq\./, "");
        requestedIds = clean.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
      }

      const rows: any[] = [];
      for (const [jobId, descText] of Object.entries(MOCK_JOB_DESCRIPTIONS)) {
        if (requestedIds.length === 0 || requestedIds.includes(jobId)) {
          rows.push({
            job_id: jobId,
            description_text: descText,
          });
        }
      }

      return new Response(JSON.stringify(rows), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    // 6. Jobs table query (public.jobs)
    if (urlStr.includes("/rest/v1/jobs")) {
      const parsedUrl = new URL(urlStr);
      const idParam = parsedUrl.searchParams.get("id");
      let matchedJobs: any[] = [];

      if (idParam) {
        if (idParam.startsWith("eq.")) {
          const targetId = idParam.replace(/^eq\./, "").trim();
          if (MOCK_JOBS[targetId]) matchedJobs.push(MOCK_JOBS[targetId]);
        } else if (idParam.startsWith("in.")) {
          const clean = idParam.replace(/^in\.\(/, "").replace(/\)$/, "");
          const targetIds = clean.split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
          for (const tid of targetIds) {
            if (MOCK_JOBS[tid]) matchedJobs.push(MOCK_JOBS[tid]);
          }
        }
      } else {
        matchedJobs = Object.values(MOCK_JOBS);
      }

      return new Response(JSON.stringify(matchedJobs), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return originalFetch(input, init);
  };
}

async function runSuite() {
  console.log("================================================================================");
  console.log("     CAREERMONKE PRO JOB DESCRIPTIONS & WHY-MATCH REQUIREMENTS TEST             ");
  console.log("================================================================================");

  if (isNegativeControl) {
    console.log("[NEGATIVE CONTROL] Asserting deliberate contradiction...");
    assert.strictEqual(true, false, "Negative control deliberate failure.");
    return;
  }

  setupMockFetch();

  const { GET: nextJobsProGet, POST: nextJobsProPost } = await import("../src/app/api/jobs/pro/route");
  const { handler: netlifyJobsProHandler } = await import("../netlify/functions/jobs-pro");

  // ---------------------------------------------------------------------------
  // TEST 1: jobs.description null + matching job_descriptions row returns description_text
  // ---------------------------------------------------------------------------
  console.log("TEST 1: jobs.description null + matching job_descriptions row returns description_text");

  // 1A. Next.js GET single ID
  {
    const req = new Request("https://careermonke.com/api/jobs/pro?id=job-null-desc", {
      headers: { Authorization: MOCK_PRO_TOKEN },
    });
    const res = await nextJobsProGet(req);
    assert.strictEqual(res.status, 200, "Next GET /api/jobs/pro?id=job-null-desc must return 200");
    const data = await res.json();
    assert.strictEqual(
      data.job?.description,
      "Requirements from job_descriptions table: 5+ years React, TypeScript, Next.js architecture.",
      "Next GET: jobs.description null must be resolved from job_descriptions.description_text"
    );
  }

  // 1B. Netlify GET single ID
  {
    const event = {
      httpMethod: "GET",
      headers: { authorization: MOCK_PRO_TOKEN },
      queryStringParameters: { id: "job-null-desc" },
    };
    const res = await netlifyJobsProHandler(event);
    assert.strictEqual(res.statusCode, 200, "Netlify GET jobs-pro?id=job-null-desc must return 200");
    const data = JSON.parse(res.body);
    assert.strictEqual(
      data.job?.description,
      "Requirements from job_descriptions table: 5+ years React, TypeScript, Next.js architecture.",
      "Netlify GET: jobs.description null must be resolved from job_descriptions.description_text"
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 2: non-empty jobs.description wins
  // ---------------------------------------------------------------------------
  console.log("TEST 2: non-empty jobs.description wins over job_descriptions shadow row");

  // 2A. Next.js GET single ID
  {
    const req = new Request("https://careermonke.com/api/jobs/pro?id=job-nonempty-desc", {
      headers: { Authorization: MOCK_PRO_TOKEN },
    });
    const res = await nextJobsProGet(req);
    assert.strictEqual(res.status, 200, "Next GET /api/jobs/pro?id=job-nonempty-desc must return 200");
    const data = await res.json();
    assert.strictEqual(
      data.job?.description,
      "Existing non-empty description from jobs table.",
      "Next GET: non-empty jobs.description must win over job_descriptions shadow row"
    );
  }

  // 2B. Netlify GET single ID
  {
    const event = {
      httpMethod: "GET",
      headers: { authorization: MOCK_PRO_TOKEN },
      queryStringParameters: { id: "job-nonempty-desc" },
    };
    const res = await netlifyJobsProHandler(event);
    assert.strictEqual(res.statusCode, 200, "Netlify GET jobs-pro?id=job-nonempty-desc must return 200");
    const data = JSON.parse(res.body);
    assert.strictEqual(
      data.job?.description,
      "Existing non-empty description from jobs table.",
      "Netlify GET: non-empty jobs.description must win over job_descriptions shadow row"
    );
  }

  // ---------------------------------------------------------------------------
  // TEST 3: both empty returns "" without throwing
  // ---------------------------------------------------------------------------
  console.log("TEST 3: both empty returns '' without throwing");

  // 3A. Next.js GET with missing job_descriptions row (job-both-empty)
  {
    const req = new Request("https://careermonke.com/api/jobs/pro?id=job-both-empty", {
      headers: { Authorization: MOCK_PRO_TOKEN },
    });
    const res = await nextJobsProGet(req);
    assert.strictEqual(res.status, 200, "Next GET /api/jobs/pro?id=job-both-empty must return 200");
    const data = await res.json();
    assert.strictEqual(data.job?.description, "", "Next GET: both empty must return ''");
  }

  // 3B. Netlify GET with missing job_descriptions row (job-both-empty)
  {
    const event = {
      httpMethod: "GET",
      headers: { authorization: MOCK_PRO_TOKEN },
      queryStringParameters: { id: "job-both-empty" },
    };
    const res = await netlifyJobsProHandler(event);
    assert.strictEqual(res.statusCode, 200, "Netlify GET jobs-pro?id=job-both-empty must return 200");
    const data = JSON.parse(res.body);
    assert.strictEqual(data.job?.description, "", "Netlify GET: both empty must return ''");
  }

  // 3C. Next.js GET with whitespace in both (job-both-whitespace)
  {
    const req = new Request("https://careermonke.com/api/jobs/pro?id=job-both-whitespace", {
      headers: { Authorization: MOCK_PRO_TOKEN },
    });
    const res = await nextJobsProGet(req);
    assert.strictEqual(res.status, 200, "Next GET /api/jobs/pro?id=job-both-whitespace must return 200");
    const data = await res.json();
    assert.strictEqual(data.job?.description, "", "Next GET: whitespace in both must resolve to ''");
  }

  // ---------------------------------------------------------------------------
  // TEST 4: multiple ids return correct descriptions (POST endpoint & country GET)
  // ---------------------------------------------------------------------------
  console.log("TEST 4: multiple ids return correct descriptions across batch POST and country GET");

  const expectedDescriptions: Record<string, string> = {
    "job-null-desc": "Requirements from job_descriptions table: 5+ years React, TypeScript, Next.js architecture.",
    "job-nonempty-desc": "Existing non-empty description from jobs table.",
    "job-both-empty": "",
    "job-both-whitespace": "",
  };

  // 4A. Next.js POST batch unlock
  {
    const req = new Request("https://careermonke.com/api/jobs/pro", {
      method: "POST",
      headers: {
        Authorization: MOCK_PRO_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ids: ["job-null-desc", "job-nonempty-desc", "job-both-empty", "job-both-whitespace"],
      }),
    });
    const res = await nextJobsProPost(req);
    assert.strictEqual(res.status, 200, "Next POST /api/jobs/pro must return 200");
    const data = await res.json();
    assert.strictEqual(data.jobs?.length, 4, "Next POST: must return 4 jobs");

    for (const job of data.jobs) {
      assert.strictEqual(
        job.description,
        expectedDescriptions[job.id],
        `Next POST: job ${job.id} description must match expected value`
      );
    }
  }

  // 4B. Netlify POST batch unlock
  {
    const event = {
      httpMethod: "POST",
      headers: {
        authorization: MOCK_PRO_TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ids: ["job-null-desc", "job-nonempty-desc", "job-both-empty", "job-both-whitespace"],
      }),
    };
    const res = await netlifyJobsProHandler(event);
    assert.strictEqual(res.statusCode, 200, "Netlify POST jobs-pro must return 200");
    const data = JSON.parse(res.body);
    assert.strictEqual(data.jobs?.length, 4, "Netlify POST: must return 4 jobs");

    for (const job of data.jobs) {
      assert.strictEqual(
        job.description,
        expectedDescriptions[job.id],
        `Netlify POST: job ${job.id} description must match expected value`
      );
    }
  }

  // 4C. Next.js GET by country
  {
    const req = new Request("https://careermonke.com/api/jobs/pro?country_code=US", {
      headers: { Authorization: MOCK_PRO_TOKEN },
    });
    const res = await nextJobsProGet(req);
    assert.strictEqual(res.status, 200, "Next GET /api/jobs/pro?country_code=US must return 200");
    const data = await res.json();
    assert.ok(data.jobs?.length >= 4, "Next country GET: must return list of jobs");

    for (const job of data.jobs) {
      if (expectedDescriptions[job.id] !== undefined) {
        assert.strictEqual(
          job.description,
          expectedDescriptions[job.id],
          `Next country GET: job ${job.id} description must match expected value`
        );
      }
    }
  }

  // 4D. Netlify GET by country
  {
    const event = {
      httpMethod: "GET",
      headers: { authorization: MOCK_PRO_TOKEN },
      queryStringParameters: { country_code: "US" },
    };
    const res = await netlifyJobsProHandler(event);
    assert.strictEqual(res.statusCode, 200, "Netlify GET jobs-pro?country_code=US must return 200");
    const data = JSON.parse(res.body);
    assert.ok(data.jobs?.length >= 4, "Netlify country GET: must return list of jobs");

    for (const job of data.jobs) {
      if (expectedDescriptions[job.id] !== undefined) {
        assert.strictEqual(
          job.description,
          expectedDescriptions[job.id],
          `Netlify country GET: job ${job.id} description must match expected value`
        );
      }
    }
  }

  console.log("\nAll 4 test scenarios passed across both Next.js and Netlify handlers!");
}

runSuite().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
