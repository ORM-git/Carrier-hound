# Postmortem: Early-access digest cron failing on missing env (2026-10-30 → 2026-11-06)

## Summary

The scheduled "Daily Early-Access Signup Digest" GitHub Actions workflow
failed every night from 2026-10-30 through 2026-11-05 (run at 18:00 UTC /
23:30 IST). The script exited with `reason: missing_env` because one or
more of `APPS_SCRIPT_MAIL_URL`, `APPS_SCRIPT_MAIL_SECRET`,
`EARLY_ACCESS_NOTIFY_EMAIL` are not set in the repository's Actions
secrets. A manual dry-run on 2026-11-05 passed, which masked the failure:
dry-run mode returns before the mail configuration is validated.

## Impact

Owner received no daily digest of new early-access signups for 7 nights.
No user-facing impact; signup capture itself was unaffected.

## Timeline

- 2026-10-30 21:43 UTC - first scheduled failure (`missing_env`).
- 2026-11-01 → 2026-11-05 - same failure each night; failure emails from
  GitHub Actions went unread.
- 2026-11-05 09:19 UTC - manual `workflow_dispatch` with `dry_run=true`
  succeeded, giving a false sense of health.
- 2026-11-06 - failure confirmed during audit; root cause identified from
  run logs.

## Root cause

The three mail secrets were never added to Actions secrets (the digest
code path was tested only via dry-run, which skips the config check at
`src/lib/early-access/gmail.ts` step 4).

## What went well

- The script failed closed with a clear `missing_env` reason and a log
  line naming the missing configuration group.

## What went poorly

- Failure ran for 7 nights before anyone read the Actions failure emails.
- Dry-run success is indistinguishable from real success in the Actions
  UI at a glance.

## Action items

1. Owner: set `APPS_SCRIPT_MAIL_URL`, `APPS_SCRIPT_MAIL_SECRET`,
   `EARLY_ACCESS_NOTIFY_EMAIL` in repo Actions secrets, then re-run the
   workflow manually without dry-run to confirm a real send.
2. Move the mail-config validation **before** the dry-run early return so
   a dry run also fails when env is missing (code change, this audit).
3. Send a Sentry `captureMessage` (or failed_events row) on cron failure
   so failures surface somewhere watched (code change, this audit).
4. Add the incident to `docs/incident-log.md` (done).
