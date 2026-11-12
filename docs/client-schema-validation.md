# Client Schema Validation Audit (`src/lib/api/`)

Runtime payload validation for client-consumed responses under `src/lib/api/` is implemented with small hand-written validators in [`src/lib/api/clientSchemas.ts`](../src/lib/api/clientSchemas.ts) (no `zod` or `yup`, preserving the landing first-load bundle budget).

Low-level validators in `clientSchemas.ts` (`parseSearchJobsRows`, `parseSearchJobsFacetRows`, `parseWorldwideCompanyRows`) throw `ClientSchemaValidationError` when a payload fails runtime type/shape checks so malformed data can be tested and rejected at the schema layer. At caller/page-facing fetch boundaries (`getWorldwideCompanies`, `searchJobs`), `ClientSchemaValidationError` is caught, logged safely via the structured logger (`src/lib/observability/logger.ts`), and degraded to the established safe fallback so one malformed row or transient schema mismatch never crashes SSR/SSG builds or live pages. Existing public landing validators (`parseStatsResponse`, `parseGlobeStats`, `parseTickerResponse`) retain their `null` / `[]` normalization contract for backwards compatibility.

## Complete Inventory of `src/lib/api/`

| File | Fetch / Query Path | Before This Change | After This Change | Validator & Safe-Degrade Boundary Behavior |
| --- | --- | --- | --- | --- |
| `src/lib/api/stats.ts` | `getLiveStats()` -> `fetch("/api/stats")` | Validated | Validated (untouched; covered by PR #546) | `parseStatsResponse`; returns `null` on non-object |
| `src/lib/api/jobs.ts` | `searchJobs()` primary query (`supabase.from(targetTable).select(...)`) | Unvalidated (`(data \|\| []).map((d: any) => ...)`) | Validated with safe degrade | `parseSearchJobsRows` throws `ClientSchemaValidationError` at schema level; `searchJobs()` catches, logs via `api/jobs` logger, and degrades safely to empty `jobs: []` |
| `src/lib/api/jobs.ts` | `searchJobs()` facet query (`supabase.from("jobs_public").select("category, country")`) | Unvalidated (`facetData.forEach((row: any) => ...)`) | Validated with safe degrade | `parseSearchJobsFacetRows` throws `ClientSchemaValidationError` at schema level; `searchJobs()` catches, logs safely, and degrades to empty `facets` + static `availableCountries` fallback |
| `src/lib/api/worldwide.ts` | `getWorldwideCompanies()` (`client.from("worldwide_company_counts").select(...)`) | Unvalidated (`for (const row of data)`) | Validated with safe degrade | `parseWorldwideCompanyRows` throws `ClientSchemaValidationError` at schema level; `getWorldwideCompanies()` catches, logs via `api/worldwide` logger, and returns static `WORLDWIDE_COMPANIES` fallback (never crashes `WorldwidePage` or build) |
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
- **Heuristic notice**: The static check uses an intraprocedural TypeScript AST data-flow heuristic (tracing query/fetch bindings within each enclosing function to an imported validator from `clientSchemas.ts` called after the fetch execution on that response binding). Because it operates intraprocedurally within single functions rather than whole-program interprocedural taint analysis, helper wrappers or aliased mutations across separate functions are outside its automated trace.
- Verifies:
  1. Positive and negative fixture payloads for `parseSearchJobsRows`, `parseSearchJobsFacetRows`, and `parseWorldwideCompanyRows`, asserting `ClientSchemaValidationError` on every malformed shape at the validator level.
  2. Caller-level safe-degradation tests for `getWorldwideCompanies()` (malformed `active_job_count` row or non-array response logs safely and returns the static `WORLDWIDE_COMPANIES` fallback without throwing) and `searchJobs()` (malformed job rows degrade to `jobs: []`; malformed facet rows degrade to empty facets + static country fallback without throwing).
  3. Intraprocedural AST binding guard across all `src/lib/api/*.ts` modules (except `stats.ts` and explicitly allowlisted server/transport utilities), plus negative controls failing on: (a) an unused `clientSchemas` import + unrelated `parseInt` call, (b) an unrelated `parseSearchJobsRows([])` call not applied to a later query result, and (c) an unvalidated second query path in the same file.
