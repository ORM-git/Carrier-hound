# Conditional requests (Backend sheet row: ETag / Conditional Requests)

Weak ETag and `If-None-Match` to 304 support is in `src/lib/api/etag.ts`. It is applied only where the JSON body is
the same for every anonymous caller.

| Route | ETag and 304 | Why |
| --- | --- | --- |
| `/api/ticker` | yes | Public, identical for every caller |
| `/api/radar` | yes (`src/lib/api/radarResponse.ts`) | Public aggregate, identical for every caller, already cached for 5 minutes |
| `/api/stats` | yes | Public stats payload uses weak ETag and returns 304 Not Modified when unchanged |
| Per-user or entitlement routes (`/api/jobs/*`, `/api/me/*`, `/api/account/*`, `/api/ai`) | no | Body depends on the caller or is not a safe cacheable read |

For `/api/radar` the body, status, `Cache-Control` and `X-Cache` values are unchanged. Added: an `ETag` header, and a
304 with no body when `If-None-Match` matches. The globe component fetches it with `cache: "no-store"`, so the page
does not send `If-None-Match` and sees no change.

Offline tests: `npx tsx scripts/test-radar-etag.ts`, `npx tsx scripts/test-stats-etag.ts` and `src/lib/__tests__/etag.test.ts`.

## Not proven (owner to confirm)

- Not called against a live host. Whether the CDN keeps the `ETag` header and answers 304 itself is a host behavior.
- Static files stay at the provider default.
- The remaining public routes were not given tags here. `/api/jobs/search` varies by query and caller, so it was
  left out on purpose. The sheet row stays PARTIAL.
