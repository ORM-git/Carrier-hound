# Inbound reply handling (INTERNAL)

Backend sheet rank 14: product mail goes out from the sender mailbox
(`GMAIL_SENDER_EMAIL`) but replies to it were invisible - nothing read the
inbox. This adds repo-side inbound handling; activation is owner-gated.

## What exists now

- `supabase/migrations/20261106j_inbound_replies.sql` - reply storage
  (Gmail message id as dedupe key, thread, from, subject, truncated
  excerpt, coarse kind, received/processed timestamps). RLS enabled with
  no user-facing policies: service role only. NOT APPLIED: owner applies
  in the Supabase SQL editor, then records it with
  `node scripts/record-migration.cjs 20261106j_inbound_replies`.
  Rollback: `DROP TABLE IF EXISTS public.inbound_replies;`
- `scripts/poll-inbound-replies.ts` - polls the sender mailbox via the
  Gmail API, dedupes on message id, stores replies. Kind classification
  is a coarse hint (`reply` / `bounce_suspect` / `unsubscribe_suspect`);
  real bounce and unsubscribe processing belongs to the dedicated sheet
  rows (38/39), which read from this table.
- `.github/workflows/inbound-poll-cron.yml` - every 4 hours (chosen default cadence; replies are not urgent pre-launch) plus
  `workflow_dispatch`.

## Activation checklist (owner steps)

1. Apply the migration above and record it.
2. Re-consent the Gmail OAuth grant with the `gmail.readonly` scope added
   (the current grant only has `gmail.send`) and update
   `GMAIL_REFRESH_TOKEN` in the vault/secrets. Until then the poller logs
   the 403 and exits green, so the cron is safe to leave scheduled.
3. Set `INBOUND_POLL_ENABLED=true` in the workflow environment/secrets.
4. Decide who reviews `inbound_replies` and how replies get answered
   (a human, for now; auto-replies are a product decision).

## Scope notes

- No user-facing or API-visible copy changes; nothing here sends mail.
- Inserts are fail-open (warn and continue), matching the owner decision
  on audit/history writes.
- The 2-day lookback window and 25-message cap per run are chosen
  defaults to bound API usage; widen once traffic justifies it.
