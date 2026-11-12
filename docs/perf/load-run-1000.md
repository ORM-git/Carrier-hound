# CareerMonke 1000-User (`FULL=1`) Load Run Runbook

## Overview

This document specifies the exact procedure, environmental preconditions, execution commands, observation metrics, and abort criteria for executing the **1,000 concurrent user (`FULL=1`)** read-only load test against CareerMonke using `k6`.

While the 200-user default profile (`scripts/loadtest/cm-load.js`) was successfully executed with 24,198 requests and 0 errors, the 1,000-user peak test (`FULL=1`) verifies launch-day concurrency and infrastructure headroom under multi-stage stress.

> [!IMPORTANT]
> **Owner Execution Rule**: Load runs generate synthetic edge traffic and real database queries. Only the project owner or designated infrastructure lead may trigger the 1,000-user run. Automated CI and non-owner workers must NOT execute the live benchmark.

---

## 1. Preconditions

### A. Environment Selection (Staging vs. Production)
**Decision**: Environment selection is explicitly the **owner's decision**.

| Environment | Target URL | Benefits | Risks / Considerations |
|-------------|------------|----------|------------------------|
| **Production** | `https://carrier-hound.pages.dev` | Validates live Cloudflare Pages edge network, production CDN cache hit ratios, and real Supabase connection pool behavior. | Potential synthetic load impact on real users; risk of Cloudflare WAF or anti-bot challenge triggers; database IOPS consumption. Must run in an off-peak maintenance window. |
| **Staging / Preview** | `https://<preview>.carrier-hound.pages.dev` | Full isolation from end users; safe failure domain. | Must verify staging replica database instance matches production compute tier and transaction pooler configuration to produce actionable capacity signals. |

### B. Supabase Connection Limits to Watch
During the 1,000-user run, observe the Supabase Dashboard (**Database → Metrics & Connection Pooling**):
1. **Transaction Pooler (Port 6543)**: Verify application queries route through the Supabase transaction pooler (Supavisor). Direct connection strings (port 5432) will exhaust PostgreSQL client limits almost immediately under 1,000 concurrent VUs.
2. **Connection Utilization Ceiling**:
   - Free / Micro Tier: max ~60 pooler connections.
   - Small / Pro Tier: max 200–500 pooler connections.
   - **Ceiling**: If active database connections reach **≥ 80%** of the provisioned pooler ceiling, the run must be aborted to prevent cascading query stalls.
3. **Database Compute & Disk Health**:
   - Host CPU utilization sustained **> 80%** for > 60 seconds requires termination.
   - Disk IOPS burst balance must remain above 20%.

### C. k6 Thresholds & Defensive Safeguards
`scripts/loadtest/cm-load.js` enforces the following thresholds with automatic termination (`abortOnFail: true`, evaluated after 30s warm-up):
- **Global Error Rate**: `http_req_failed` must be `< 2%` (`rate<0.02`).
- **Global Latency**: Overall `http_req_duration` `p(95) < 3000ms`, `p(99) < 5000ms`.
- **Zero Rate Limiting**: `rate_limit_hits < 1` (any `HTTP 429` triggers immediate abort).
- **Zero Cloudflare Challenges**: `cf_challenge_hits < 1` (any CF interstitial challenge triggers immediate abort).
- **Per-Endpoint Latency Ceilings**: Specific `p95` and `p99` thresholds for each of the 5 benchmarked endpoints (detailed in the Abort Checklist).
- **Request Volume Caps**: Hard bounds within the script cap `/api/stats` at ≤ 20,000 calls and jobs queries at ≤ 12,000 calls across the entire test session.

---

## 2. Stage Profile (Concurrency Ramps)

The `FULL=1` execution activates `fullStages` in `scripts/loadtest/cm-load.js`, consisting of 4 progressive ramp-up tiers followed by a graceful cooldown (total duration: ~8 minutes 30 seconds):

```
VUs
1000 |                          /--------------------\
     |                         /                      \
 500 |                  /-----/                        \
     |                 /                                \
 200 |          /-----/                                  \
     |         /                                          \
  50 |  /-----/                                            \
   0 +--+-----+-------+-------+----------------------+-----+--> Time
       0m    2m      4m      6m                     8m    8m30s
```

| Stage | Duration | Target VUs | Purpose |
|-------|----------|------------|---------|
| 1     | 2m       | 50 VUs     | Warm-up and edge cache priming |
| 2     | 2m       | 200 VUs    | Re-confirm 200-user baseline stability |
| 3     | 2m       | 500 VUs    | Medium-load ramp and connection pool scaling |
| 4     | 2m       | 1000 VUs   | Launch-day peak stress capacity proof |
| 5     | 30s      | 0 VUs      | Graceful ramp-down and connection teardown |

---

## 3. Exact Execution Commands

Ensure `k6` is installed (`winget install GrafanaLabs.k6` on Windows, `brew install k6` on macOS).

### Linux / macOS (Bash)
```bash
# Production target
FULL=1 k6 run scripts/loadtest/cm-load.js

# Custom staging / preview target (owner decision)
FULL=1 BASE_URL="https://preview.carrier-hound.pages.dev" k6 run scripts/loadtest/cm-load.js
```

### Windows (PowerShell)
```powershell
# Production target
$env:FULL="1"; k6 run scripts/loadtest/cm-load.js; Remove-Item env:FULL

# Custom staging / preview target (owner decision)
$env:FULL="1"; $env:BASE_URL="https://preview.carrier-hound.pages.dev"; k6 run scripts/loadtest/cm-load.js; Remove-Item env:FULL; Remove-Item env:BASE_URL
```

### Containerized Execution (Docker)
```bash
docker run --rm -i -v $(pwd):/app -w /app -e FULL=1 grafana/k6 run scripts/loadtest/cm-load.js
```

---

## 4. What to Capture

Upon run completion, collect the following metrics from the generated reports:

| Metric Category | Target Value / Threshold | Description |
|-----------------|--------------------------|-------------|
| **Throughput (RPS)** | Capture peak & average RPS | Total HTTP requests completed divided by duration (`http_reqs` rate). |
| **Overall Latency** | `p50`, `p90`, `p95 < 3000ms`, `p99 < 5000ms` | End-to-end HTTP request duration percentiles. |
| **Per-Endpoint Latency** | `p50`, `p95`, `p99` per route | Captured for `/`, `/jobs`, `/api/stats`, `/jobs?category=engineering`, `/jobs?q=engineer`. |
| **Error Rate** | `< 2.0%` overall, `0%` 429 / CF challenge | `http_req_failed` percentage, HTTP 429 counter, and Cloudflare challenge counter. |
| **Test Duration** | ~8m 30s (or exact abort timestamp) | Full duration of test run. |

### Artifact Output Locations
The k6 execution automatically outputs:
1. **Console summary table**: Rendered directly in terminal stdout.
2. **Latest summary file**: `scripts/loadtest/summary.txt` (overwritten per run).
3. **Dated historical report**: `reports/loadtest/load-run-<ISO_TIMESTAMP>.txt` (permanent record under git tracking).

---

## 5. Abort Checklist

Stop the test run immediately (via Ctrl+C or automated k6 abort threshold) if any of the following conditions occur:

```
[ ] Error Rate Ceilings:
    [ ] Any HTTP 429 Rate Limit hit (rate_limit_hits >= 1) -> Immediate abort.
    [ ] Any Cloudflare Challenge / Captcha triggered (cf_challenge_hits >= 1) -> Immediate abort.
    [ ] Overall request failure rate >= 2% (http_req_failed >= 0.02) -> Automated k6 abort.
    [ ] Sustained 5xx server errors (> 1% of total requests over 30s) -> Immediate abort.

[ ] Latency Ceilings:
    [ ] Overall p95 >= 3,000ms or p99 >= 5,000ms -> Automated k6 abort.
    [ ] GET / (home static shell): p95 >= 2,000ms or p99 >= 4,000ms -> Automated k6 abort.
    [ ] GET /jobs (jobs shell): p95 >= 2,500ms or p99 >= 4,500ms -> Automated k6 abort.
    [ ] GET /api/stats (edge stats): p95 >= 2,000ms or p99 >= 3,500ms -> Automated k6 abort.
    [ ] GET /jobs?category=engineering: p95 >= 3,000ms or p99 >= 5,000ms -> Automated k6 abort.
    [ ] GET /jobs?q=engineer: p95 >= 3,500ms or p99 >= 5,500ms -> Automated k6 abort.

[ ] Infrastructure Ceilings:
    [ ] Supabase connection pool utilization >= 80% of max pool size.
    [ ] Supabase database host CPU >= 80% for > 60 consecutive seconds.
    [ ] Disk IOPS depleted or storage throttling reported in Supabase dashboard.
```

---

## 6. Offline Verification

A standalone verification script verifies the presence of the 1,000-user stages profile, per-endpoint thresholds, dated export wiring, and required documentation sections:

```bash
node scripts/check-load-run-kit.cjs
```
