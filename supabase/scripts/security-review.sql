-- ==============================================================================
-- DO NOT APPLY / REVIEW PENDING — RAW TABLE ACCESS REVOCATION & ROLLBACK
-- CareerMonke (Carrier-hound) — Database Security Audit & Permissions
-- File: supabase/scripts/security-review.sql
-- Status: UNDER REVIEW — DO NOT RUN ON LIVE PRODUCTION DATABASE
--
-- PURPOSE:
-- Restricts client-side access on raw public.jobs table.
-- Public clients MUST read through public.jobs_public view only.
--
-- AUDIT CONSTRAINTS SATISFIED:
-- - ZERO policy drops.
-- - ZERO RPC drops (get_jobs_with_facets confirmed absent on live database).
-- - Strictly REVOKE statements on raw public.jobs plus a rollback GRANT section.
-- ==============================================================================

-- ------------------------------------------------------------------------------
-- 1. REVOKE ALL PERMISSIONS ON RAW public.jobs FROM anon AND authenticated
-- ------------------------------------------------------------------------------
REVOKE ALL ON TABLE public.jobs FROM anon;
REVOKE ALL ON TABLE public.jobs FROM authenticated;

-- Ensure SELECT is specifically revoked even if granted by default
REVOKE SELECT ON TABLE public.jobs FROM anon;
REVOKE SELECT ON TABLE public.jobs FROM authenticated;


-- ------------------------------------------------------------------------------
-- 2. ROLLBACK SECTION (DO NOT RUN UNLESS RESTORING PREVIOUS STATE)
-- ------------------------------------------------------------------------------
-- If rollback of the paid-data lock is ever required by business decision,
-- run the following statement to restore default Supabase client permissions:
--
-- GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.jobs TO authenticated;
-- GRANT SELECT ON TABLE public.jobs TO anon;
