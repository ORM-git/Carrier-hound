# Uniform Error Shape (Backend sheet rank 72)

Sheet evidence: "{error} or {ok:false,error} JSON; shape varies slightly per
route." This document records the canonical rule and every sanctioned
variant, and `src/lib/__tests__/errorShapeGuard.test.ts` fails CI when a route
introduces a new unlisted error-body shape, a non-`false` `ok` value, or a
non-string `error` field. Existing responses are NOT rewritten - changing an
emitted body is an API-contract change and out of scope for a guard PR.

## Canonical rule

Every 4xx/5xx JSON response body from a route handler MUST be an object whose
first key is `error` (a human-safe string). Sanctioned optional extra keys:

| Extra keys | When |
| --- | --- |
| `code` | Machine-readable error code for client branching (billing routes). |
| `retryAfter` | Rate-limit 429s; seconds until retry. |
| `ok` (`false`) | Routes whose success shape is `{ ok: true, ... }` keep `{ ok: false, error }` so clients can branch on one key. |

## Sanctioned legacy variants (allowlisted, do not extend)

| Shape keys | Where / why |
| --- | --- |
| `error, Forbidden` | Admin 403s carry a `Forbidden: true` flag consumed by the admin UI. |
| `error, message, access` | `/api/stats`, `/api/me/quota` 403s carrying the access object. |
| `error, message, access, jobs` | `/api/jobs/search` 403 with payload. |
| `error, message, access, jobs, total` | `/api/jobs/search` 403 variant with total. |
| `error, isPro, code` | `/api/jobs/top10` 403 carrying pro status. |
| `error, jobs` | `/api/jobs/top10` 400 with payload. |
| `error, jobs, totalCount` | `/api/jobs/search` 500 with payload. |
| `error, parameter` | `/api/jobs/pro` 400 naming the bad parameter. |
| `ok, error, retryAfter` | `/api/early-access`, `/api/track` 429s combining both conventions. |

## Partial-content payloads (not error bodies)

`/api/jobs/search` degraded 503s and one 500 return job-list payloads
(`degraded/jobs/totalCount/hasNextPage/hasMore/nextCursor` or
`jobs/totalCount`) without an `error` key so clients keep rendering results.
These are allowlisted as partial-content payloads, not errors.

## Guard coverage, honestly

The guard in `src/lib/__tests__/errorShapeGuard.test.ts` performs stronger
static validation over `NextResponse.json(..., ...)` calls in
`src/app/api/**/route.ts`:

- **Statically validated on recognized object literals**:
  - Top-level key sets must match `CANONICAL`, `LEGACY`, or `PARTIAL_PAYLOAD`.
  - Wherever the `ok` key is present on a 4xx/5xx error literal, its value must be the exact boolean literal `false` (`ok: false`).
  - Public `error` fields (and `message` fields on legacy 403 shapes) are checked against non-string literals (numbers, booleans, `null`, `undefined`, objects, arrays), empty strings, bare error-object identifiers, and unanalyzable object syntax (spreads, shorthand properties, computed keys, duplicate keys), reporting `file:line` diagnostics.
- **Reported as `unverified` (not claimed covered)**:
  - Call sites whose body argument is a variable/helper call (`NextResponse.json(parsed, { status: 500 })`), whose options argument or `status` property is dynamic (`status: authCheck.status`), whose partial payload spreads a variable (`{ ...parsed, jobs: [], totalCount: 0 }`), or whose `error` property is a runtime member/interpolation expression (`err?.message || "..."`, `err.message`) are explicitly recorded in `unverified` rather than counted as statically verified literals.
- **Scope**: This guard provides stronger static validation only; it is not universal runtime normalization and does not complete the entire audit row on its own.
