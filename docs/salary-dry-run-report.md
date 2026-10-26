# Structured ATS Salary Ingestion — Dry-Run Audit Report

**Branch**: `cm/adapter-structured-salary-20261026`  
**Mode**: Dry-Run (Read-Only live ATS feeds, zero DB writes, zero migrations)  
**Schema Alignment**: `jobs.salary_period` is NULLABLE (`TEXT DEFAULT 'yearly' CHECK (salary_period IN ('yearly', 'monthly', 'hourly'))`). When interval is unknown, `ingest.ts` stores `null` rather than defaulting to `'yearly'`.  
**Format Alignment**: `formatSalary` preserves its exact default `/yr` formatting for all existing callers, and provides an opt-in `{ omitSuffix: true }` parameter for explicit suffix suppression.

---

## 1. Per-ATS Breakdown

| ATS Source | Sample Sources Audited | Total Jobs | Structured Salary | Regex Fallback | No Salary | Unset-Period Cases | Min > Max Anomalies |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Greenhouse** | Stripe, Datadog, Cloudflare | 1,595 | **219** (13.7%) | 28 (1.8%) | 1,348 (84.5%) | **219** | **0** |
| **Ashby** | OpenAI, Ramp, Linear | 991 | **786** (79.3%) | 1 (0.1%) | 204 (20.6%) | **0** | **0** |
| **Lever** | Palantir, LogRocket, ActiveCampaign | 329 | **15** (4.6%) | 0 (0.0%) | 314 (95.4%) | **0** | **0** |

---

## 2. Sample Parsed Salaries (5 Per ATS)

### A. Greenhouse
1. **[STRUCTURED]** "Accounts Payable Analyst" at Datadog  
   - Salary Text: `$59,000 - $79,000 /yr` | Min: `59000` | Max: `79000` | Currency: `USD` | Period: `unset (null in DB)`
2. **[STRUCTURED]** "AI Research Scientist - Datadog AI Research (DAIR)" at Datadog  
   - Salary Text: `$320,000 - $400,000 /yr` | Min: `320000` | Max: `400000` | Currency: `USD` | Period: `unset (null in DB)`
3. **[STRUCTURED]** "Associate Customer Success Manager - Boston" at Datadog  
   - Salary Text: `$68,000 - $90,000 /yr` | Min: `68000` | Max: `90000` | Currency: `USD` | Period: `unset (null in DB)`
4. **[STRUCTURED]** "Commercial Account Executive" at Datadog  
   - Salary Text: `$65,000 - $70,000 /yr` | Min: `65000` | Max: `70000` | Currency: `USD` | Period: `unset (null in DB)`
5. **[STRUCTURED]** "Enterprise Corporate Sales Representative" at Datadog  
   - Salary Text: `$75,000 - $80,000 /yr` | Min: `75000` | Max: `80000` | Currency: `USD` | Period: `unset (null in DB)`

### B. Ashby
1. **[STRUCTURED]** "Research Engineer" at OpenAI  
   - Salary Text: `$250,000 - $445,000 /yr` | Min: `250000` | Max: `445000` | Currency: `USD` | Period: `yearly`
2. **[STRUCTURED]** "Research Engineer, Retrieval & Search, Applied Engineering" at OpenAI  
   - Salary Text: `$293,000 - $585,000 /yr` | Min: `293000` | Max: `585000` | Currency: `USD` | Period: `yearly`
3. **[STRUCTURED]** "Researcher, Safety Training" at OpenAI  
   - Salary Text: `$380,000 - $500,000 /yr` | Min: `380000` | Max: `500000` | Currency: `USD` | Period: `yearly`
4. **[STRUCTURED]** "Software Engineer, Scaled Abuse" at OpenAI  
   - Salary Text: `$266,000 - $445,000 /yr` | Min: `266000` | Max: `445000` | Currency: `USD` | Period: `yearly`
5. **[STRUCTURED]** "Software Engineer, Data Infrastructure" at OpenAI  
   - Salary Text: `$266,000 - $445,000 /yr` | Min: `266000` | Max: `445000` | Currency: `USD` | Period: `yearly`

### C. Lever
1. **[STRUCTURED]** "Customer Success Manager" at LogRocket  
   - Salary Text: `$105,000 - $175,000 /yr` | Min: `105000` | Max: `175000` | Currency: `USD` | Period: `yearly`
2. **[STRUCTURED]** "Developer Relations" at LogRocket  
   - Salary Text: `$155,000 - $265,000 /yr` | Min: `155000` | Max: `265000` | Currency: `USD` | Period: `yearly`
3. **[STRUCTURED]** "Director of Growth" at LogRocket  
   - Salary Text: `$170,000 - $275,000 /yr` | Min: `170000` | Max: `275000` | Currency: `USD` | Period: `yearly`
4. **[STRUCTURED]** "Lead Software Engineer" at LogRocket  
   - Salary Text: `$225,000 - $260,000 /yr` | Min: `225000` | Max: `260000` | Currency: `USD` | Period: `yearly`
5. **[STRUCTURED]** "Relationship Marketing Intern" at LogRocket  
   - Salary Text: `$20 - $22 /hr` | Min: `20` | Max: `22` | Currency: `USD` | Period: `hourly`

---

## 3. Database Schema Alignment & Ingest Logic

- **Schema Check**:
  - `public.jobs.salary_period` definition: `TEXT DEFAULT 'yearly' CHECK (salary_period IN ('yearly', 'monthly', 'hourly'))`
  - Nullability: **Nullable** (no `NOT NULL` constraint). In PostgreSQL, `NULL IN ('yearly', 'monthly', 'hourly')` evaluates to `UNKNOWN`, which satisfies check constraints.
- **Ingest Adjustment** (`scripts/ingest.ts:417`):
  - Changed `row.salary_period = j.salary_period || 'yearly';` to `row.salary_period = j.salary_period || null;`.
  - When an adapter leaves `salary_period` unset because interval is unknown (e.g. Greenhouse `pay_input_ranges` without explicit frequency), the database column now correctly stores `null` rather than falsifying an assumption of `'yearly'`.
