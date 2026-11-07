-- ==============================================================================
-- PHASE 2: DAILY AUTOMATED CRON & DIGEST QUEUE
-- CareerMonke / Career Hound v1.2
-- Idempotent daily scans, deterministic match score queuing, and run audit logs.
-- ==============================================================================

-- 1. Cron Execution Audit Logs
CREATE TABLE IF NOT EXISTS cron_run_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL DEFAULT 'daily_job_scan_and_digest',
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
  jobs_scanned_count INT DEFAULT 0,
  new_jobs_count INT DEFAULT 0,
  digests_queued_count INT DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cron_run_logs_started_at ON cron_run_logs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_cron_run_logs_status ON cron_run_logs(status);

-- 2. Daily User Digests (Guaranteed Idempotent per User per Date)
CREATE TABLE IF NOT EXISTS daily_digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  digest_date DATE NOT NULL DEFAULT CURRENT_DATE,
  matched_jobs JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'viewed')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT daily_digests_user_date_unique UNIQUE (user_id, digest_date)
);

CREATE INDEX IF NOT EXISTS idx_daily_digests_user_date ON daily_digests(user_id, digest_date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_digests_status ON daily_digests(status);

-- Enable Row Level Security
ALTER TABLE cron_run_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_digests ENABLE ROW LEVEL SECURITY;

-- Candidates can view their own daily digests
CREATE POLICY "Users can view their own daily digests"
  ON daily_digests
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update their own digest status (mark viewed)"
  ON daily_digests
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Service role has full access
CREATE POLICY "Service role full access to cron logs"
  ON cron_run_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access to daily digests"
  ON daily_digests
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_cron_run_logs_started_at;
--   DROP INDEX IF EXISTS public.idx_cron_run_logs_status;
--   DROP INDEX IF EXISTS public.idx_daily_digests_user_date;
--   DROP INDEX IF EXISTS public.idx_daily_digests_status;
--   ALTER TABLE public.cron_run_logs DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.daily_digests DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.cron_run_logs CASCADE;
--   DROP TABLE IF EXISTS public.daily_digests CASCADE;
-- ============================================================================
