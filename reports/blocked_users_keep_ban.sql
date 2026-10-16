-- ==============================================================================
-- owner runs in Supabase SQL Editor; agent does not run it
-- ==============================================================================
-- Title: Migration to decouple blocked_users from auth.users ON DELETE CASCADE
-- Context: In the baseline schema (20261011_admin_page_views_and_blocked_users.sql),
--          blocked_users has:
--            user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
--          When an admin deletes a user via Supabase Dashboard/API, the cascade
--          destroys the ban row, allowing ban evasion via re-registration.
-- Objective:
--   1. Backup existing blocked_users table to blocked_users_backup_<date>.
--   2. Introduce surrogate primary key (id UUID PRIMARY KEY DEFAULT gen_random_uuid()).
--   3. Alter user_id foreign key constraint to ON DELETE SET NULL (or retain user_id
--      without hard CASCADE).
--   4. Ensure email is NOT NULL and uniquely indexed for persistent moderation.
-- ==============================================================================

BEGIN;

-- 1. Backup existing blocked_users table
CREATE TABLE IF NOT EXISTS public.blocked_users_backup_20261015 AS 
SELECT * FROM public.blocked_users;

-- 2. Drop existing foreign key and primary key constraints
ALTER TABLE public.blocked_users 
  DROP CONSTRAINT IF EXISTS blocked_users_pkey CASCADE;

ALTER TABLE public.blocked_users 
  DROP CONSTRAINT IF EXISTS blocked_users_user_id_fkey;

-- 3. Add surrogate primary key
ALTER TABLE public.blocked_users 
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT gen_random_uuid();

-- Populate existing rows where id might be null
UPDATE public.blocked_users 
SET id = gen_random_uuid() 
WHERE id IS NULL;

ALTER TABLE public.blocked_users 
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.blocked_users 
  ADD CONSTRAINT blocked_users_pkey PRIMARY KEY (id);

-- 4. Allow user_id to become NULL when auth user is deleted
ALTER TABLE public.blocked_users 
  ALTER COLUMN user_id DROP NOT NULL;

-- 5. Re-add foreign key constraint with ON DELETE SET NULL
ALTER TABLE public.blocked_users 
  ADD CONSTRAINT blocked_users_user_id_fkey 
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 6. Ensure email is unique across active bans to prevent duplicate ban records
CREATE UNIQUE INDEX IF NOT EXISTS idx_blocked_users_email_unique 
  ON public.blocked_users(lower(email));

-- 7. Update RLS policies to support the modified schema
DROP POLICY IF EXISTS "Allow users or admin to read blocked_users" ON public.blocked_users;
CREATE POLICY "Allow users or admin to read blocked_users"
    ON public.blocked_users FOR SELECT
    USING (
        (user_id IS NOT NULL AND auth.uid() = user_id) 
        OR auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

DROP POLICY IF EXISTS "Allow admin to modify blocked_users" ON public.blocked_users;
CREATE POLICY "Allow admin to modify blocked_users"
    ON public.blocked_users FOR ALL
    USING (
        auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

COMMIT;

-- ==============================================================================
-- ROLLBACK SECTION (Run if migration encounters errors or needs to be reverted)
-- ==============================================================================
/*
BEGIN;

DROP TABLE IF EXISTS public.blocked_users CASCADE;

CREATE TABLE public.blocked_users (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    reason TEXT DEFAULT 'Violation of Terms or Suspicious Activity',
    blocked_by TEXT DEFAULT 'admin',
    blocked_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Restore rows from backup
INSERT INTO public.blocked_users (user_id, email, reason, blocked_by, blocked_at)
SELECT user_id, email, reason, blocked_by, blocked_at
FROM public.blocked_users_backup_20261015
WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blocked_users_email ON public.blocked_users(email);
CREATE INDEX IF NOT EXISTS idx_blocked_users_blocked_at ON public.blocked_users(blocked_at DESC);

ALTER TABLE public.blocked_users ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow users or admin to read blocked_users"
    ON public.blocked_users FOR SELECT
    USING (
        auth.uid() = user_id OR auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

CREATE POLICY "Allow admin to modify blocked_users"
    ON public.blocked_users FOR ALL
    USING (
        auth.jwt() ->> 'email' = 'xbsuryakant@gmail.com'
    );

COMMIT;
*/
