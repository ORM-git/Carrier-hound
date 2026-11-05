-- Migration: 20261105d_email_suppressions_unique_constraint.sql
-- Description: Add plain unique constraint on public.email_suppressions(email)
-- Context: The existing lowercase trigger (trg_email_suppressions_lowercase) already guarantees
-- equivalence by normalizing all emails on insert/update. PostgREST/Supabase requires a plain
-- unique constraint or index on the target column to support upsert with { onConflict: "email" }.
-- Notice: DO NOT apply this file automatically. Apply manually via Supabase SQL editor or CLI.

-- ============================================================================
-- ROLLBACK INSTRUCTIONS (execute in Supabase SQL editor if rollback is needed):
-- ============================================================================
-- alter table public.email_suppressions drop constraint if exists email_suppressions_email_key;
-- ============================================================================

-- 1. Ensure any duplicate lowercase records are resolved before constraint addition (safety guard)
-- (In fresh or cleaned databases this is a no-op; preserves earliest record)
delete from public.email_suppressions a
using public.email_suppressions b
where a.ctid < b.ctid
  and lower(trim(a.email)) = lower(trim(b.email));

-- 2. Add plain unique constraint on the email column if not already present
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.email_suppressions'::regclass
      and contype = 'u'
      and conname = 'email_suppressions_email_key'
  ) then
    alter table public.email_suppressions
      add constraint email_suppressions_email_key unique (email);
  end if;
end $$;

comment on constraint email_suppressions_email_key on public.email_suppressions is
  'Enforces unique email addresses for PostgREST onConflict upsert resolution.';

-- ============================================================================
-- VERIFICATION QUERY:
-- select conname, contype, pg_get_constraintdef(oid)
-- from pg_constraint
-- where conrelid = 'public.email_suppressions'::regclass
--   and conname = 'email_suppressions_email_key';
-- ============================================================================
