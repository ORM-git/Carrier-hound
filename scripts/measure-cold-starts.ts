/**
 * scripts/measure-cold-starts.ts
 *
 * READ-ONLY measurement script auditing Netlify Node function cold and warm latencies.
 * Measures min/p50/p95/max response times across a fixed catalog of safe, idempotent GET endpoints.
 *
 * Default mode is --dry-run (prints planned requests without executing network calls).
 * Live mode (--live) politely rate-limits requests to ~1 request/second with small N.
 *
 * Usage:
 *   npx tsx scripts/measure-cold-starts.ts                      # Dry-run default
 *   npx tsx scripts/measure-cold-starts.ts --dry-run            # Explicit dry-run
 *   npx tsx scripts/measure-cold-starts.ts --live               # Live measurement against default base URL
 *   npx tsx scripts/measure-cold-starts.ts --live --base-url https://careermonke.netlify.app --requests 5
 */

import * as http from "http";
import * as https from "https";
import { URL } from "url";

// =============================================================================
// Catalog & Configuration
// =============================================================================

export interface EndpointCatalogEntry {
  name: string;
  path: string;
  method: "GET";
  tier: "minimal" | "lightweight" | "feed" | "curated" | "search";
  description: string;
}

/**
 * Fixed catalog of public, read-only, safe, idempotent GET Netlify function endpoints.
 * Strictly GET only; zero mutating routes.
 */
export const COLD_START_ENDPOINT_CATALOG: EndpointCatalogEntry[] = [
  {
    name: "Liveness Health Probe",
    path: "/.netlify/functions/health",
    method: "GET",
    tier: "minimal",
    description: "Pure in-memory liveness probe baseline (zero DB queries, minimal imports)",
  },
  {
    name: "Aggregated Public Stats",
    path: "/.netlify/functions/stats",
    method: "GET",
    tier: "lightweight",
    description: "Cached statistics endpoint (Supabase client init + light aggregation query)",
  },
  {
    name: "Live Jobs Ticker",
    path: "/.netlify/functions/ticker",
    method: "GET",
    tier: "feed",
    description: "Public job ticker feed (database select + logo URL sanitization)",
  },
  {
    name: "Top 10 Curated Jobs",
    path: "/.netlify/functions/jobs-top10",
    method: "GET",
    tier: "curated",
    description: "Ranked jobs listing (multi-field ordering + in-memory cache layer)",
  },
  {
    name: "Public Job Search",
    path: "/.netlify/functions/jobs-search?q=engineer&limit=5",
    method: "GET",
    tier: "search",
    description: "Parameterized query parsing + full-text job search query execution",
  },
];

export const DEFAULT_BASE_URL = "https://careermonke.netlify.app";
export const DEFAULT_REQUESTS_PER_ENDPOINT = 5;
export const RATE_LIMIT_DELAY_MS = 1000; // ~1 request per second to prevent hammering

// =============================================================================
// Percentile & Math Utilities
// =============================================================================

export interface LatencyStats {
  min: number;
  p50: number;
  p95: number;
  max: number;
  firstHit: number;
  warmAvg: number;
  coldDelta: number;
  sampleCount: number;
}

/**
 * Computes min, p50, p95, max, first hit, warm average, and cold delta from an array of latencies (ms).
 */
export function calculateLatencyStats(latencies: number[]): LatencyStats {
  if (latencies.length === 0) {
    return {
      min: 0,
      p50: 0,
      p95: 0,
      max: 0,
      firstHit: 0,
      warmAvg: 0,
      coldDelta: 0,
      sampleCount: 0,
    };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];

  // Nearest-rank percentile helper
  const getPercentile = (pct: number): number => {
    const index = Math.ceil((pct / 100) * sorted.length) - 1;
    return sorted[Math.max(0, Math.min(index, sorted.length - 1))];
  };

  const p50 = getPercentile(50);
  const p95 = getPercentile(95);

  const firstHit = latencies[0];
  const warmSamples = latencies.slice(1);
  const warmAvg =
    warmSamples.length > 0
      ? Math.round(warmSamples.reduce((sum, v) => sum + v, 0) / warmSamples.length)
      : firstHit;

  const coldDelta = Math.max(0, firstHit - p50);

  return {
    min,
    p50,
    p95,
    max,
    firstHit,
    warmAvg,
    coldDelta,
    sampleCount: latencies.length,
  };
}

// =============================================================================
// CLI Argument Parsing
// =============================================================================

export interface CliOptions {
  baseUrl: string;
  requestsPerEndpoint: number;
  dryRun: boolean;
}

export function parseCliArgs(argv: string[]): CliOptions {
  let baseUrl = DEFAULT_BASE_URL;
  let requestsPerEndpoint = DEFAULT_REQUESTS_PER_ENDPOINT;

  // Defaults to dry-run unless --live is explicitly specified
  const isLive = argv.includes("--live");
  const isExplicitDryRun = argv.includes("--dry-run");
  const dryRun = !isLive || isExplicitDryRun;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--base-url" && argv[i + 1]) {
      baseUrl = argv[i + 1].trim();
      i++;
    } else if (arg.startsWith("--base-url=")) {
      baseUrl = arg.split("=")[1].trim();
    } else if (arg === "--requests" && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1], 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 20) {
        requestsPerEndpoint = parsed;
      }
      i++;
    } else if (arg.startsWith("--requests=")) {
      const parsed = parseInt(arg.split("=")[1], 10);
      if (!isNaN(parsed) && parsed > 0 && parsed <= 20) {
        requestsPerEndpoint = parsed;
      }
    }
  }

  // Ensure baseUrl does not end with trailing slash
  baseUrl = baseUrl.replace(/\/+$/, "");

  return {
    baseUrl,
    requestsPerEndpoint,
    dryRun,
  };
}

// =============================================================================
// Measurement Engine
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timedGetRequest(targetUrl: string): Promise<{ status: number; durationMs: number }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(targetUrl);
    const client = urlObj.protocol === "https:" ? https : http;
    const start = process.hrtime.bigint();

    const req = client.get(
      targetUrl,
      {
        headers: {
          "User-Agent": "CareerMonke-ColdStartMeasurer/1.0 (Polite-Perf-Audit)",
          Accept: "application/json, text/plain, */*",
        },
        timeout: 15000,
      },
      (res) => {
        // Drain response body
        res.on("data", () => {});
        res.on("end", () => {
          const end = process.hrtime.bigint();
          const durationMs = Math.round(Number(end - start) / 1_000_000);
          resolve({
            status: res.statusCode || 0,
            durationMs,
          });
        });
      }
    );

    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Request timed out after 15000ms: ${targetUrl}`));
    });
  });
}

export async function runColdStartMeasurement(
  options: CliOptions
): Promise<Map<string, LatencyStats>> {
  const results = new Map<string, LatencyStats>();

  console.log("================================================================================");
  console.log("          NETLIFY FUNCTIONS COLD START & WARM LATENCY MEASURER                  ");
  console.log("================================================================================");
  console.log(`Target Base URL:       ${options.baseUrl}`);
  console.log(`Endpoints Catalog:     ${COLD_START_ENDPOINT_CATALOG.length} safe GET endpoints`);
  console.log(`Requests Per Endpoint: ${options.requestsPerEndpoint}`);
  console.log(`Rate-Limit Backoff:    ${RATE_LIMIT_DELAY_MS}ms per request (~1 req/sec)`);
  console.log(`Execution Mode:        ${options.dryRun ? "DRY-RUN (No network calls made)" : "LIVE EXECUTION"}`);
  console.log("================================================================================\n");

  if (options.dryRun) {
    console.log("[DRY-RUN] Planned endpoint measurements:");
    for (const entry of COLD_START_ENDPOINT_CATALOG) {
      const fullUrl = `${options.baseUrl}${entry.path}`;
      console.log(`  - [${entry.tier.toUpperCase()}] ${entry.name}`);
      console.log(`    Method:    ${entry.method}`);
      console.log(`    URL:       ${fullUrl}`);
      console.log(`    Purpose:   ${entry.description}`);
      console.log(`    Sampling:  ${options.requestsPerEndpoint} requests with ${RATE_LIMIT_DELAY_MS}ms rate-limit spacing`);
      console.log("");
    }
    console.log("[DRY-RUN] To execute real measurements, pass the --live flag:");
    console.log(`  npx tsx scripts/measure-cold-starts.ts --live --base-url ${options.baseUrl}\n`);
    return results;
  }

  // Live execution mode
  for (const entry of COLD_START_ENDPOINT_CATALOG) {
    const fullUrl = `${options.baseUrl}${entry.path}`;
    console.log(`Measuring [${entry.tier.toUpperCase()}] ${entry.name} (${fullUrl})...`);

    const samples: number[] = [];
    for (let reqIdx = 1; reqIdx <= options.requestsPerEndpoint; reqIdx++) {
      try {
        const { status, durationMs } = await timedGetRequest(fullUrl);
        samples.push(durationMs);
        const tag = reqIdx === 1 ? "(Cold Candidate)" : `(Warm Sample #${reqIdx})`;
        console.log(`  Hit ${reqIdx}/${options.requestsPerEndpoint}: HTTP ${status} in ${durationMs}ms ${tag}`);
      } catch (err: any) {
        console.warn(`  Hit ${reqIdx}/${options.requestsPerEndpoint} failed: ${err.message}`);
      }

      // Polite rate-limiting between consecutive requests
      if (reqIdx < options.requestsPerEndpoint) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }
    }

    const stats = calculateLatencyStats(samples);
    results.set(entry.name, stats);

    console.log(`  => Stats: First: ${stats.firstHit}ms | Min: ${stats.min}ms | p50: ${stats.p50}ms | p95: ${stats.p95}ms | Max: ${stats.max}ms | Cold Delta: +${stats.coldDelta}ms\n`);

    // Inter-endpoint pause
    await sleep(RATE_LIMIT_DELAY_MS);
  }

  // Summary Table
  console.log("================================================================================");
  console.log("                          MEASUREMENT RESULTS SUMMARY                           ");
  console.log("================================================================================");
  console.log(
    "Endpoint".padEnd(25) +
      "Cold(1st)".padStart(12) +
      "Min".padStart(10) +
      "p50".padStart(10) +
      "p95".padStart(10) +
      "Max".padStart(10) +
      "Cold Delta".padStart(14)
  );
  console.log("-".repeat(91));

  for (const [name, s] of results.entries()) {
    console.log(
      name.slice(0, 24).padEnd(25) +
        `${s.firstHit}ms`.padStart(12) +
        `${s.min}ms`.padStart(10) +
        `${s.p50}ms`.padStart(10) +
        `${s.p95}ms`.padStart(10) +
        `${s.max}ms`.padStart(10) +
        `+${s.coldDelta}ms`.padStart(14)
    );
  }
  console.log("================================================================================\n");

  return results;
}

// Auto-run when executed directly from CLI
if (require.main === module || (process.argv[1] && process.argv[1].endsWith("measure-cold-starts.ts"))) {
  const options = parseCliArgs(process.argv.slice(2));
  runColdStartMeasurement(options).catch((err) => {
    console.error("Measurement error:", err);
    process.exit(1);
  });
}
