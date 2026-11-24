-- 20261124a: company_profile_facts allowlists gain source_kind 'wikidata' and fact_key 'funding_stage' (Step D). OWNER-RUN; the agent never applies migrations.
-- Only widens the company_profile_facts allowlists: source_kind 'wikidata' and fact_key 'funding_stage'.
-- Owner decisions 2026-11-24: News dropped (Google News robots.txt disallows /rss), H-1B skipped, Wikidata API allowed.
-- Leaders need no change: their source_url (https://www.wikidata.org/wiki/Q...) and retrieved_at already carry provenance.
-- The three single-column CHECK constraints are replaced with the same values plus the new ones; nothing else changes.

BEGIN;

-- Optional, look first:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.company_profile_facts'::regclass AND contype = 'c';

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
     WHERE c.conrelid = 'public.company_profile_facts'::regclass
       AND c.contype = 'c'
       AND array_length(c.conkey, 1) = 1
       AND a.attname IN ('fact_key', 'source_kind', 'conflict_source_kind')
  LOOP
    EXECUTE format('ALTER TABLE public.company_profile_facts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE public.company_profile_facts
  ADD CONSTRAINT company_profile_facts_fact_key_check CHECK (fact_key IN (
    'overview','website','headquarters','founded_year','employee_count_range','linkedin_url','twitter_url','funding_stage')),
  ADD CONSTRAINT company_profile_facts_source_kind_check CHECK (source_kind IN (
    'official_site','official_report','official_announcement','wikidata')),
  ADD CONSTRAINT company_profile_facts_conflict_source_kind_check CHECK (conflict_source_kind IS NULL OR conflict_source_kind IN (
    'official_site','official_report','official_announcement','wikidata'));

-- Read-only preflight the canary runs before any plan or row write: it refuses unless every CHECK listed here
-- allows 'funding_stage' / 'wikidata'. Catalog reads only; service_role only.
CREATE OR REPLACE FUNCTION public.company_profile_fact_allowlists()
RETURNS TABLE(column_name text, definition text)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT a.attname::text, pg_get_constraintdef(c.oid)
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
   WHERE c.conrelid = 'public.company_profile_facts'::regclass
     AND c.contype = 'c'
     AND array_length(c.conkey, 1) = 1
     AND a.attname IN ('fact_key', 'source_kind', 'conflict_source_kind')
$$;
REVOKE ALL ON FUNCTION public.company_profile_fact_allowlists() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.company_profile_fact_allowlists() TO service_role;

COMMIT;

-- Verify afterwards (read-only):
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid = 'public.company_profile_facts'::regclass AND contype = 'c' ORDER BY conname;

-- ROLLBACK (run manually, only after the Wikidata rows are gone, e.g. via the canary's journaled --rollback;
-- the original allowlists refuse any remaining 'wikidata' or 'funding_stage' row):
-- BEGIN;
-- DROP FUNCTION public.company_profile_fact_allowlists();
-- ALTER TABLE public.company_profile_facts DROP CONSTRAINT company_profile_facts_fact_key_check;
-- ALTER TABLE public.company_profile_facts DROP CONSTRAINT company_profile_facts_source_kind_check;
-- ALTER TABLE public.company_profile_facts DROP CONSTRAINT company_profile_facts_conflict_source_kind_check;
-- ALTER TABLE public.company_profile_facts ADD CONSTRAINT company_profile_facts_fact_key_check CHECK (fact_key IN ('overview','website','headquarters','founded_year','employee_count_range','linkedin_url','twitter_url'));
-- ALTER TABLE public.company_profile_facts ADD CONSTRAINT company_profile_facts_source_kind_check CHECK (source_kind IN ('official_site','official_report','official_announcement'));
-- ALTER TABLE public.company_profile_facts ADD CONSTRAINT company_profile_facts_conflict_source_kind_check CHECK (conflict_source_kind IS NULL OR conflict_source_kind IN ('official_site','official_report','official_announcement'));
-- COMMIT;
