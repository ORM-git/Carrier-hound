# Uniform Error Shape (Backend sheet rank 72)

Sheet evidence: "{error} or {ok:false,error} JSON; shape varies slightly per
route." This document records the canonical rule and every sanctioned
variant, and `src/lib/__tests__/errorShapeGuard.test.ts` fails CI when a route
introduces a new unlisted error-body shape. Existing responses are NOT
rewritten - changing an emitted body is an API-contract change and out of
scope for a guard PR.

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

The guard scans direct `NextResponse.json({ ... }, { status: 4xx/5xx })`
literals in `src/app/api/**/route.ts`. Bodies assembled via helper functions
or spread variables are outside its view; the canonical rule still applies to
them - reviewers enforce it until the guard learns those forms.
