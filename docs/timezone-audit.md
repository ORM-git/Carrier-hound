# Timezone Audit

Global audit of how the system creates, stores, compares, and schedules
timestamps (Database row "Timezone Handling"). Rule: **store and compare
in UTC ISO 8601; local time appears only where a human schedule means
it.** This audit is kept truthful by
`src/lib/__tests__/timezoneAudit.test.ts`.

## Storage and comparison: UTC, exact strings

- Timestamps are written as UTC ISO 8601 via `new Date().toISOString()`
  (e.g. `src/lib/admin/analytics.ts`, `src/lib/account/exportHandler.ts`,
  `src/lib/resume/storage.ts`, `src/lib/observability/logger.ts`).
- `posted_at` is never re-serialized. `src/lib/pagination/cursor.ts`
  keeps the exact PostgREST string (microsecond precision) end to end:
  `POSTED_AT_REGEX` validates it, `encodeCursor` stores it verbatim, and
  `decodeCursor` rejects anything that is not a strict ISO timestamp
  with a 1970-2100 year bound. This is deliberate: PostgREST returns
  offsets like `+00:00`, and re-serializing through
  `new Date().toISOString()` would lose microsecond precision and break
  keyset comparison against the stored column.
- All cross-request comparisons are string/epoch comparisons on UTC
  values; no server code constructs dates from local wall-clock fields.

## Schedules: UTC crons with an IST meaning

GitHub Actions schedules are UTC; the comments record the IST intent.

| Workflow | Cron (UTC) | IST meaning |
| --- | --- | --- |
| `early-access-digest-cron.yml` | `0 18 * * *` | 23:30 IST daily |
| `dunning-dispatch-cron.yml` | `30 4 * * *` | 10:00 IST daily (comment in file) |
| `capacity-report-cron.yml` | `0 5 * * 1` | 10:30 IST Monday (comment in file) |
| `daily-digest-cron.yml` | `30 21 * * *` | 03:00 IST next day, landing ahead of the SLO |

The digest SLO is stated in IST: `docs/slo.md` requires the daily digest
"Sent by 00:30 IST or alert". Note the anchor day: 21:30 UTC is 03:00
IST the following day, so the digest for a given IST date must run by
18:30 UTC the previous day to meet the SLO - the current 21:30 UTC
schedule lands at 03:00 IST, inside the same morning but past 00:30 IST.
Flagged for the owner to confirm the intended anchor; the schedule is
his to change.

## Residuals

- Browser-rendered times use the reader's device locale by design.
- IST here means UTC+05:30 (India, no DST), so the UTC/IST mapping above
  is stable year-round.
