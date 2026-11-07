# N+1 query guard baseline (Database sheet: N+1 Queries)

Request-path and cron code must not run per-record Supabase queries inside
loops over unbounded collections. `src/lib/__tests__/nPlusOneGuard.test.ts`
scans `src/app/api/**/route.ts` and `src/lib/**/*.ts` with a brace-aware
loop-body analysis and fails CI on any loop+await-query pattern that is
not classified here, or on a classified entry that no longer matches the
code (stale baseline). Add the justification - or fix the query - in the
same PR that introduces the pattern.

Measured 7 Nov 2026: 7 patterns, all bounded fan-out except the one
flagged cron follow-up below.

| Location | Loop | Classification |
| --- | --- | --- |
| `src/lib/account/deleteHandler.ts` | `for (const sub of subs)` | Bounded: iterates the user's own subscriptions (a user holds at most a couple); each cancel must be per-subscription. |
| `src/lib/account/deleteHandler.ts` | `for (const table of ACCOUNT_DELETE_USER_ID_TABLES)` | Bounded: iterates a fixed constant list of account tables (one delete per table, by design). |
| `src/lib/account/deleteHandler.ts` | `for (const emailTable of ACCOUNT_DELETE_EMAIL_TABLES)` | Bounded: same fixed constant table-list fan-out. |
| `src/lib/account/exportHandler.ts` | `for (const table of ACCOUNT_EXPORT_USER_ID_TABLES)` | Bounded: fixed constant table-list fan-out for export. |
| `src/lib/account/exportHandler.ts` | `for (const table of ACCOUNT_EXPORT_EMAIL_TABLES)` | Bounded: fixed constant table-list fan-out for export. |
| `src/lib/cron/dailyDigestCron.ts` | `for (const item of candidateProfiles)` | FIXED (was FLAGGED): the candidate loop no longer issues per-user queries. Suppression status is pre-fetched in bounded 100-email chunks and digest rows go out as one bulk `daily_digests` upsert with a per-row fallback on bulk failure (owner confirmed). |
| `src/lib/cron/dailyDigestCron.ts` | `for (let i = 0; i < emails.length; i += 100)` | Bounded: suppression pre-fetch in 100-email chunks; runs once per cron run, not per user. |
| `src/lib/cron/dailyDigestCron.ts` | `for (const row of pendingDigestRows)` | Fallback only: per-row upserts run solely when the single bulk upsert fails, preserving per-user failure isolation. |
| `src/lib/events/failedEvents.ts` | `for (const event of events)` | Bounded: retry-queue batch processor; the loop iterates one fetched batch of dead-letter events (batch size capped by the select limit), and per-event state transitions are individual updates by design. |

<!-- guard-entries: file | loop-header-text, parsed by nPlusOneGuard.test.ts -->
```guard
pattern: src/lib/account/deleteHandler.ts | for (const sub of subs)
pattern: src/lib/account/deleteHandler.ts | for (const table of ACCOUNT_DELETE_USER_ID_TABLES)
pattern: src/lib/account/deleteHandler.ts | for (const emailTable of ACCOUNT_DELETE_EMAIL_TABLES)
pattern: src/lib/account/exportHandler.ts | for (const table of ACCOUNT_EXPORT_USER_ID_TABLES)
pattern: src/lib/account/exportHandler.ts | for (const table of ACCOUNT_EXPORT_EMAIL_TABLES)
pattern: src/lib/cron/dailyDigestCron.ts | for (let i = 0; i < emails.length; i += 100)
pattern: src/lib/cron/dailyDigestCron.ts | for (const row of pendingDigestRows)
pattern: src/lib/events/failedEvents.ts | for (const event of events)
```
