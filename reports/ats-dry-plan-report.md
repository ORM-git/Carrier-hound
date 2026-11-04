# CareerMonke ATS Discovery-to-Ingestion Dry-Plan Report

**Generated At**: `2026-11-04T09:12:07.929Z`
**Execution Mode**: `LIVE_NETWORK_DRY_PLAN`
**Target Source**: `REGISTRY` (`15` employers)
**DB Headroom Verification**: `VERIFIED_CONNECTED`

---

## 1. Executive Summary: Seed vs Registry Sizing

| Metric | Measured Dry-Plan Value | Notes / Ingestion Safety Context |
|---|---|---|
| **Config Selection** | `registry` | Verified approved employers list |
| **Total Employers Planned** | `15` | 52 for Seed, 277 for Full Registry |
| **Employers Attempted** | `15` | Checkpointed & resumable |
| **Active Boards (>=1 job)** | `13` | Successfully fetched with normalized jobs |
| **Empty Boards (0 jobs)** | `2` | Valid 200 response with zero open roles |
| **Failed / Blocked Boards** | `0 / 0` | HTTP 4xx/5xx/network errors |
| **Total Raw Jobs Fetched** | `699` | Direct ATS payload items |
| **Total Jobs Accepted** | `691` | Valid apply URL, HTTPS, text-only <=1500 chars |
| **Unique Roles (Cross-Dedupe)** | `691` | Deduped by company + title + location |
| **Duplicates Dropped** | `8` | Intra-run duplicate listings removed |
| **Unlisted Skipped (Ashby)** | `0` | Strictly excluded `isListed=false` |
| **Global Jobs Accepted** | `691` | Worldwide unique listings |
| **India-Eligible Jobs Total** | `77` | India onsite/hybrid + worldwide remote |
| **Estimated DB Bytes** | `17,68,960 B (1.69 MB)` | Safety threshold is 150.00 MB |

> [!NOTE]
> **DB Headroom Status**: `VERIFIED_CONNECTED`. When DB read credentials are not supplied or in local offline mode, DB deltas are recorded as unverified rather than claiming fabricated additions.

---

## 2. India & Remote Eligibility Breakdown

CareerMonke enforces strict geographical classification. US-only remote jobs are never converted into India-eligible listings.

| Geographic Segment | Jobs Count | Percentage of Accepted |
|---|---|---|
| **India Onsite / Hybrid** | `11` | Jobs physically in India |
| **Explicitly India-Eligible Remote** | `66` | Explicit Worldwide or India remote |
| **Unknown Remote Eligibility** | `0` | Remote without geographic restriction |
| **Country-Restricted (Non-India)** | `63` | E.g. US/Canada/EU remote only |
| **Total India-Eligible Supply** | `77` | **11.1%** of total accepted |

---

## 3. Disclosed Salary Coverage by ATS

Only valid numeric disclosed ranges (`min > 0` or `max > 0`) are counted. Empty compensation objects are rejected, and periods are never assumed to be annual without explicit provider confirmation.

| ATS Provider | Accepted Jobs | With Disclosed Salary | Salary Disclosure Rate |
|---|---|---|---|
| **ASHBY** | `691` | `489` | **70.8%** |

### Currency Distribution
- **USD**: `469` jobs
- **CAD**: `3` jobs
- **EUR**: `8` jobs
- **GBP**: `3` jobs
- **SEK**: `2` jobs
- **SAR**: `3` jobs
- **AUD**: `1` jobs

---

## 4. Incompatible Sources Audit & Safety Flagging

In accordance with project operational locks:
- **Remotive (`api-remotive`)**: Flagged in `scripts/config/sources.json`. Signup-wall restrictions conflict with public unauthenticated feed principles. Do NOT use for scale.
- **Adzuna (`adzuna.ts`)**: Commercial licensing and strict republication attribution terms conflict with CareerMonke rules. Do NOT enable as a scale shortcut.
- **Third-Party Scraping**: Strictly 0 requests to LinkedIn, Indeed, Naukri, Glassdoor, Workday. All ingestion is direct to employer public ATS APIs.

---

## 5. Rollout Command & Rollback Plan

### Next Owner-Approved Rollout Command
To perform an owner-approved dry-plan run or phased deployment:
```bash
# Run explicit dry-plan comparison on existing registry
npx tsx scripts/ats-dry-plan.ts --source registry --resume

# Optional: Run targeted ATS dry-plan (e.g. Greenhouse only)
npx tsx scripts/ats-dry-plan.ts --source registry --ats greenhouse
```

### Rollback Plan
- The dry-plan engine is strictly read-only and mutates zero database rows.
- If live-write is executed in a future phase, `board-ingest.ts` automatically generates a targeted rollback script at:
  `reports/rollback-ingest-<discovered_at>.sql`
  which contains:
  `DELETE FROM jobs WHERE discovered_at = '<discovered_at>' AND source_type = 'ats';`
- No destructive deletes or broad drops are ever executed.
