# Free trial design note (Backend sheet row: Free Trial)

Status: design note only. No code, no migration, no route, no pricing change. Payments stay off.
The row stays MISSING. Nothing here is a decision; every number and rule below is an open question for
the owner.

## What exists today (repo evidence)

- Three paid plans in `PLAN_DEFINITIONS` (`src/lib/billing/quota.ts`): weekly, monthly, quarterly. The
  weekly plan is the cheap try-out the sheet mentions. The DB `plans` table matches the code after
  `20261103e_weekly_price_692.sql`.
- The order route (`src/app/api/billing/razorpay/order/route.ts`) resolves the price server-side and
  ignores any client amount. There is no zero-amount or trial path.
- `subscriptions.status` already allows `trialing` (`20261008_phase3_subscriptions_and_billing.sql`), and
  `src/lib/billing/subscription.ts` already treats `trialing` like `active` until `current_period_end`.
  `src/lib/account/deleteHandler.ts` also handles `trialing`. So the status exists, but nothing creates it.
- `subscriptions` has one row per user (`subscriptions_user_unique`). A trial would reuse that row.
- `docs/PRODUCT_BLUEPRINT_AND_ROADMAP.md` mentions a "free trial cover letter" in the free tier. That is a
  product idea, not an implemented mechanic.

## Decisions the owner has to make first

| Question | Why it matters |
| --- | --- |
| Is a trial wanted at all, given the weekly plan? | Changes revenue and support load |
| Trial length and what is included (quota per day, per trial) | Sets AI cost exposure; no number is proposed here |
| Card required up front, or no card? | Drives abuse risk and Razorpay setup (mandates vs one-time orders) |
| One trial per account, per email, per device? | Defines the abuse rules below |
| What happens at trial end: auto-charge, or ask to subscribe? | Auto-charge needs recurring mandates, which this repo does not implement |

## Shape of a possible implementation (for later, not now)

1. Grant: a service-role-only function sets `subscriptions.status = 'trialing'` with a `current_period_end`
   the owner chooses. No payment order is created.
2. Entitlement: `subscription.ts` already honors `trialing` until `current_period_end`; quota for a trial
   would need its own `PlanDefinition` or a flag (owner decides the numbers).
3. Once-only: the per-user unique row blocks a second grant for the same account. It does not stop a new
   account with a new email, so abuse limits (disposable-email checks, rate limits) are a separate decision.
4. End: the existing expiry check in `subscription.ts` already treats an expired `trialing` row as expired.
5. Audit: write a history row for each grant, failing open like other audit inserts.
6. Tests: an offline test for the grant function and the expiry path, plus a reconcile check that a
   `trialing` row has a non-null `current_period_end`.

## Risks to settle before building

- AI cost abuse through throwaway accounts. Needs a hard per-trial cap that the owner sets.
- Trial rows must not be counted as revenue anywhere (`reconcile.ts` compares paid orders to subscriptions;
  a trial row has no order, so it would need an explicit rule).
- A trial must not turn on any payment path while payments are off.

## What stays unproven

- No trial mechanic exists, and nothing here has been run. The row stays MISSING.

## Owner steps (for the keeper's Doc)

1. Decide whether to offer a trial and answer the questions above (length, included usage, card or no card,
   abuse rule, end-of-trial behavior).
2. Only after that, approve a code PR, and decide when payments get turned on.
