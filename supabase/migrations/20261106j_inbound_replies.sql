-- ============================================================================
-- Migration: 20261106j_inbound_replies.sql
-- Purpose:   Inbound reply storage (Backend sheet rank 14). The sender
--            mailbox (GMAIL_SENDER_EMAIL) had no inbound processing: replies
--            to product mail were invisible. This table stores polled
--            replies for review and downstream handling.
-- Status:    NOT APPLIED - owner applies in the Supabase SQL editor, then runs
--            node scripts/record-migration.cjs 20261106j_inbound_replies
-- Covers:    Backend sheet rank 14 (reply-to / inbound handling).
-- Notes:     RLS enabled with no user-facing policies: only the service role
--            (poller, admin tooling) can read or write. kind is a coarse
--            hint only; bounce/unsubscribe handling proper lives in the
--            dedicated sheet rows (38/39), not here.
-- Rollback:  DROP TABLE IF EXISTS public.inbound_replies;
-- ============================================================================

create table if not exists public.inbound_replies (
  id            uuid primary key default gen_random_uuid(),
  message_id    text not null unique,      -- Gmail message id (dedupe key)
  thread_id     text,
  from_address  text not null,
  subject       text,
  body_excerpt  text,                      -- truncated by the poller
  kind          text not null default 'reply'
                check (kind in ('reply', 'bounce_suspect', 'unsubscribe_suspect')),
  received_at   timestamptz not null,
  processed_at  timestamptz
);

create index if not exists idx_inbound_replies_received
  on public.inbound_replies (received_at desc);

alter table public.inbound_replies enable row level security;
