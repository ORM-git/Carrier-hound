-- ==============================================================================
-- Migration: Admin Audit Log
-- Date: 2026-10-20
-- Scope: Append-only audit trail for administrative mutations (bans, plan changes, etc.)
-- Security: Service-role only. Zero access for anon or authenticated roles.
-- ==============================================================================

-- 1. Create table public.admin_audit_log
CREATE TABLE IF NOT EXISTS public.admin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  admin_user_id uuid NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash text NULL
);

-- 2. Performance indexes for administrative investigations and chronologically ordered reads
CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at
  ON public.admin_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_user_created_at
  ON public.admin_audit_log (admin_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_log_action
  ON public.admin_audit_log (action);

-- 3. Row Level Security & Access Permissions
-- Rows are strictly append-only; only the server-side service role may insert or read.
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

-- Explicitly revoke all privileges from client roles
REVOKE ALL ON TABLE public.admin_audit_log FROM anon, authenticated;

-- Grant full table access exclusively to service_role
GRANT ALL ON TABLE public.admin_audit_log TO service_role;

-- 4. Append-Only Enforcement Comment & Trigger
-- Rows in public.admin_audit_log must never be modified or deleted.
COMMENT ON TABLE public.admin_audit_log IS
  'Append-only administrative audit log. Updates and deletes are prohibited by trigger tr_prevent_admin_audit_log_mutation.';

CREATE OR REPLACE FUNCTION public.prevent_admin_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log rows are strictly append-only; UPDATE and DELETE operations are prohibited';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tr_prevent_admin_audit_log_mutation ON public.admin_audit_log;
CREATE TRIGGER tr_prevent_admin_audit_log_mutation
  BEFORE UPDATE OR DELETE ON public.admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION public.prevent_admin_audit_log_mutation();
