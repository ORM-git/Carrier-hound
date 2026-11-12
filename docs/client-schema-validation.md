# Client Schema Validation Audit (`src/lib/api/`)

Runtime payload validation for client-consumed responses under `src/lib/api/` is implemented with small hand-written validators in [`src/lib/api/clientSchemas.ts`](../src/lib/api/clientSchemas.ts) (no `zod` or `yup`, preserving the landing first-load bundle budget).

New validators throw `ClientSchemaValidationError` when a payload fails runtime type/shape checks so malformed data is rejected immediately rather than reaching UI state. Existing public landing validators (`parseStatsResponse`, `parseGlobeStats`, `parseTickerResponse`) keep their `null` / `[]` normalization contract for backwards compatibility with existing callers.

## Complete Inventory of `src/lib/api/`

| File | Fetch / Query Path | Before This Change | After This Change | Validator & Failure Behavior |
| --- | --- | --- | --- | --- |
| `src/lib/api/stats.ts` | `getLiveStats()` -> `fetch("/api/stats")` | Validated | Validated (untouched; covered by PR #546) | `parseStatsResponse`; returns `null` on non-object |
| `src/lib/api/jobs.ts` | `searchJobs()` primary query (`supabase.from(targetTable).select(...)`) | Unvalidated (`(data \|\| []).map((d: any) => ...)`) | Validated | `parseSearchJobsRows`; throws `ClientSchemaValidationError` on non-array or malformed row |
| `src/lib/api/jobs.ts` | `searchJobs()` facet query (`supabase.from("jobs_public").select("category, country")`) | Unvalidated (`facetData.forEach((row: any) => ...)`) | Validated | `parseSearchJobsFacetRows`; throws `ClientSchemaValidationError` on non-array or malformed facet row |
| `src/lib/api/worldwide.ts` | `getWorldwideCompanies()` (`client.from("worldwide_company_counts").select(...)`) | Unvalidated (`for (const row of data)`) | Validated | `parseWorldwideCompanyRows`; throws `ClientSchemaValidationError` on malformed non-null payload; preserves static fallback on null client/empty/DB error |
| `src/lib/api/clientSchemas.ts` | Schema validator module (no fetch) | Validator host | Validator host + `ClientSchemaValidationError` | Exports `parseStatsResponse`, `parseGlobeStats`, `parseTickerResponse`, `parseSearchJobsRows`, `parseSearchJobsFacetRows`, `parseWorldwideCompanyRows` |
| `src/lib/api/retryFetch.ts` | Generic retry helper `fetchWithRetry(doFetch)` | Transport wrapper only (no JSON parse/schema ownership) | Unchanged (allowlisted infra helper) | Delegates `doFetch()` to caller |
| `src/lib/api/envCheck.ts` | None (server env check) | N/A | N/A | Server utility only |
| `src/lib/api/errorResponse.ts` | None (server `NextResponse` builder) | N/A | N/A | Server utility only |
| `src/lib/api/etag.ts` | None (server weak ETag helper) | N/A | N/A | Server utility only |
| `src/lib/api/radarResponse.ts` | None (server `/api/radar` response builder) | N/A | N/A | Server utility only |
| `src/lib/api/routeBudget.ts` | None (server route latency logger) | N/A | N/A | Server utility only |
| `src/lib/api/sharedRateLimit.ts` | Server-side Supabase RPC/table rate limit (`check_rate_limit`, `rate_limits`) | Server-only (`SUPABASE_SERVICE_ROLE_KEY`) | Unchanged (allowlisted server module) | Not a client response path |

## Newly Covered Client Fetch Paths

- **3 fetch/query paths newly covered** across 2 modules (`src/lib/api/jobs.ts` primary jobs query + facet query; `src/lib/api/worldwide.ts` company counts view query).

## Out-of-Scope Client Fetch Callers (Honesty Note)

- `parseGlobeStats` (`src/components/GlobeLiveStats.tsx`) and `parseTickerResponse` (`src/components/LandingJobsTickerStrip.tsx`) already consume validators from `src/lib/api/clientSchemas.ts` directly inside UI components.
- Client `fetch(...)` calls that live outside `src/lib/api/` (such as `src/lib/jobs/service.ts`, `src/lib/ai/groq.ts`, `src/lib/billing/razorpay.ts`, and `src/lib/analytics/funnel.ts`) are outside the `src/lib/api/` scope and static guard in this document.

## Offline Guard Verification

- Script: `scripts/test-client-schema-coverage.ts` (registered in `scripts/suite-runner.ts` as an `offline` suite).
- Verifies:
  1. Positive and negative fixture payloads for `parseSearchJobsRows`, `parseSearchJobsFacetRows`, and `parseWorldwideCompanyRows`, asserting `ClientSchemaValidationError` on every malformed shape.
  2. Mocked Supabase integration checks for `searchJobs()` and `getWorldwideCompanies()`.
  3. Static coverage scan across all `src/lib/api/*.ts` modules (except `stats.ts` and explicitly allowlisted server/transport utilities), failing if any fetch/query path lacks a `clientSchemas.ts` validation call or is omitted from this inventory.
