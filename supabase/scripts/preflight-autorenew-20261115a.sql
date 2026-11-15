-- ==============================================================================
-- CareerMonke (Carrier-hound) — Read-Only Preflight Verification
-- Migration: 20261115a_autorenew.sql
-- File: supabase/scripts/preflight-autorenew-20261115a.sql
-- Status: READ-ONLY AUDIT SCRIPT FOR SUPABASE SQL EDITOR BEFORE RUNNING MIGRATION
--
-- STRICT ARCHITECTURAL CONSTRAINTS:
-- 1. Read-only queries (SELECT only, ZERO DDL, ZERO DML, ZERO side effects).
-- 2. Inspects installed function definitions, constraints, ACLs, and schema prerequisites.
-- ==============================================================================

-- 1. Function Definitions Check
-- Inspects installed versions of fulfil_payment_order, fulfil_subscription_renewal,
-- and handle_subscription_lifecycle_event.
SELECT
  p.proname AS function_name,
  pg_get_function_identity_arguments(p.oid) AS arguments,
  pg_get_functiondef(p.oid) AS function_definition
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('fulfil_payment_order', 'fulfil_subscription_renewal', 'handle_subscription_lifecycle_event')
ORDER BY p.proname;

-- 2. Constraints Check
-- Inspects primary keys, unique constraints, check constraints, and foreign keys
-- on public.subscriptions, public.payment_orders, and public.plans.
SELECT
  rel.relname AS table_name,
  con.conname AS constraint_name,
  con.contype AS constraint_type,
  pg_get_constraintdef(con.oid, true) AS constraint_definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
WHERE nsp.nspname = 'public'
  AND rel.relname IN ('subscriptions', 'payment_orders', 'plans', 'blocked_users', 'user_addon_credits', 'webhook_events')
ORDER BY rel.relname, con.conname;

-- 3. Function Privileges / ACL Check
-- Inspects privileges granted to service_role, anon, authenticated, and public.
SELECT
  routine_name,
  grantee,
  privilege_type,
  is_grantable
FROM information_schema.routine_privileges
WHERE routine_schema = 'public'
  AND routine_name IN ('fulfil_payment_order', 'fulfil_subscription_renewal', 'handle_subscription_lifecycle_event')
ORDER BY routine_name, grantee, privilege_type;

-- 4. Schema Column Existence & Types Check
-- Verifies required columns on payment_orders, subscriptions, and plans.
SELECT
  table_name,
  column_name,
  data_type,
  is_nullable,
  column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('subscriptions', 'payment_orders', 'plans')
  AND column_name IN (
    'id', 'user_id', 'subscription_id', 'plan_id', 'provider', 'status',
    'current_period_start', 'current_period_end', 'cancel_at_period_end',
    'grace_period_end', 'metadata', 'currency', 'amount',
    'provider_order_id', 'mode', 'plan_code', 'amount_paise', 'paid_at', 'code', 'price_paise', 'duration_days'
  )
ORDER BY table_name, ordinal_position;
