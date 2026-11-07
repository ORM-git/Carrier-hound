-- ==============================================================================
-- Migration: Admin Analytics (page_views) & User Moderation (blocked_users)
-- ==============================================================================

-- 1. Create page_views table for lightweight non-blocking page-view tracking
CREATE TABLE IF NOT EXISTS public.page_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    path TEXT NOT NULL,
    user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    referrer TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Performance indexes for analytics aggregation
CREATE INDEX IF NOT EXISTS idx_page_views_path ON public.page_views(path);
CREATE INDEX IF NOT EXISTS idx_page_views_created_at ON public.page_views(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_page_views_user_id ON public.page_views(user_id);
CREATE INDEX IF NOT EXISTS idx_page_views_ip_hash ON public.page_views(ip_hash);

-- Enable Row Level Security
ALTER TABLE public.page_views ENABLE ROW LEVEL SECURITY;

-- Allow anonymous or authenticated clients to INSERT page views (fire-and-forget logging)
DROP POLICY IF EXISTS "Allow public insert to page_views" ON public.page_views;
CREATE POLICY "Allow public insert to page_views"
    ON public.page_views FOR INSERT
    WITH CHECK (true);

-- Allow ONLY admin email xbsuryakant@gmail.com to SELECT page_views
DROP POLICY IF EXISTS "Allow admin to select page_views" ON public.page_views;
CREATE POLICY "Allow admin to select page_views"
    ON public.page_views FOR SELECT
    USING (
        auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

-- 2. Create blocked_users table for immediate server-side revocation and moderation
CREATE TABLE IF NOT EXISTS public.blocked_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    reason TEXT DEFAULT 'Violation of Terms or Suspicious Activity',
    blocked_by TEXT DEFAULT 'admin',
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Indexes for fast moderation lookup
CREATE INDEX IF NOT EXISTS idx_blocked_users_email ON public.blocked_users(email);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_at ON public.blocked_users(blocked_at DESC);

-- Enable Row Level Security
ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

-- Allow users to read their own blocked status or admin to read all
DROP POLICY IF EXISTS "Allow users or admin to read blocked_users" ON public.blocked_users;
CREATE POLICY "Allow users or admin to read blocked_users"
    ON public.blocked_users FOR SELECT
    USING (
        auth.uid() = user_id OR auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

-- Allow ONLY admin to insert, update, or delete blocked_users
DROP POLICY IF EXISTS "Allow admin to modify blocked_users" ON public.blocked_users;
CREATE POLICY "Allow admin to modify blocked_users"
    ON public.blocked_users FOR ALL
    USING (
        auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP POLICY IF EXISTS "Allow public insert to page_views" ON public.page_views;
--   DROP POLICY IF EXISTS "Allow admin to select page_views" ON public.page_views;
--   DROP POLICY IF EXISTS "Allow users or admin to read blocked_users" ON public.blocked_users;
--   DROP POLICY IF EXISTS "Allow admin to modify blocked_users" ON public.blocked_users;
--   DROP INDEX IF EXISTS public.idx_page_views_path;
--   DROP INDEX IF EXISTS public.idx_page_views_created_at;
--   DROP INDEX IF EXISTS public.idx_page_views_user_id;
--   DROP INDEX IF EXISTS public.idx_page_views_ip_hash;
--   DROP INDEX IF EXISTS public.idx_blocked_users_email;
--   DROP INDEX IF EXISTS public.idx_blocked_users_blocked_at;
--   ALTER TABLE public.page_views DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.blocked_users DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.page_views CASCADE;
--   DROP TABLE IF EXISTS public.blocked_users CASCADE;
-- ============================================================================
