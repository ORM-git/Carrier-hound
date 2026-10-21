# CareerMonke Read-Only Production Load Test

A production-safe, read-only k6 benchmark suite for CareerMonke (`https://carrier-hound.pages.dev`).

## ⚠️ Important Safety Rules
- **READ-ONLY**: Exclusively executes public `GET` requests against guest endpoints.
- **NO Credentials / Secrets**: Does not use Supabase service keys, auth tokens, admin credentials, or private headers.
- **Defensive Safeguards**:
  - Automatically aborts immediately upon encountering `HTTP 429` (Rate Limited).
  - Automatically aborts immediately upon encountering Cloudflare anti-bot challenges (`403`/`503` with CF Ray/challenge signatures).
  - Global request caps to prevent resource exhaustion:
    - `/api/stats` capped at ≤ 20,000 requests.
    - Jobs listing & search group capped at ≤ 12,000 requests.
- **Rate Limit Code Untouched**: Does not alter site rate limiting or inject bypass headers.

---

## 🛠️ Prerequisites & Installation

### macOS (Homebrew)
```bash
brew install k6
```

### Windows (Winget or Chocolatey)
```powershell
winget install GrafanaLabs.k6
# or
choco install k6
```

### Linux (Debian / Ubuntu)
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### Docker
```bash
docker run --rm -i -v $(pwd):/app -w /app grafana/k6 run scripts/loadtest/cm-load.js
```

---

## 📊 Usage Guidelines & Supabase Quota Notice

> [!IMPORTANT]
> **Check Supabase Usage Before and After Every Run**
> Because this test measures real production responses (including edge stats and jobs data), monitor your Supabase project dashboard (**Database > Storage & Egress / Disk IO / Connection Pooling**) before starting and after finishing the test to verify capacity and quota health.

---

## 🚀 Running the Tests

### 1. Default Run (50 → 200 VUs, ~4m 30s)
Runs standard production verification:
- 50 VUs for 2 minutes
- 200 VUs for 2 minutes
- Ramp down over 30 seconds

```bash
k6 run scripts/loadtest/cm-load.js
```

### 2. Full Peak Stress Run (50 → 200 → 500 → 1000 VUs, ~8m 30s)
*Only execute after reviewing results from the default run.*
- 50 VUs for 2 minutes
- 200 VUs for 2 minutes
- 500 VUs for 2 minutes
- 1000 VUs for 2 minutes
- Ramp down over 30 seconds

```bash
FULL=1 k6 run scripts/loadtest/cm-load.js
# On Windows PowerShell:
$env:FULL="1"; k6 run scripts/loadtest/cm-load.js; Remove-Item env:FULL
```

### Custom Target Base URL
To target a custom staging or preview URL:
```bash
BASE_URL="https://preview.carrier-hound.pages.dev" k6 run scripts/loadtest/cm-load.js
```

---

## 📈 Outputs & Metrics
After completion, a summary is rendered to the terminal and written to `scripts/loadtest/summary.txt`, containing:
- Total requests and overall failure rate.
- Overall and per-endpoint latency percentiles (`p50`, `p90`, `p95`, `p99`).
- Verification that `HTTP 429` and Cloudflare challenges remained at zero.
