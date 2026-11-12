# CareerMonke Fleet Daily Ingestion Capacity Projection

**Audit Run Date**: 2026-11-12 09:43:06 UTC  
**Script Version**: `2.0.0`  
**Scope Type**: `full_fleet` (complete fleet enumeration (438 enabled boards))  
**Fleet Coverage**: 438 / 438 enabled boards (100% coverage | 438 succeeded, 0 failed)  
**Provenance Artifact**: `reports/daily-capacity-provenance.json`  
**Provenance SHA-256**: `4cb4f593e6e51d54ca1567b00b9bb51d03f5684380057d90e2a2023fa8082767`  
**Invocation Command**: `npx tsx scripts/project-daily-capacity.ts --live --delay 100`  

---

## 1. Executive Summary & Verdict

**Verdict**: NEW-JOBS TARGET: NOT ESTABLISHED — Open-job public ATS snapshots cannot prove delivered/deduplicated ingestion per day vs the 1,200/day goal (live proof comes from PR #557's immutable `first_seen_at` DB report).

- **Date-able NEW Jobs Supply (trailing 24h, genuine first-post dates only)**: ~421 / day (observed in sample: 421)
- **Recent Activity / Updates (trailing 24h, Greenhouse `updated_at` edit churn — NEVER added to NEW jobs)**: ~1,514 / day (observed in sample: 1,514)
- **Target Daily NEW Jobs Goal**: 1,200 / day (First-Seen DB Evidence Present: **NO**)

| Metric | Estimate / Value | Notes |
| :--- | :--- | :--- |
| **Target Status** | **NOT_ESTABLISHED** | Public ATS snapshots cannot verify deduplicated DB ingestion (see PR #557) |
| **Date-able NEW Jobs (Trailing 24h)** | **~421 / day** | Counts ONLY genuine first-post dates (`first_published`, `publishedAt`, `createdAt`) |
| **Recent Activity / Updates (Trailing 24h)** | **~1,514 / day** | Counts Greenhouse `updated_at` edit/refresh events separately; never counted as new |
| **Estimated Fleet Open Inventory** | **~26,459** | Active public job listings across measured boards |
| **Failed Boards** | **0** | HTTP errors / timeouts excluded from successful denominator |

> [!IMPORTANT]
> **Why Open-Job Snapshots Cannot Prove Target Attainment**:
> 1. **No Delivery / Deduplication Proof**: Polling open ATS snapshots measures *upstream posting hints*, not *delivered, deduplicated DB inserts*. Live proof of delivered daily NEW jobs comes strictly from PR #557's immutable `first_seen_at` database report.
> 2. **Strict Separation of Edit Churn (`updated_at`)**: Greenhouse `updated_at` fires on routine requisition edits, recruiter changes, or description tweaks. It is tracked strictly as **recent activity** and NEVER included in NEW-jobs supply. Only genuine first-post fields (`first_published` / `created_at` on Greenhouse, `publishedAt` on Ashby, `createdAt` on Lever) feed NEW-jobs supply.
> 3. **Extrapolation Assumptions**: When a subset of boards is sampled (`--limit`) or individual boards fail, extrapolation assumes failed/unsampled boards have the same mean posting rate as successful sampled boards within that ATS platform. Unmeasured ATS platforms under `--ats` are strictly reported as **UNKNOWN**.

---

## 2. Per-ATS Platform Breakdown

| ATS Platform | Measured? | Fleet Boards | Sampled Boards | Failed Boards | Boards w/ Zero Date-able NEW | Open Jobs Sampled | Date-able NEW (24h, First-Post) | Recent Activity (24h, `updated_at`) | Extrapolated Daily NEW Supply |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Greenhouse** | YES | 227 | 227 | 0 | 0 | 17,730 | 308 | 1,514 | **~308** |
| **Ashby** | YES | 170 | 170 | 0 | 0 | 7,513 | 106 | N/A | **~106** |
| **Lever** | YES | 41 | 41 | 0 | 0 | 1,216 | 7 | N/A | **~7** |
| **Fleet Aggregate** | FULL | **438** | **438** | **0** | **0** | **26,459** | **421** | **1,514** | **~421** |

---

## 3. Top Contributing Boards (Date-able NEW First-Posts in Trailing 24h)

| Company Name | ATS | Target | Open Jobs | Date-able NEW (24h) | Recent Activity `updated_at` (24h) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Celonis | `greenhouse` | `celonis` | 262 | **22** | 63 |
| Elastic | `greenhouse` | `elastic` | 421 | **21** | 41 |
| Toast | `greenhouse` | `toast` | 352 | **21** | 36 |
| Stripe | `greenhouse` | `stripe` | 787 | **17** | 41 |
| Cloudflare | `greenhouse` | `cloudflare` | 483 | **14** | 28 |
| HelloFresh | `greenhouse` | `hellofresh` | 372 | **13** | 372 |
| Riot Games | `greenhouse` | `riotgames` | 200 | **13** | 20 |
| Airbnb | `greenhouse` | `airbnb` | 207 | **12** | 19 |
| Snowflake | `ashby` | `snowflake` | 381 | **11** | N/A |
| Lightmatter | `greenhouse` | `lightmatter` | 65 | **10** | 12 |
| Zscaler | `greenhouse` | `zscaler` | 375 | **10** | 21 |
| Harvey | `ashby` | `harvey` | 380 | **8** | N/A |
| MongoDB | `greenhouse` | `mongodb` | 379 | **8** | 14 |
| Oscar Health | `greenhouse` | `oscar` | 184 | **8** | 14 |
| OpenAI | `ashby` | `openai` | 822 | **7** | N/A |
| Adyen | `greenhouse` | `adyen` | 254 | **7** | 22 |
| Nubank | `ashby` | `nubank` | 108 | **6** | N/A |
| Datadog | `greenhouse` | `datadog` | 391 | **6** | 11 |
| Samsara | `greenhouse` | `samsara` | 314 | **6** | 29 |
| Kong | `ashby` | `kong` | 118 | **5** | N/A |

---

## 4. Flagged Boards with Zero Date-able NEW Jobs (0 boards)

Boards returning 0 jobs with genuine first-post dates (`first_published` / `publishedAt` / `createdAt`):

| Company Name | ATS | Target | Total Open Jobs | Recent Activity `updated_at` (24h) | Flag Reason |
| :--- | :--- | :--- | :--- | :--- | :--- |
| _None_ | — | — | — | — | All successful boards exposed genuine first-post dates |


---

## 5. Boards with Fetch Errors (0 boards)

| Company Name | ATS | Target | Error Message |
| :--- | :--- | :--- | :--- |
| _None_ | — | — | Zero failed requests |
