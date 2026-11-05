-- Migration: 20261105c_database_safety.sql
-- Description: Database safety migration (schema_migrations table, role-level timeouts, pg_stat_statements)
-- Access: schema_migrations has RLS enabled (deny-all to public/anon/authenticated, service_role only)
-- Notice: DO NOT apply this file automatically. Apply manually via Supabase SQL editor or CLI.

-- ============================================================================
-- ROLLBACK INSTRUCTIONS (execute in Supabase SQL editor if rollback is needed):
-- ============================================================================
--
-- 1. Reset role-level timeouts to database defaults:
--    alter role authenticator reset statement_timeout;
--    alter role authenticator reset lock_timeout;
--    alter role authenticator reset idle_in_transaction_session_timeout;
--
--    alter role anon reset statement_timeout;
--    alter role anon reset lock_timeout;
--    alter role anon reset idle_in_transaction_session_timeout;
--
--    alter role authenticated reset statement_timeout;
--    alter role authenticated reset lock_timeout;
--    alter role authenticated reset idle_in_transaction_session_timeout;
--
-- 2. Drop schema_migrations tracking table:
--    drop table if exists public.schema_migrations cascade;
--
-- 3. (Optional) Disable pg_stat_statements extension if no longer needed:
--    drop extension if exists pg_stat_statements;
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- (1) SCHEMA_MIGRATIONS TRACKING TABLE
-- ----------------------------------------------------------------------------
create table if not exists public.schema_migrations (
  filename text primary key,
  applied_at timestamptz not null default now(),
  applied_by text not null default current_user,
  checksum text
);

comment on table public.schema_migrations is 'Tracks applied database migrations with checksums and audit timestamps.';
comment on column public.schema_migrations.filename is 'Base migration filename (e.g., 20261105c_database_safety.sql).';
comment on column public.schema_migrations.applied_at is 'Timestamp when migration was manually executed.';
comment on column public.schema_migrations.applied_by is 'User or service account that executed the migration.';
comment on column public.schema_migrations.checksum is 'SHA-256 hash of the migration file contents at execution time.';

-- Enable Row Level Security (deny-all to public/anon/authenticated, service_role only)
alter table public.schema_migrations enable row level security;

revoke all on public.schema_migrations from public, anon, authenticated;
grant all on public.schema_migrations to service_role;

-- ----------------------------------------------------------------------------
-- (2) ROLE-LEVEL TIMEOUTS (service_role excluded for admin & cron longevity)
-- ----------------------------------------------------------------------------
-- Authenticator role (Supabase PostgREST connection pooler)
alter role authenticator set statement_timeout = '15s';
alter role authenticator set lock_timeout = '5s';
alter role authenticator set idle_in_transaction_session_timeout = '60s';

-- Anonymous public role
alter role anon set statement_timeout = '15s';
alter role anon set lock_timeout = '5s';
alter role anon set idle_in_transaction_session_timeout = '60s';

-- Authenticated end-user role
alter role authenticated set statement_timeout = '15s';
alter role authenticated set lock_timeout = '5s';
alter role authenticated set idle_in_transaction_session_timeout = '60s';

-- ----------------------------------------------------------------------------
-- (3) PG_STAT_STATEMENTS EXTENSION
-- ----------------------------------------------------------------------------
create extension if not exists pg_stat_statements;

-- ============================================================================
-- VERIFY QUERIES (execute in Supabase SQL editor to confirm configuration):
-- ============================================================================
--
-- 1. Verify schema_migrations table existence and RLS status:
--    select schemaname, tablename, rowsecurity
--    from pg_tables
--    where schemaname = 'public' and tablename = 'schema_migrations';
--
-- 2. Verify schema_migrations permissions (only service_role has access):
--    select grantee, privilege_type
--    from information_schema.role_table_grants
--    where table_schema = 'public' and table_name = 'schema_migrations';
--
-- 3. Verify role-level timeout configurations for authenticator, anon, and authenticated:
--    select r.rolname, s.setconfig
--    from pg_roles r
--    left join pg_db_role_setting s on s.setrole = r.oid
--    where r.rolname in ('authenticator', 'anon', 'authenticated', 'service_role')
--    order by r.rolname;
--
-- 4. Verify pg_stat_statements extension status:
--    select extname, extversion, extrelocatable
--    from pg_extension
--    where extname = 'pg_stat_statements';
--
-- ============================================================================
