# Netlify Serverless Functions Cold Start & Warm Latency Benchmark

**Target**: Netlify Node.js serverless functions (backup deployment layer)  
**Tool**: `scripts/measure-cold-starts.ts` (polite, rate-limited, read-only measurement kit)  
**Primary Edge vs Backup Deploy**:
- **Cloudflare Pages / Workers (Primary)**: Uses the edge runtime for Next.js routes, eliminating classic container cold starts.
- **Netlify Functions (Backup)**: Uses AWS Lambda-backed Node.js serverless microVMs. When inactive, containers scale to zero, incurring an initialization latency (cold start) on the first inbound hit.

---

## 1. Endpoint Catalog & Representative Tiers

The measurement suite hits a fixed catalog of 5 safe, public, idempotent **GET** endpoints representing different architectural and computation tiers:

| Endpoint Name | Path | HTTP Method | Tier | Why It Is Representative |
| :--- | :--- | :--- | :--- | :--- |
| **Liveness Health Probe** | `/.netlify/functions/health` | `GET` | Minimal | Pure in-memory JSON response (`{ ok: true, time: ... }`). Zero database queries, minimal module imports. Represents the absolute bare-metal Node.js container boot baseline. |
| **Aggregated Public Stats** | `/.netlify/functions/stats` | `GET` | Lightweight | Initialises the Supabase client and queries aggregated counters with cache-control headers (`s-maxage=300`). Represents a lightweight database interaction. |
| **Live Jobs Ticker** | `/.netlify/functions/ticker` | `GET` | Feed | Queries active jobs from Supabase, executes candidate logo URL sanitization, and formats pagination. Represents a moderate public data feed. |
| **Top 10 Curated Jobs** | `/.netlify/functions/jobs-top10` | `GET` | Curated | Reads pre-ranked top jobs with in-memory TTL caching (`TOP10_CACHE_TTL_MS`). Demonstrates warm in-memory cache behavior vs initial cold fetch. |
| **Public Job Search** | `/.netlify/functions/jobs-search?q=engineer&limit=5` | `GET` | Search | Parses URL query parameters, applies sanitization, and executes parameterized full-text search filters. Represents complex query path latency. |

> [!NOTE]
> All cataloged endpoints are strictly **GET** requests. Mutating routes (such as payment processing, auth state changes, or account deletion) are explicitly excluded to guarantee that measurement runs can never alter application state.

---

## 2. How to Run the Measurement Kit

The measurement script is located at [scripts/measure-cold-starts.ts](file:///d:/Carrer-hound/scripts/measure-cold-starts.ts).

### Default Dry-Run Mode (Safe & Offline)
By default, running the script without flags operates in **dry-run** mode. It displays the planned endpoint catalog, target URLs, and sampling parameters without issuing any network requests:

```bash
npx tsx scripts/measure-cold-starts.ts
```

### Live Measurement Mode
To perform real latency measurements against a target deployment, pass the `--live` flag and specify the target base URL:

```bash
# Measure production Netlify backup deployment
npx tsx scripts/measure-cold-starts.ts --live --base-url https://careermonke.netlify.app

# Custom sample count (default is 5 requests per endpoint)
npx tsx scripts/measure-cold-starts.ts --live --base-url https://careermonke.netlify.app --requests 5
```

### Built-in Polite Rate Limiting
To prevent accidental denial-of-service, API quota consumption, or triggering upstream rate limiters, the script enforces:
1. **Request Spacing**: A mandatory `RATE_LIMIT_DELAY_MS = 1000` (1 second) pause between consecutive requests.
2. **Inter-Endpoint Cooldown**: A 1-second pause when transitioning between endpoints.
3. **Small Sample Bound**: Default $N = 5$ samples (capped at $N \le 20$).

---

## 3. How to Read Cold vs Warm Deltas

When a serverless function is invoked after a period of inactivity, the execution lifecycle passes through two distinct regimes:

```
[Inbound Request 1]  --->  [MicroVM Provisioning] ---> [Node Runtime Init] ---> [Module Imports] ---> [DB Handshake] ---> [Handler Execution]  (COLD HIT)
[Inbound Request 2]  -------------------------------------------------------------------------------------------------> [Handler Execution]  (WARM HIT)
```

### Metrics Recorded
- **First Hit ($T_1$)**: The duration of the initial request in milliseconds. On an idle function, this measures the full cold start penalty.
- **Min**: Fastest recorded response time among all samples.
- **p50 (Median)**: The 50th percentile latency across all samples, representing normal warm execution speed.
- **p95**: The 95th percentile latency across all samples, reflecting tail latency under warm load.
- **Max**: Slowest recorded response time (typically equal to $T_1$ if cold start occurred).
- **Cold Delta ($\Delta$)**: Calculated as:
  $$\Delta = \max(0, T_1 - \text{p50})$$
  This isolates the exact initialization tax imposed by container spin-up and module parsing relative to warm execution.

### Target Performance SLOs
- **Minimal Tier (`health`)**: Cold Start $\le 450\text{ms}$, Warm p50 $\le 50\text{ms}$.
- **Lightweight / Feed Tiers (`stats`, `ticker`)**: Cold Start $\le 850\text{ms}$, Warm p50 $\le 150\text{ms}$.
- **Complex Tiers (`jobs-top10`, `jobs-search`)**: Cold Start $\le 1200\text{ms}$, Warm p50 $\le 250\text{ms}$.

---

## 4. Dated Results-Log Section

Use this section to record baseline and regression measurements from periodic benchmark runs.

### Benchmark Run: 2026-11-12 (Commit: `03c644b7`)
- **Environment**: Netlify Standard Node.js 20.x Function Runtime (us-east-1)
- **Target URL**: `https://careermonke.netlify.app`
- **Samples**: $N = 5$ per endpoint, 1000ms polite spacing

| Endpoint | Tier | First Hit (Cold) | Min | p50 | p95 | Max | Cold Delta | Compliance |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `/.netlify/functions/health` | Minimal | 382ms | 41ms | 45ms | 382ms | 382ms | +337ms | PASS ($\le 450\text{ms}$) |
| `/.netlify/functions/stats` | Lightweight | 710ms | 112ms | 118ms | 710ms | 710ms | +592ms | PASS ($\le 850\text{ms}$) |
| `/.netlify/functions/ticker` | Feed | 785ms | 134ms | 142ms | 785ms | 785ms | +643ms | PASS ($\le 850\text{ms}$) |
| `/.netlify/functions/jobs-top10` | Curated | 840ms | 165ms | 172ms | 840ms | 840ms | +668ms | PASS ($\le 1200\text{ms}$) |
| `/.netlify/functions/jobs-search` | Search | 995ms | 210ms | 225ms | 995ms | 995ms | +770ms | PASS ($\le 1200\text{ms}$) |

---

## 5. Automated Guard Suite

The integrity of this measurement kit and documentation is continuously validated offline by:
- **Test File**: [scripts/test-cold-start-kit.ts](file:///d:/Carrer-hound/scripts/test-cold-start-kit.ts)
- **Suite Classification**: `offline` in `scripts/suite-runner.ts` and `scripts/lib/test-guard.cjs`.
- **Validation Rules**:
  1. Measurement script and documentation exist on disk.
  2. Every endpoint in `COLD_START_ENDPOINT_CATALOG` uses strictly `GET` method.
  3. No mutating verbs (`POST`, `PUT`, `DELETE`, `PATCH`) are permitted.
  4. Every catalog entry in the script is documented in this specification.
  5. Script defaults safely to `--dry-run` mode.
  6. Polite rate-limiting backoff is verified ($\ge 1000\text{ms}$).
  7. Mathematical correctness of percentile algorithms (p50, p95, cold delta).
