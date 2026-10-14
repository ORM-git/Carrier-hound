/**
 * CareerMonke Read-Only Apply Links Checker
 * Run with: npx tsx scripts/check-apply-links.ts
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log("NOT RUN: Supabase URL or Key not configured in environment.");
  process.exit(0);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY);

interface CheckResult {
  id: string;
  title: string;
  company: string;
  url: string;
  status: number | null;
  category: "2xx" | "3xx_final_2xx" | "4xx" | "5xx" | "timeout" | "error";
  durationMs: number;
  error?: string;
  redirected?: boolean;
}

// Concurrency control: max 5 parallel
const MAX_CONCURRENCY = 5;
// 1s delay per host
const hostLastRequestMap = new Map<string, number>();

async function throttleHost(urlStr: string): Promise<void> {
  try {
    const parsed = new URL(urlStr);
    const host = parsed.hostname;
    const now = Date.now();
    const last = hostLastRequestMap.get(host) || 0;
    const elapsed = now - last;
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }
    hostLastRequestMap.set(host, Date.now());
  } catch (_) {}
}

async function checkUrl(job: { id: string; title: string; company: string; apply_url: string }): Promise<CheckResult> {
  const url = job.apply_url;
  const startTime = Date.now();

  await throttleHost(url);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    // 1. Try HEAD request
    let resp: Response;
    let redirected = false;

    try {
      resp = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      redirected = resp.redirected;
    } catch (err: any) {
      if (err.name === "AbortError") {
        clearTimeout(timeoutId);
        return {
          id: job.id,
          title: job.title,
          company: job.company,
          url,
          status: null,
          category: "timeout",
          durationMs: Date.now() - startTime,
          error: "Request timed out after 10000ms",
        };
      }
      throw err;
    }

    // 2. Fallback to GET on 405 Method Not Allowed or 400 Bad Request
    if (resp.status === 405 || resp.status === 400) {
      const getController = new AbortController();
      const getTimeout = setTimeout(() => getController.abort(), 10000);
      try {
        resp = await fetch(url, {
          method: "GET",
          redirect: "follow",
          signal: getController.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          },
        });
        redirected = resp.redirected;
      } finally {
        clearTimeout(getTimeout);
      }
    }

    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    const status = resp.status;

    if (status >= 200 && status < 300) {
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        url,
        status,
        category: redirected ? "3xx_final_2xx" : "2xx",
        durationMs,
        redirected,
      };
    } else if (status >= 400 && status < 500) {
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        url,
        status,
        category: "4xx",
        durationMs,
      };
    } else if (status >= 500) {
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        url,
        status,
        category: "5xx",
        durationMs,
      };
    } else {
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        url,
        status,
        category: "error",
        durationMs,
      };
    }
  } catch (err: any) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;
    if (err.name === "AbortError") {
      return {
        id: job.id,
        title: job.title,
        company: job.company,
        url,
        status: null,
        category: "timeout",
        durationMs,
        error: "Request timed out after 10000ms",
      };
    }
    return {
      id: job.id,
      title: job.title,
      company: job.company,
      url,
      status: null,
      category: "error",
      durationMs,
      error: err.message || String(err),
    };
  }
}

async function runPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const curIndex = index++;
      results[curIndex] = await fn(items[curIndex]);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function main() {
  console.log("===============================================================");
  console.log("        CAREERMONKE READ-ONLY APPLY URL LINK CHECKER          ");
  console.log("===============================================================\n");

  const seed = Date.now();
  console.log(`Sample Seed: ${seed}`);
  console.log("Querying 100 random active job listings (SELECT-only)...");

  // Query 100 active jobs with non-null apply_url
  const { data: jobs, error } = await client
    .from("jobs")
    .select("id, title, company, apply_url")
    .eq("status", "active")
    .not("apply_url", "is", null)
    .limit(100);

  if (error || !jobs || jobs.length === 0) {
    console.error(`Failed to fetch jobs from database: ${error?.message || "No jobs returned"}`);
    process.exit(1);
  }

  console.log(`Fetched ${jobs.length} jobs. Testing links with max 5 parallel & 10s timeout...\n`);

  const results = await runPool(jobs, MAX_CONCURRENCY, checkUrl);

  const counts = {
    "2xx": 0,
    "3xx_final_2xx": 0,
    "4xx": 0,
    "5xx": 0,
    timeout: 0,
    error: 0,
  };

  const failing: CheckResult[] = [];

  for (const r of results) {
    counts[r.category]++;
    if (r.category !== "2xx" && r.category !== "3xx_final_2xx") {
      failing.push(r);
    }
  }

  const successfulCount = counts["2xx"] + counts["3xx_final_2xx"];
  const totalChecked = results.length;
  const percentOk = ((successfulCount / totalChecked) * 100).toFixed(1);

  console.log("===============================================================");
  console.log("                     STATUS COUNTS SUMMARY                     ");
  console.log("===============================================================");
  console.log(`2xx Direct OK:        ${counts["2xx"]}`);
  console.log(`3xx -> Final 2xx OK:  ${counts["3xx_final_2xx"]}`);
  console.log(`4xx Client Error:     ${counts["4xx"]}`);
  console.log(`5xx Server Error:     ${counts["5xx"]}`);
  console.log(`Timeout (>=10s):      ${counts.timeout}`);
  console.log(`Other Network Errors: ${counts.error}`);
  console.log(`Total Checked:        ${totalChecked}`);
  console.log(`Percent OK:           ${percentOk}% (${successfulCount}/${totalChecked})`);
  console.log("===============================================================\n");

  if (failing.length > 0) {
    console.log("---------------------------------------------------------------");
    console.log(`FAILING URLS (${failing.length}):`);
    console.log("---------------------------------------------------------------");
    failing.forEach((f, i) => {
      console.log(`[${i + 1}] Status: ${f.status || f.category} | ${f.company} - ${f.title}`);
      console.log(`    URL: ${f.url}`);
      if (f.error) console.log(`    Error: ${f.error}`);
    });
    console.log("---------------------------------------------------------------\n");
  } else {
    console.log("All sampled URLs returned healthy 2xx responses!\n");
  }

  console.log("Execution finished without any database modifications (SELECT-only).");
}

main().catch((err) => {
  console.error("Fatal error during apply links check:", err);
  process.exit(1);
});
