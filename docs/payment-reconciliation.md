# Payment reconciliation report (Backend sheet row: Payment Reconciliation)

Status: read-only report. Not scheduled, not run by CI, no writes, no payment-provider call.
Payments stay off; this changes nothing about checkout.

Run (owner, with service-role env): `npx tsx scripts/report-payment-reconciliation.ts --stale-created-hours <n>`
Exit 0 = no findings, 1 = findings, 2 = env or argument missing.

## What it checks (DB orders vs DB entitlements)

- `paid_plan_order_without_subscription`: a paid plan order whose user has no `subscriptions` row.
- `paid_addon_order_without_credit`: a paid add-on order with no `user_addon_credits` row whose
  `order_id` is that order (the link and unique index come from 20261103c).
- `credit_linked_to_unpaid_order`: a credit row whose order is not `paid`.
- `stale_created_order`: an order still `created` after N hours. N is a required argument with no
  default (owner to confirm).

Pieces: `src/lib/billing/reconcile.ts` (pure logic), `scripts/report-payment-reconciliation.ts`
(GET-only reader), `scripts/test-payment-reconciliation.ts` (offline, registered).

## What it does NOT do (unproven or owner work)

- No comparison with the provider's settlement records (no Razorpay API call). A payment the
  provider has but the DB never recorded is not detectable here.
- `subscriptions` is one row per user, so it cannot show that every past plan order extended the
  period; only that a row exists. Checking plan or period against the latest order is not done.
- Never run against live data by this change. Whether the live tables match the migrations is
  unproven. No schedule or alert is wired (owner decision).
