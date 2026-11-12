-- ============================================================================
-- Migration: 20261112a_custom_domain_types.sql
-- STATUS: NOT APPLIED - record-migration.cjs 20261112a_custom_domain_types
--
-- Reusable PostgreSQL DOMAIN types for CareerMonke schema integrity.
-- Audit finding: Plain text columns with duplicated, drift-prone ad hoc CHECK
-- constraints for emails, slugs, and non-empty strings.
--
-- Introduces reusable DOMAIN types in public schema:
--   1. public.cm_email: Normalized lowercase, trimmed text, valid email format
--      matching app email normalization, max length 254 chars.
--   2. public.cm_non_empty_text: Text requiring length(trim(VALUE)) > 0,
--      preventing empty strings or whitespace-only inputs.
--   3. public.cm_slug: Normalized lowercase, non-empty text matching slug
--      pattern ^[a-z0-9]+(-[a-z0-9]+)*$, max length 120 chars.
--
-- Safety & non-breaking constraints:
--   - Contains ONLY CREATE DOMAIN statements.
--   - Does NOT alter, drop, or rewrite any existing table, column, CHECK,
--     function, or data.
--   - Adoption into existing columns is staged and out of scope for now.
--
-- ============================================================================
-- ROLLBACK INSTRUCTIONS (manual rollback if applied)
-- ============================================================================
-- To undo this migration (safe before columns adopt these domains):
--   DROP DOMAIN IF EXISTS public.cm_slug;
--   DROP DOMAIN IF EXISTS public.cm_non_empty_text;
--   DROP DOMAIN IF EXISTS public.cm_email;
-- ============================================================================

CREATE DOMAIN public.cm_email AS text
  CHECK (
    VALUE = lower(trim(VALUE))
    AND char_length(VALUE) <= 254
    AND position('@' in VALUE) > 1
    AND VALUE ~ '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'
  );

CREATE DOMAIN public.cm_non_empty_text AS text
  CHECK (length(trim(VALUE)) > 0);

CREATE DOMAIN public.cm_slug AS text
  CHECK (
    VALUE = lower(trim(VALUE))
    AND length(trim(VALUE)) > 0
    AND char_length(VALUE) <= 120
    AND VALUE ~ '^[a-z0-9]+(-[a-z0-9]+)*$'
  );
