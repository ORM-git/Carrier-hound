create table if not exists public.plans (
  code text primary key,
  name text not null,
  duration_days int not null,
  price_paise int not null,
  resume_quota int not null,
  cover_letter_quota int not null,
  quota_period_days int not null default 30,
  daily_generation_cap int not null default 30,
  sort_order int not null default 0,
  is_active boolean not null default true
);
insert into public.plans (code, name, duration_days, price_paise, resume_quota, cover_letter_quota, quota_period_days, sort_order) values
  ('weekly', 'Weekly', 7, 49900, 15, 15, 7, 1),
  ('monthly', 'Monthly', 30, 149900, 60, 60, 30, 2),
  ('quarterly', 'Quarterly', 90, 399900, 60, 60, 30, 3)
on conflict (code) do nothing;

create table if not exists public.addon_packs (
  code text primary key,
  price_paise int not null,
  sets int not null,
  validity_days int not null default 60,
  is_active boolean not null default true
);
insert into public.addon_packs (code, price_paise, sets) values
  ('addon_10', 14900, 10), ('addon_30', 39900, 30), ('addon_60', 69900, 60)
on conflict (code) do nothing;

create table if not exists public.user_addon_credits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  pack_code text not null references public.addon_packs(code),
  sets_total int not null,
  sets_remaining int not null check (sets_remaining >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists addon_credits_user_expiry on public.user_addon_credits (user_id, expires_at);

create table if not exists public.plan_usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('resume_tailor','cover_letter')),
  source text not null check (source in ('plan','addon')),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index if not exists plan_usage_user_time on public.plan_usage_events (user_id, created_at);

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null default 'razorpay',
  provider_order_id text unique,
  plan_code text references public.plans(code),
  addon_code text references public.addon_packs(code),
  amount_paise int not null,
  currency text not null default 'INR',
  status text not null default 'created' check (status in ('created','paid','failed','expired')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);alter table public.plans enable row level security;
alter table public.addon_packs enable row level security;
alter table public.user_addon_credits enable row level security;
alter table public.plan_usage_events enable row level security;
alter table public.payment_orders enable row level security;
create policy "plans readable by all" on public.plans for select using (true);
create policy "addon packs readable by all" on public.addon_packs for select using (true);
create policy "users read own addon credits" on public.user_addon_credits for select using (auth.uid() = user_id);
create policy "users read own plan usage" on public.plan_usage_events for select using (auth.uid() = user_id);
create policy "users read own orders" on public.payment_orders for select using (auth.uid() = user_id);
-- no client write policies: all writes go through the service role
