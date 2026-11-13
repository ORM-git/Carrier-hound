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
| `src/lib/account/deleteHandler.ts:283` | subscriptions | Reads the full row immediately before deletion so the audit record captures what was removed. |
| `src/lib/resume/storage.ts:155` | candidate_profiles | The fetched profile is returned whole to the caller. |
| `src/lib/tracker/storage.ts:133` | applications | The application rows are returned whole to the caller (tracker list). |

### Billing reads kept as `*` (owner to confirm)

(None - former verify fallback queries removed in favor of atomic SQL RPC fulfil_payment_order)

### Narrowed (done)

| Site | Table | Now reads |
| --- | --- | --- |
| `src/app/api/billing/razorpay/verify/route.ts:332` | user_addon_credits | Removed: JavaScript fallback removed in favor of atomic SQL RPC fulfil_payment_order. |
| `src/app/api/billing/razorpay/verify/route.ts:348` | subscriptions | Removed: JavaScript fallback removed in favor of atomic SQL RPC fulfil_payment_order. |
| `src/lib/billing/quota.ts:307` | subscriptions | `plan_id, current_period_start, current_period_end, created_at` (the only `sub.*` reads in getPlanQuota). |
| `src/lib/billing/quota.ts:325` | plans | The 10 plan columns the mapper copies (`code` ... `is_active`). Previously documented as 5; the code reads 10. |
| `src/lib/billing/subscription.ts:63` | subscriptions | `status, plan_id, current_period_end, grace_period_end` (the only reads in getProAccessStatus). |
| `src/lib/billing/subscription.ts:319` | subscriptions | The 12 columns getUserSubscription maps to UserSubscription. |
| `src/lib/billing/serverEntitlement.ts:53` | subscriptions | `status, plan_id, current_period_end, grace_period_end`. |
| `src/app/api/billing/razorpay/verify/route.ts:178` | payment_orders | `id, provider, mode, provider_order_id, plan_code, addon_code, amount_paise, status`. `mode` is added by `20261104b_payment_order_mode_isolation.sql`; the row is never returned in a response. |
| `src/app/api/billing/razorpay/verify/route.ts:493` | subscriptions | `status, current_period_start, current_period_end` (renewal/upgrade period math; the row is not returned in the response on this path). |
| `src/lib/auth/session.ts` (getUserPreferences) | user_preferences | The 13 columns the mapper consumes (`roles` ... `updated_at`); `src/lib/__tests__/userPreferencesColumns.test.ts` fails if a column the mapper reads is missing from the list. Same column names the search/top10 routes already select by name. |

### Bounded scans under review elsewhere (keep, tracked by rank 46)

| Site | Table | Note |
| --- | --- | --- |
| `src/lib/cron/dailyDigestCron.ts:121` | candidate_profiles | Per-user loop already flagged in `docs/db-n-plus-one.md` (rank 46) with a batching recommendation. Column tightening should ride that fix. |
| `src/lib/cron/digestStorage.ts:61` | daily_digests | Single latest digest row per user. |
| `src/lib/events/failedEvents.ts:626` | failed_events | Replay batch read (bounded batch, see rank 46 doc); the replay needs the full payload column set. |

## Guard

`selectStarGuard.test.ts` scans `src/**` (`.ts` and `.tsx`) for `.select("*")` /
`.select('*')` and fails when a call site is not in the allowlist above. To add
a site deliberately, add it here and to the allowlist in the same PR.
