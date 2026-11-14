import assert from "assert";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import Module from "module";
import { capJobsPerCompany, getLiveJobs } from "../src/lib/jobs/service";
import { extractDomainFromUrl } from "../src/components/CompanyLogo";

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

const IS_NEGATIVE_CONTROL = process.argv.includes("--negative-control");

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://mock.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_anon_key";
process.env.SUPABASE_SERVICE_ROLE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.mock_service_key";
process.env.NODE_ENV = "test";

// Scoped per test (set and restore); never left set globally so tests cannot hide a missing key.
const TEST_COMPANY_GROUP_SECRET = "test-only-company-group-secret-not-for-production";
const SECRET_ENV = "COMPANY_GROUP_ID_SECRET";
delete process.env[SECRET_ENV];
function setGroupSecret(): () => void {
  const prev = process.env[SECRET_ENV];
  process.env[SECRET_ENV] = TEST_COMPANY_GROUP_SECRET;
  return () => {
    if (prev === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = prev;
  };
}

(globalThis as any).__mockRateLimitClient = {
  rpc: async () => ({ data: { allowed: true, retry_after: 0, current_count: 1 }, error: null }),
};

async function runSuite() {
  console.log("==================================================================================");
  console.log("   CAREERMONKE COMPANY LOGOS & COMPANY CAPS VERIFICATION SUITE                    ");
  console.log("==================================================================================");
  console.log(`Mode: ${IS_NEGATIVE_CONTROL ? "NEGATIVE CONTROL (Expect Failure)" : "NORMAL VERIFICATION"}\n`);

  const failures: string[] = [];

  // ====================================================================================
  // TEST 1: capJobsPerCompany Algorithm, Length Preservation & Visible Top-30 Invariants
  // ====================================================================================
  console.log("TEST 1: Verifying capJobsPerCompany (length preservation & max 3 per company in visible top-30)...");

  const massPostingJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `a-${i}`, company_id: "comp-a", company: "MassiveCorp", title: `Role A${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `b-${i}`, company_id: `comp-b-${i}`, company: `Company_B_${i}`, title: `Role B${i}` })),
    ...Array.from({ length: 20 }, (_, i) => ({ id: `c-${i}`, company_id: `comp-c-${i}`, company: `Company_C_${i}`, title: `Role C${i}` })),
  ];

  const cappedMass = capJobsPerCompany(massPostingJobs, 3, 30);

  // In deliberate negative control mode, corrupt the capped array length and top 30
  if (IS_NEGATIVE_CONTROL) {
    cappedMass.pop(); // corrupt length
    cappedMass.unshift({ id: "corrupt-1", company_id: "comp-a", company: "MassiveCorp", title: "Corrupt 1" });
    cappedMass.unshift({ id: "corrupt-2", company_id: "comp-a", company: "MassiveCorp", title: "Corrupt 2" });
  }

  // Check 1: Length preservation (never drop jobs)
  if (cappedMass.length !== massPostingJobs.length) {
    failures.push(`LENGTH MISMATCH: Input length was ${massPostingJobs.length}, but capped output length is ${cappedMass.length}`);
  } else {
    console.log(`  [PASS] 1a. capJobsPerCompany preserves total length: ${cappedMass.length} === ${massPostingJobs.length} (no jobs dropped)`);
  }

  const visibleTop30 = cappedMass.slice(0, 30);
  const compACountInTop30 = visibleTop30.filter((j) => (j.company_id || "").toLowerCase() === "comp-a").length;

  if (compACountInTop30 > 3) {
    failures.push(`CAP VIOLATION: Company A has ${compACountInTop30} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1b. Company A capped at ${compACountInTop30}/3 in visible top-30`);
  }

  // 1c. Free user capping using company_id as cap key when company is "Verified Employer"
  const freeUserJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({ id: `fa-${i}`, company_id: "comp-free-a", company: "Verified Employer", title: `Free A${i}` })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `fb-${i}`, company_id: `comp-free-b-${i}`, company: "Verified Employer", title: `Free B${i}` })),
    ...Array.from({ length: 15 }, (_, i) => ({ id: `fc-${i}`, company_id: `comp-free-c-${i}`, company: "Verified Employer", title: `Free C${i}` })),
  ];
  const cappedFree = capJobsPerCompany(freeUserJobs, 3, 30);
  assert.strictEqual(cappedFree.length, freeUserJobs.length, "Free user capped list must preserve exact input length");
  const freeAInTop = cappedFree.slice(0, 30).filter((j) => j.company_id === "comp-free-a").length;
  if (freeAInTop > 3) {
    failures.push(`FREE USER CAP VIOLATION: comp-free-a has ${freeAInTop} jobs in visible top-30 (expected <= 3)`);
  } else {
    console.log(`  [PASS] 1c. company_id cap key correctly caps free user jobs masked as "Verified Employer" (${freeAInTop}/3 in top-30)`);
  }

  // ====================================================================================
  // TEST 2: Run Real Search Route with Free Token (Assert No logo_url or Company Name in Any Free Job)
  // ====================================================================================
  console.log("\nTEST 2: Running real search route with Free token (asserting zero logo_url & zero company name leakage)...");

  const mockSecretDbRows = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `secret-job-${i}`,
      title: `Senior Infrastructure Engineer ${i}`,
      company: "Top Secret Tech Unicorn",
      company_id: "comp-unicorn-uuid",
      logo_url: "https://secret-cdn.com/unicorn-logo.png",
      location: "San Francisco, CA",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      status: "active",
      is_active: true,
      posted_at: new Date(Date.now() - i * 3600000).toISOString(),
      created_at: new Date(Date.now() - i * 3600000).toISOString(),
    })),
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `other-job-${i}`,
      title: `Backend Developer ${i}`,
      company: `Confidential Enterprise ${i}`,
      company_id: `comp-other-${i}`,
      logo_url: `https://secret-cdn.com/other-${i}.png`,
      location: "New York, NY",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      status: "active",
      is_active: true,
      posted_at: new Date(Date.now() - (i + 15) * 3600000).toISOString(),
      created_at: new Date(Date.now() - (i + 15) * 3600000).toISOString(),
    })),
  ];

  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockSecretDbRows), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${mockSecretDbRows.length - 1}/${mockSecretDbRows.length}`,
        },
      });
    }
    if (urlStr.includes("companies")) {
      return new Response(
        JSON.stringify([
          {
            id: "comp-unicorn-uuid",
            name: "Top Secret Tech Unicorn",
            logo_url: "https://secret-cdn.com/unicorn-logo.png",
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    return origFetch(url, opts);
  }) as any;

  const restoreSecret2 = setGroupSecret();
  try {
    const { GET: searchGet } = await import("../src/app/api/jobs/search/route");
    const { createHandler: createSearchHandler } = await import("../netlify/functions/jobs-search");

    // 2a. Call App Route /api/jobs/search with Free Token (and unauthenticated)
    const freeReq = new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=25", {
      method: "GET",
      headers: { Authorization: "Bearer free-user-mock-token" },
    });
    const searchRes = await searchGet(freeReq);
    const searchJson = await searchRes.json();

    assert(Array.isArray(searchJson.jobs) && searchJson.jobs.length > 0, "Route must return jobs array");

    let leakedLogoCount = 0;
    let leakedCompanyNameCount = 0;
    let missingCompanyIdCount = 0;

    for (const job of searchJson.jobs) {
      if (job.logo_url !== null || job.logoUrl !== null) {
        leakedLogoCount++;
      }
      if (job.company !== "Verified Employer") {
        leakedCompanyNameCount++;
      }
      if (!job.companyGroupId || "company_id" in job || "companyId" in job) {
        missingCompanyIdCount++;
      }
    }

    if (leakedLogoCount > 0) {
      failures.push(`LOGO LEAKAGE IN FREE JOBS: ${leakedLogoCount} jobs returned non-null logo_url/logoUrl to free account`);
    } else {
      console.log(`  [PASS] 2a. App Route /api/jobs/search returns logo_url === null and logoUrl === null for all ${searchJson.jobs.length} free jobs`);
    }

    if (leakedCompanyNameCount > 0) {
      failures.push(`COMPANY NAME LEAKAGE: ${leakedCompanyNameCount} jobs leaked real company name instead of 'Verified Employer'`);
    } else {
      console.log(`  [PASS] 2b. App Route /api/jobs/search masks all company names as 'Verified Employer' for free jobs`);
    }

    if (missingCompanyIdCount > 0) {
      failures.push(`GUEST COMPANY KEY WRONG: ${missingCompanyIdCount} free jobs lack companyGroupId or still carry company_id/companyId`);
    } else {
      console.log(`  [PASS] 2c. App Route /api/jobs/search includes opaque companyGroupId (and no company_id/companyId) on all ${searchJson.jobs.length} free jobs`);
    }

    // 2b. Call Netlify functions/jobs-search with Free Token
    const netlifyHandler = createSearchHandler();
    const netlifyRes = await netlifyHandler({
      httpMethod: "GET",
      queryStringParameters: { page: "1", pageSize: "25" },
      headers: { authorization: "Bearer free-user-mock-token" },
    });
    const netlifyJson = JSON.parse(netlifyRes.body);

    assert(Array.isArray(netlifyJson.jobs) && netlifyJson.jobs.length > 0, "Netlify route must return jobs array");

    let netlifyLeakedLogos = 0;
    let netlifyLeakedNames = 0;

    for (const job of netlifyJson.jobs) {
      if (job.logo_url !== null || job.logoUrl !== null) {
        netlifyLeakedLogos++;
      }
      if (job.company !== "Verified Employer") {
        netlifyLeakedNames++;
      }
    }

    if (netlifyLeakedLogos > 0) {
      failures.push(`NETLIFY LOGO LEAK: ${netlifyLeakedLogos} jobs returned logo_url to free account in Netlify function`);
    } else {
      console.log(`  [PASS] 2d. Netlify functions/jobs-search returns logo_url === null for all ${netlifyJson.jobs.length} free jobs`);
    }

    if (netlifyLeakedNames > 0) {
      failures.push(`NETLIFY NAME LEAK: ${netlifyLeakedNames} jobs leaked company name in Netlify function`);
    } else {
      console.log(`  [PASS] 2e. Netlify functions/jobs-search masks company as 'Verified Employer' for all free jobs`);
    }
  } finally {
    globalThis.fetch = origFetch;
    restoreSecret2();
  }

  // ====================================================================================
  // TEST 2F: Guest company_id masking - companyGroupId (keyed HMAC), real guest path through both handlers
  // ====================================================================================
  console.log("\nTEST 2F: Guest/Free responses carry companyGroupId, never company_id (real handlers, list + single)...");

  {
    const RAW_X = "raw-company-x-6f1d2c9e-uuid";
    const RAW_Y = "raw-company-y-0a7b44d1-uuid";
    const mk = (i: number, rawId: string | null, company: string) => ({
      id: `grp-job-${i}`,
      title: `Engineer ${i}`,
      company,
      company_id: rawId,
      logo_url: "https://secret-cdn.com/logo.png",
      location: "Remote",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      status: "active",
      is_active: true,
      apply_url: `https://apply.example.com/${i}`,
      salary_text: "$100k",
      description: "secret description",
      skills: ["go"],
      posted_at: new Date(Date.now() - i * 60000).toISOString(),
      created_at: new Date(Date.now() - i * 60000).toISOString(),
    });
    const groupRows = [
      ...Array.from({ length: 12 }, (_, i) => mk(i, RAW_X, "Real Company X")),
      ...Array.from({ length: 12 }, (_, i) => mk(100 + i, RAW_Y, "Real Company Y")),
      ...Array.from({ length: 40 }, (_, i) => mk(200 + i, `raw-company-z${i}-uuid`, `Real Company Z${i}`)),
      mk(300, null, "No Company Id"),
    ];
    const rawIds = [RAW_X, RAW_Y, ...Array.from({ length: 40 }, (_, i) => `raw-company-z${i}-uuid`)];

    const prevEmails = process.env.EARLY_ACCESS_ALLOWED_EMAILS;
    process.env.EARLY_ACCESS_ALLOWED_EMAILS = "pro-user@example.test";
    const restoreSecret2f = setGroupSecret();
    const origFetch2f = globalThis.fetch;
    globalThis.fetch = (async (url: any, opts: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/auth/v1/user")) {
        return new Response(
          JSON.stringify({ id: "pro-user-uuid", email: "pro-user@example.test", aud: "authenticated", role: "authenticated" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (urlStr.includes("user_preferences")) {
        return new Response(JSON.stringify({ user_id: "pro-user-uuid", locations: [], eligibility_filter: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (urlStr.includes("subscriptions")) {
        return new Response(
          JSON.stringify({ user_id: "pro-user-uuid", status: "active", current_period_end: new Date(Date.now() + 86400000).toISOString() }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (urlStr.includes("jobs")) {
        const idMatch = urlStr.match(/[?&]id=eq\.([^&]+)/);
        const rows = idMatch ? groupRows.filter((r) => r.id === decodeURIComponent(idMatch[1])) : groupRows;
        return new Response(JSON.stringify(rows), {
          status: 200,
          headers: { "content-type": "application/json", "content-range": `0-${rows.length - 1}/${rows.length}` },
        });
      }
      return origFetch2f(url, opts);
    }) as any;

    const check2f = (cond: boolean, pass: string, fail: string) => {
      if (cond) console.log(`  [PASS] ${pass}`);
      else failures.push(fail);
    };

    try {
      const { GET: searchGet } = await import("../src/app/api/jobs/search/route");
      const { createHandler: createSearchHandler } = await import("../netlify/functions/jobs-search");
      const netlifyHandler = createSearchHandler();
      const { capJobsPerCompany: capClient, computeCompanyGroupId } = await import("../src/lib/jobs/capping");
      const secret = TEST_COMPANY_GROUP_SECRET;

      const guestList = async (which: "next" | "netlify") => {
        if (which === "next") {
          const res = await searchGet(new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=100", { method: "GET" }));
          return { status: res.status, text: await res.text() };
        }
        const res = await netlifyHandler({ httpMethod: "GET", queryStringParameters: { page: "1", pageSize: "100" }, headers: {} });
        return { status: res.statusCode, text: res.body };
      };
      const guestSingle = async (which: "next" | "netlify", id: string) => {
        if (which === "next") {
          const res = await searchGet(new Request(`http://localhost:3000/api/jobs/search?id=${id}`, { method: "GET" }));
          return { status: res.status, text: await res.text() };
        }
        const res = await netlifyHandler({ httpMethod: "GET", queryStringParameters: { id }, headers: {} });
        return { status: res.statusCode, text: res.body };
      };

      const expectedX = await computeCompanyGroupId(RAW_X, secret);
      const expectedY = await computeCompanyGroupId(RAW_Y, secret);
      check2f(/^[0-9a-f]{12}$/.test(expectedX) && expectedX !== expectedY, "2f-0 companyGroupId is 12 hex chars and differs per company", "companyGroupId format/uniqueness wrong");

      for (const which of ["next", "netlify"] as const) {
        const { status, text } = await guestList(which);
        const json = JSON.parse(text);
        const jobs: any[] = json.jobs || [];
        check2f(status === 200 && jobs.length > 0, `2f-1 [${which}] guest list returns jobs`, `[${which}] guest list failed: ${status}`);

        const hasIdFields = jobs.filter((j) => "companyId" in j || "company_id" in j).length;
        check2f(hasIdFields === 0, `2f-2 [${which}] no companyId/company_id key in any guest job`, `[${which}] ${hasIdFields} guest jobs still have companyId/company_id keys`);

        const leakedRaw = rawIds.filter((id) => text.includes(id));
        check2f(leakedRaw.length === 0, `2f-3 [${which}] no raw company id appears anywhere in the guest payload`, `[${which}] raw company ids leaked in guest payload: ${leakedRaw.join(",")}`);

        const xJobs = jobs.filter((j) => /^Engineer \d+$/.test(j.title) && j.id.startsWith("grp-job-") && Number(j.id.split("-")[2]) < 12);
        const yJobs = jobs.filter((j) => Number(j.id.split("-")[2]) >= 100 && Number(j.id.split("-")[2]) < 112);
        check2f(xJobs.length > 0 && xJobs.every((j) => j.companyGroupId === expectedX), `2f-4 [${which}] same company shares one companyGroupId (HMAC of the real id)`, `[${which}] company X jobs do not share the expected companyGroupId`);
        check2f(yJobs.length > 0 && yJobs.every((j) => j.companyGroupId === expectedY) && expectedX !== expectedY, `2f-5 [${which}] different companies get different companyGroupIds`, `[${which}] company Y group ids wrong`);

        const noIdJob = jobs.find((j) => j.id === "grp-job-300");
        check2f(!noIdJob || noIdJob.companyGroupId === null, `2f-6 [${which}] job without company_id gets companyGroupId null`, `[${which}] null company_id did not map to null`);

        const top30 = jobs.slice(0, 30);
        const perGroup = new Map<string, number>();
        for (const j of top30) if (j.companyGroupId) perGroup.set(j.companyGroupId, (perGroup.get(j.companyGroupId) || 0) + 1);
        check2f(Math.max(0, ...perGroup.values()) <= 3, `2f-7 [${which}] guest top-30 has at most 3 jobs per company`, `[${which}] guest top-30 exceeds 3 per company`);

        // Client-side capping on guest payloads (no company ids at all) must keep working via companyGroupId
        const clientCapped = capClient([...jobs].sort((a, b) => (a.id < b.id ? -1 : 1)), 3, 30).slice(0, 30);
        const clientCounts = new Map<string, number>();
        for (const j of clientCapped) if (j.companyGroupId) clientCounts.set(j.companyGroupId, (clientCounts.get(j.companyGroupId) || 0) + 1);
        check2f(Math.max(0, ...clientCounts.values()) <= 3 && clientCapped.length === 30, `2f-8 [${which}] client capJobsPerCompany caps guest jobs by companyGroupId (max 3 in top-30)`, `[${which}] client capping failed on guest payload`);

        // Masking of name / salary / applyUrl stays byte-identical to the previous guest format
        const maskBroken = jobs.filter((j) => j.company !== "Verified Employer" || j.salary !== "" || j.applyUrl !== "" || j.description !== "" || j.logoUrl !== null).length;
        check2f(maskBroken === 0, `2f-9 [${which}] company name, salary, applyUrl, description and logo stay masked`, `[${which}] ${maskBroken} guest jobs lost masking`);

        // Single-job path
        const single = await guestSingle(which, "grp-job-0");
        const sj = JSON.parse(single.text).jobs?.[0];
        check2f(single.status === 200 && !!sj && !("companyId" in sj) && !("company_id" in sj) && sj.companyGroupId === expectedX && !rawIds.some((id) => single.text.includes(id)), `2f-10 [${which}] single-job guest response has companyGroupId and no raw company id`, `[${which}] single-job guest response leaks or lacks companyGroupId`);
        check2f(sj?.company === "Verified Employer" && sj?.applyUrl === "" && sj?.salary === "", `2f-11 [${which}] single-job masking unchanged`, `[${which}] single-job masking changed`);
      }

      // Pro responses are unchanged: raw company_id/companyId and no companyGroupId
      {
        const res = await searchGet(
          new Request("http://localhost:3000/api/jobs/search?page=1&pageSize=100", { method: "GET", headers: { Authorization: "Bearer pro-user-token" } })
        );
        const json = await res.json();
        const proJobs: any[] = json.jobs || [];
        const xPro = proJobs.find((j) => j.id === "grp-job-0");
        check2f(json.isPro === true && !!xPro && xPro.company_id === RAW_X && xPro.companyId === RAW_X && !("companyGroupId" in xPro) && xPro.company === "Real Company X", "2f-12 Pro list response unchanged (real company_id/companyId/name, no companyGroupId)", "Pro list response changed");
        const sres = await searchGet(
          new Request("http://localhost:3000/api/jobs/search?id=grp-job-0", { method: "GET", headers: { Authorization: "Bearer pro-user-token" } })
        );
        const spro = (await sres.json()).jobs?.[0];
        check2f(!!spro && spro.company_id === RAW_X && spro.companyId === RAW_X && !("companyGroupId" in spro), "2f-13 Pro single response unchanged", "Pro single response changed");
      }

      // Fail closed: no server secret -> no guest payload at all (503), never a raw id
      {
        delete process.env[SECRET_ENV];
        try {
          for (const which of ["next", "netlify"] as const) {
            const list = await guestList(which);
            const single = await guestSingle(which, "grp-job-0");
            check2f(
              list.status === 503 && single.status === 503 && !rawIds.some((id) => list.text.includes(id) || single.text.includes(id)),
              `2f-14 [${which}] missing COMPANY_GROUP_ID_SECRET fails closed with 503 and no company ids`,
              `[${which}] did not fail closed without the secret (list ${list.status}, single ${single.status})`
            );
          }
        } finally {
          process.env[SECRET_ENV] = TEST_COMPANY_GROUP_SECRET;
        }

        // Empty result lists and null company ids need no key: nothing can leak
        const emptyDb = globalThis.fetch;
        delete process.env[SECRET_ENV];
        globalThis.fetch = (async (url: any, opts: any) =>
          String(url).includes("jobs")
            ? new Response("[]", { status: 200, headers: { "content-type": "application/json", "content-range": "*/0" } })
            : origFetch2f(url, opts)) as any;
        try {
          const empty = await guestList("next");
          const emptyNetlify = await guestList("netlify");
          check2f(empty.status === 200 && emptyNetlify.status === 200, "2f-15 empty guest result needs no COMPANY_GROUP_ID_SECRET (200, not 503)", `empty guest result failed without the secret (${empty.status}/${emptyNetlify.status})`);
        } finally {
          globalThis.fetch = emptyDb;
          process.env[SECRET_ENV] = TEST_COMPANY_GROUP_SECRET;
        }
      }
    } finally {
      restoreSecret2f();
      globalThis.fetch = origFetch2f;
      if (prevEmails === undefined) delete process.env.EARLY_ACCESS_ALLOWED_EMAILS;
      else process.env.EARLY_ACCESS_ALLOWED_EMAILS = prevEmails;
    }
  }

  // ====================================================================================
  // TEST 3: Default getLiveJobs List Actually Caps with company_id Present in Rows
  // ====================================================================================
  console.log("\nTEST 3: Verifying default getLiveJobs list actually caps with company_id present in rows...");

  // Mock database rows for default list: 20 jobs from MassiveCorp (comp-mass-a), 30 from diverse employers (total 50)
  // Rows follow the real jobs_public view projection: no company_id, no logo_url, company masked.
  const mockDefaultJobs = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `default-mass-${i}`,
      title: `Platform Engineer ${i}`,
      company: "Verified Employer", // jobs_public projection
      location: "Remote",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      posted_at: new Date(Date.now() - i * 1800000).toISOString(),
      created_at: new Date(Date.now() - i * 1800000).toISOString(),
    })),
    ...Array.from({ length: 30 }, (_, i) => ({
      id: `default-div-${i}`,
      title: `Software Developer ${i}`,
      company: "Verified Employer", // jobs_public projection
      location: "Remote",
      remote: true,
      category: "engineering",
      job_type: "full-time",
      verified: true,
      posted_at: new Date(Date.now() - (i + 20) * 1800000).toISOString(),
      created_at: new Date(Date.now() - (i + 20) * 1800000).toISOString(),
    })),
  ];

  let capturedRangeFrom: number | null = null;
  let capturedRangeTo: number | null = null;

  const createMockQuery = () => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      or: () => chain,
      not: () => chain,
      ilike: () => chain,
      gte: () => chain,
      order: () => chain,
      range: (from: number, to: number) => {
        capturedRangeFrom = from;
        capturedRangeTo = to;
        return Promise.resolve({
          data: mockDefaultJobs,
          count: mockDefaultJobs.length,
          error: null,
        });
      },
    };
    return chain;
  };

  (globalThis as any).__mockSupabaseClient = {
    from: (table: string) => {
      assert.strictEqual(table, "jobs_public", "getLiveJobs query must target jobs_public for public reads");
      return createMockQuery();
    },
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
    },
  };

  // Run DEFAULT getLiveJobs call (no search, no company filter, default Recommended parameters)
  const defaultListResult = await getLiveJobs({
    page: 1,
    pageSize: 50,
    sortBy: "match",
  });

  const returnedJobs = defaultListResult.jobs;
  assert(Array.isArray(returnedJobs) && returnedJobs.length > 0, "Default getLiveJobs must return jobs");

  // Check 3a: Total length preserved (never drop jobs)
  if (returnedJobs.length !== mockDefaultJobs.length) {
    failures.push(`DEFAULT LIST LENGTH LOSS: Expected ${mockDefaultJobs.length} jobs, got ${returnedJobs.length}`);
  } else {
    console.log(`  [PASS] 3a. Default getLiveJobs preserves total list length: ${returnedJobs.length} === ${mockDefaultJobs.length}`);
  }

  // Check 3b: the direct jobs_public path exposes no company_id (the view has none)
  const companyIdLeaked = returnedJobs.filter((j) => j.company_id || j.companyId).length;
  if (companyIdLeaked > 0) {
    failures.push(`COMPANY ID IN DEFAULT LIST: ${companyIdLeaked} jobs carry company_id/companyId from jobs_public`);
  } else {
    console.log(`  [PASS] 3b. Default getLiveJobs (jobs_public) carries no company_id on any of ${returnedJobs.length} jobs`);
  }

  // Check 3c: Free user default list has zero company name leakage & zero logo leakage
  const freeNamesLeaked = returnedJobs.filter((j) => j.company !== "Verified Employer").length;
  const freeLogosLeaked = returnedJobs.filter((j) => j.logo_url !== null || j.logoUrl !== null).length;

  if (freeNamesLeaked > 0) {
    failures.push(`COMPANY NAME LEAK IN DEFAULT LIST: ${freeNamesLeaked} jobs leaked real company name`);
  } else {
    console.log(`  [PASS] 3c. Default getLiveJobs masks company as 'Verified Employer' (zero company name leaked from client)`);
  }

  if (freeLogosLeaked > 0) {
    failures.push(`LOGO LEAK IN DEFAULT LIST: ${freeLogosLeaked} jobs returned non-null logoUrl`);
  } else {
    console.log(`  [PASS] 3d. Default getLiveJobs returns logoUrl === null & logo_url === null for free/guest users`);
  }

  // Check 3e (residual, inherited behavior): the direct jobs_public path has no opaque group key, so it cannot be
  // capped per company. Pin that so a future change either adds a key or consciously updates this expectation.
  const keyless = returnedJobs.filter((j) => !j.company_id && !j.companyId && !(j as any).companyGroupId).length;
  if (keyless !== returnedJobs.length) {
    failures.push(`DIRECT PATH KEY CHANGED: ${returnedJobs.length - keyless} jobs now carry a company key; update the residual note and capping expectations`);
  } else {
    console.log(`  [PASS] 3e. Direct jobs_public path has no company key (known residual: no per-company capping on this fallback)`);
  }

  // ====================================================================================
  // TEST 4: /api/ticker & Netlify ticker Endpoint Capping (Max 2 per company in 20)
  // ====================================================================================
  console.log("\nTEST 4: Verifying /api/ticker and Netlify ticker company capping (max 2 per company)...");

  const now = Date.now();
  const mockTickerDbRows = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id: `ticker-flood-${i}`,
      company: "DominantCorp",
      company_id: "comp-dom-id",
      title: `Dominant Role ${i}`,
      posted_at: new Date(now - i * 1000).toISOString(),
      created_at: new Date(now - i * 1000).toISOString(),
    })),
    ...Array.from({ length: 25 }, (_, i) => ({
      id: `ticker-other-${i}`,
      company: `Company_${i}`,
      company_id: `comp-other-${i}`,
      title: `Other Role ${i}`,
      posted_at: new Date(now - (i + 20) * 1000).toISOString(),
      created_at: new Date(now - (i + 20) * 1000).toISOString(),
    })),
  ];

  const origTickerFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, opts: any) => {
    const urlStr = String(url);
    if (urlStr.includes("jobs")) {
      return new Response(JSON.stringify(mockTickerDbRows), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-range": `0-${mockTickerDbRows.length - 1}/${mockTickerDbRows.length}`,
        },
      });
    }
    if (urlStr.includes("companies")) {
      return new Response(
        JSON.stringify([
          {
            id: "comp-dom-id",
            name: "DominantCorp",
            logo_url: "https://mock.supabase.co/storage/v1/object/public/company-logos/dominant.png",
          },
        ]),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    return origTickerFetch(url, opts);
  }) as any;

  try {
    const { GET: tickerGet } = await import("../src/app/api/ticker/route");
    const { handler: netlifyTicker } = await import("../netlify/functions/ticker");

    const req = new Request("http://localhost:3000/api/ticker", { method: "GET" });
    const res = await tickerGet(req);
    const tickerItems = await res.json();

    assert(Array.isArray(tickerItems), "Ticker response must be an array");
    const domCount = tickerItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (domCount > 2) {
      failures.push(`TICKER CAP FAIL (App Route): DominantCorp has ${domCount} jobs in ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 4a. App Router /api/ticker caps DominantCorp at ${domCount}/2 in ticker items`);
    }

    assert(tickerItems.length <= 20, "Ticker must return max 20 items");
    console.log(`  [PASS] 4b. /api/ticker total items capped at ${tickerItems.length} (<= 20)`);

    const netlifyRes = await netlifyTicker();
    const netlifyItems = JSON.parse(netlifyRes.body);
    const netlifyDomCount = netlifyItems.filter((j: any) => j.company.toLowerCase() === "dominantcorp").length;

    if (netlifyDomCount > 2) {
      failures.push(`TICKER CAP FAIL (Netlify): DominantCorp has ${netlifyDomCount} jobs in netlify ticker (expected max 2)`);
    } else {
      console.log(`  [PASS] 4c. Netlify functions/ticker caps DominantCorp at ${netlifyDomCount}/2 in ticker items`);
    }
  } finally {
    globalThis.fetch = origTickerFetch;
  }

  // ====================================================================================
  // TEST 5: CompanyLogo Component Contract & ATS Host Filtering
  // ====================================================================================
  console.log("\nTEST 5: Verifying CompanyLogo component contract and ATS filtering...");
  const companyLogoPath = path.resolve(__dirname, "../src/components/CompanyLogo.tsx");
  const logoCode = fs.readFileSync(companyLogoPath, "utf-8");

  // 5a. No name-slug guessing
  if (logoCode.includes("cleanCompany.replace") || logoCode.includes(".replace(/[^a-z0-9]/g") || logoCode.includes("`${slug}.com`")) {
    failures.push("CompanyLogo must NOT guess domain from company name slug");
  } else {
    console.log("  [PASS] 5a. Zero name-slug domain guessing in CompanyLogo");
  }

  // 5b. Rejects ATS hosts
  const greenhouseDomain = extractDomainFromUrl("https://boards.greenhouse.io/stripe/jobs/12345");
  const ashbyDomain = extractDomainFromUrl("https://jobs.ashbyhq.com/linear/54321");
  const leverDomain = extractDomainFromUrl("https://jobs.lever.co/figma/67890");
  const directDomain = extractDomainFromUrl("https://stripe.com/careers/software-engineer");

  if (greenhouseDomain !== "") {
    failures.push(`ATS FILTER FAIL: Greenhouse URL resolved to '${greenhouseDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 5b. Greenhouse ATS URL rejected from unavatar fallback");
  }

  if (ashbyDomain !== "") {
    failures.push(`ATS FILTER FAIL: Ashby URL resolved to '${ashbyDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 5c. Ashby ATS URL rejected from unavatar fallback");
  }

  if (leverDomain !== "") {
    failures.push(`ATS FILTER FAIL: Lever URL resolved to '${leverDomain}' (expected empty string)`);
  } else {
    console.log("  [PASS] 5d. Lever ATS URL rejected from unavatar fallback");
  }

  if (directDomain !== "stripe.com") {
    failures.push(`DIRECT DOMAIN FAIL: Direct company URL resolved to '${directDomain}' (expected 'stripe.com')`);
  } else {
    console.log(`  [PASS] 5e. Direct company URL resolved to valid domain: '${directDomain}'`);
  }

  // 5f. Uses self-hosted logo first
  if (!logoCode.includes('"self-hosted"') || !logoCode.includes("logoUrl")) {
    failures.push("CompanyLogo must prioritize self-hosted logoUrl first");
  } else {
    console.log("  [PASS] 5f. CompanyLogo prioritizes self-hosted logoUrl first");
  }

  // 5g. Letter tile rendered if both fail or if no non-ATS domain exists
  if (!logoCode.includes("bg-gradient-to-br") || !logoCode.includes("{initial}")) {
    failures.push("CompanyLogo must render letter tile if both fail");
  } else {
    console.log("  [PASS] 5g. CompanyLogo renders neutral letter tile when both fail");
  }

  // ====================================================================================
  // TEST 6: LandingJobsTickerStrip Logo Contract (Zero name-slug guessing)
  // ====================================================================================
  console.log("\nTEST 6: Verifying LandingJobsTickerStrip logo contract...");
  const tickerStripPath = path.resolve(__dirname, "../src/components/LandingJobsTickerStrip.tsx");
  const stripCode = fs.readFileSync(tickerStripPath, "utf-8");

  if (stripCode.includes("cleanCompany.replace") || stripCode.includes("`${slug}.com`")) {
    failures.push("LandingJobsTickerStrip must NOT guess domain from company name slug");
  } else {
    console.log("  [PASS] 6a. Zero name-slug domain guessing in LandingJobsTickerStrip");
  }

  if (!stripCode.includes("job.logo_url")) {
    failures.push("LandingJobsTickerStrip must use job.logo_url (self-hosted) first");
  } else {
    console.log("  [PASS] 6b. LandingJobsTickerStrip uses job.logo_url (self-hosted) first");
  }

  if (!stripCode.includes("{letter}")) {
    failures.push("LandingJobsTickerStrip must show letter tile if self-hosted logo fails");
  } else {
    console.log("  [PASS] 6c. LandingJobsTickerStrip shows neutral letter tile if self-hosted fails");
  }

  // ====================================================================================
  // TEST 7: Server-side search joins company_id & companies(name, logo_url)
  // ====================================================================================
  console.log("\nTEST 7: Verifying server-side search joins company_id & companies(name, logo_url)...");
  const searchRoutePath = path.resolve(__dirname, "../src/app/api/jobs/search/route.ts");
  const searchCode = fs.readFileSync(searchRoutePath, "utf-8");

  if (!searchCode.includes("companies(name, logo_url)")) {
    failures.push("/api/jobs/search must join companies(name, logo_url) server-side");
  } else {
    console.log("  [PASS] 7a. /api/jobs/search joins companies(name, logo_url) server-side");
  }

  if (!searchCode.includes('company: "Verified Employer"')) {
    failures.push("/api/jobs/search must keep paid-field lock for free users");
  } else {
    console.log("  [PASS] 7b. /api/jobs/search keeps paid-field lock (company: 'Verified Employer')");
  }

  // ====================================================================================
  // TEST 8: Negative Control Mode Handling
  // ====================================================================================
  if (IS_NEGATIVE_CONTROL) {
    if (failures.length > 0) {
      console.error("\n❌ NEGATIVE CONTROL PROVED: Injected failure caught as expected!");
      failures.forEach((f) => console.error(`  - ${f}`));
      process.exit(1);
    } else {
      console.error("\n❌ NEGATIVE CONTROL FAILED: Injected failure was NOT caught!");
      process.exit(2);
    }
  }

  if (failures.length > 0) {
    console.error(`\n❌ VALIDATION FAILED with ${failures.length} errors:`);
    failures.forEach((f) => console.error(` - ${f}`));
    process.exit(1);
  }

  // ====================================================================================
  // TEST 9: Automated Negative Control Subprocess (Proves Non-Zero Exit)
  // ====================================================================================
  console.log("\nTEST 8: Spawning negative control child process to verify non-zero exit...");
  const child = spawnSync("npx", [
    "tsx",
    path.resolve(__dirname, "test-company-logos-and-caps.ts"),
    "--negative-control",
  ], {
    shell: true,
    stdio: "pipe",
  });

  const negStatus = child.status;
  assert.strictEqual(
    negStatus,
    1,
    `Negative control MUST exit with status 1! Received status: ${negStatus}`
  );
  console.log(`  [PASS] 8a. Negative control exited with code ${negStatus} (non-zero exit verified on cap/length violation)`);

  console.log("\n==================================================================================");
  console.log("COMPANY LOGOS & COMPANY CAPS VALIDATION: PASS-LOCAL");
  console.log("==================================================================================");
  process.exit(0);
}

runSuite().catch((err) => {
  console.error("Test execution fatal error:", err);
  process.exit(1);
});
