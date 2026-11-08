# Coupon and discount code design note (Backend sheet row: Coupon / Discount Codes)

Status: design note only. No code, no migration, no route, no pricing change. Payments stay off.
The row stays MISSING. Nothing here is a decision; every number and rule is an open question for the owner.

## What exists today (repo evidence)

- The order route (`src/app/api/billing/razorpay/order/route.ts`) calls `resolveOrderPricing` and ignores any
  client-supplied amount. `scripts/test-netlify-billing.ts` asserts that a tampered client amount is ignored
  (weekly 69200 paise, monthly 149900 paise on current code). Any coupon must keep that rule: the server
  computes the final amount, never the client.
- `payment_orders` (`20261103_plans_addons_usage.sql`) stores `amount_paise` per order but no discount,
  coupon or list-price column.
- Orders and add-on credits are compared by `src/lib/billing/reconcile.ts`. It checks order status and
  linkage, not amounts, so a discounted order would not break it, but it also would not detect a wrong discount.
- There is no `coupons` or `redemptions` table, and no code references promo codes.

## Decisions the owner has to make first

| Question | Why it matters |
| --- | --- |
| Percent off, fixed amount off, or both? | Shapes the price function |
| Which plans and add-ons can a code apply to? | Add-ons need a Pro subscription already |
| Max uses per code, per user, and expiry? | Abuse and budget limits; no numbers proposed here |
| Stackable with other offers? | Simplest rule is no |
| Who creates codes: owner by SQL, or an admin screen? | An admin screen is a frontend and admin-route change |

## Shape of a possible implementation (for later, not now)

1. Tables (one migration, written but NOT applied, with a rollback block): `coupons` (code, kind, value,
   applies_to, max_redemptions, expires_at, active) and `coupon_redemptions` (coupon, user, order,
   created_at, unique on coupon + user when single-use). RLS on, no client write policy, service role only.
   Both tables would need rows in `docs/schema-drift-baseline.md` and `docs/data-classification.md`.
2. Pure function `applyCoupon(listPricePaise, coupon, nowMs)` in `src/lib/billing`, integer paise,
   rounding rule chosen by the owner, never below zero, with offline tests. Nothing else calls it until wired.
3. Wiring (separate PR, only when payments are on): the order route would look up the coupon, record the
   redemption in the same transaction as the order, and store the list price and discount on the order.
   This changes billing behavior and needs explicit owner approval.
4. Race safety: redemption count must be enforced in the database (a conditional insert or a lock), not by a
   read-then-write in the route.
5. Gateway: the amount sent to Razorpay is the discounted server-computed amount. Whether a 100% coupon
   skips the gateway is an owner decision (it would grant access with no payment, like a trial).

## What stays unproven

- Nothing exists to run. The row stays MISSING.

## Owner steps (for the keeper's Doc)

1. Answer the questions above (discount kinds, scope, limits, stacking, who creates codes).
2. Approve a migration PR (unapplied) and apply it by hand when ready.
3. Approve wiring into the order route together with the decision to turn payments on.
