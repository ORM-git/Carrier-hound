# SELECT * Discipline (Database sheet rank 73)

Static audit of every `.select("*")` call in `src/**` (`.ts` and `.tsx`, server and app code), as of
main after PR #401. The sheet evidence reads "Client queries column-list; RPCs
use SELECT * INTO record (acceptable)". The first half no longer holds: the
server code has 18 `.select("*")` call sites. This document records the
per-site decision so the discipline is explicit, and
`src/lib/__tests__/selectStarGuard.test.ts` fails CI if a new unreviewed
`.select("*")` appears.

Rule going forward: new queries MUST name their columns (`.select("id, status,
...")`). A full-row read needs a justification recorded in the table below AND
in the guard test's allowlist. RPC-side `SELECT * INTO record` variables remain
acceptable: they are plpgsql row variables, not wire payloads.

## Site classification

### Justified full-row reads (keep)

| Site | Table | Why `*` is correct |
| --- | --- | --- |
| `src/lib/account/exportHandler.ts:161` | per-table loop | Data-export handler: the whole point is returning every column of the user's rows. A column list would silently drop fields added later. |
| `src/lib/account/exportHandler.ts:175` | per-table loop | Same export path, email-keyed tables. |
| `src/lib/account/deleteHandler.ts:279` | subscriptions | Reads the full row immediately before deletion so the audit record captures what was removed. |
| `src/app/api/billing/razorpay/verify/route.ts:327` | user_addon_credits | The row IS the API payload (`credit: existingCredit` in the verify response). Narrowing changes the response contract, which is out of scope for a docs-only change. |
| `src/lib/resume/storage.ts:151` | candidate_profiles | The fetched profile is returned whole to the caller. |
| `src/lib/tracker/storage.ts:129` | applications | The application rows are returned whole to the caller (tracker list). |

### Narrow reads - column-list candidates (flagged, owner to confirm before tightening)

| Site | Table | Columns actually consumed | Note |
| --- | --- | --- | --- |
| `src/lib/billing/quota.ts:303` | subscriptions | `plan_id` (+ row existence) | Billing-critical path; tightening changes a hot entitlement read, so it is deferred to an owner-confirmed follow-up rather than bundled here. |
| `src/lib/billing/quota.ts:321` | plans | `code, name, duration_days, price_paise, resume_quota` | Small table, single row by unique code. |
| `src/lib/billing/subscription.ts:59` | subscriptions | subscription status/period fields | Client-facing read with a 10s timeout race; payload is one row. |
| `src/lib/billing/subscription.ts:315` | subscriptions | `status, current_period_end` | Same pattern. |
| `src/lib/billing/serverEntitlement.ts:49` | subscriptions | entitlement fields | Server entitlement check. |
| `src/app/api/billing/razorpay/verify/route.ts:173` | payment_orders | `status, addon_code, plan_code, id` | Payment verify, fail-closed path; payment-critical, deferred like the other billing reads. |
| `src/app/api/billing/razorpay/verify/route.ts:343` | subscriptions | `metadata` fields | Idempotent-replay check on the payment verify path. |
| `src/app/api/billing/razorpay/verify/route.ts:488` | subscriptions | `current_period_end` etc. | Renewal/upgrade period math on the payment verify path. |
| `src/lib/auth/session.ts:138` | user_preferences | preferences blob | Single-row per user; table is narrow. |

### Bounded scans under review elsewhere (keep, tracked by rank 46)

| Site | Table | Note |
| --- | --- | --- |
| `src/lib/cron/dailyDigestCron.ts:118` | candidate_profiles | Per-user loop already flagged in `docs/db-n-plus-one.md` (rank 46) with a batching recommendation. Column tightening should ride that fix. |
| `src/lib/cron/digestStorage.ts:58` | daily_digests | Single latest digest row per user. |
| `src/lib/events/failedEvents.ts:622` | failed_events | Replay batch read (bounded batch, see rank 46 doc); the replay needs the full payload column set. |

## Guard

`selectStarGuard.test.ts` scans `src/**` (`.ts` and `.tsx`) for `.select("*")` /
`.select('*')` and fails when a call site is not in the allowlist above. To add
a site deliberately, add it here and to the allowlist in the same PR.
