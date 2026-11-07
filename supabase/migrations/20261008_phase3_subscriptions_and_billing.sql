-- ==============================================================================
-- PHASE 3: BILLING — RAZORPAY + STRIPE SUBSCRIPTIONS & DUNNING
-- CareerMonke / Career Hound v2.0
-- Domestic (Rs 199/month) + International ($9/month), webhooks, grace period, dunning.
-- ==============================================================================

-- 1. Subscriptions Table
CREATE TABLE IF NOT EXISTS subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('razorpay', 'stripe', 'manual')),
  customer_id TEXT,
  subscription_id TEXT,
  plan_id TEXT NOT NULL DEFAULT 'domestic_monthly_199',
  currency TEXT NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR', 'GBP')),
  amount INT NOT NULL DEFAULT 19900, -- in smallest currency unit (paise or cents)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'trialing', 'in_grace_period', 'past_due', 'canceled', 'unpaid')),
  current_period_start TIMESTAMPTZ DEFAULT NOW(),
  current_period_end TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
  grace_period_end TIMESTAMPTZ, -- Set on payment failure (7 days grace)
  cancel_at_period_end BOOLEAN DEFAULT FALSE,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT subscriptions_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_provider ON subscriptions(provider, subscription_id);

-- 2. Dunning & Renewal Failure Audit Table
CREATE TABLE IF NOT EXISTS dunning_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  subscription_id TEXT,
  event_type TEXT NOT NULL,
  failure_reason TEXT,
  attempt_count INT DEFAULT 1,
  grace_period_expires_at TIMESTAMPTZ,
  dunning_email_queued BOOLEAN DEFAULT TRUE,
  dunning_email_sent_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dunning_logs_user_id ON dunning_logs(user_id);

-- Enable Row Level Security
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE dunning_logs ENABLE ROW LEVEL SECURITY;

-- Users can view their own subscription
CREATE POLICY "Users can view own subscription"
  ON subscriptions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Service role full access for webhook handlers
CREATE POLICY "Service role full access to subscriptions"
  ON subscriptions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access to dunning logs"
  ON dunning_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- ROLLBACK (run manually in the Supabase SQL editor if this must be undone):
--   DROP INDEX IF EXISTS public.idx_subscriptions_user_id;
--   DROP INDEX IF EXISTS public.idx_subscriptions_status;
--   DROP INDEX IF EXISTS public.idx_subscriptions_provider;
--   DROP INDEX IF EXISTS public.idx_dunning_logs_user_id;
--   ALTER TABLE public.subscriptions DISABLE ROW LEVEL SECURITY;
--   ALTER TABLE public.dunning_logs DISABLE ROW LEVEL SECURITY;
--   DROP TABLE IF EXISTS public.subscriptions CASCADE;
--   DROP TABLE IF EXISTS public.dunning_logs CASCADE;
-- ============================================================================
