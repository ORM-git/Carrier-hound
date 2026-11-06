# Push notifications (INTERNAL)

Backend sheet rank 13: no web push exists today, which is fine pre-PWA.
This is the repo-side scaffolding so the remaining work is a product
decision, not a design exercise. Nothing here is user-visible; no service
worker, no UI, and no provider account ships in this change.

## What exists now

- `supabase/migrations/20261106i_push_subscriptions.sql` - subscription
  storage (endpoint, p256dh, auth keys, user agent, revoke timestamp),
  RLS scoped to the owning user, service role bypasses for the future
  dispatcher. NOT APPLIED: owner applies in the Supabase SQL editor, then
  records it with
  `node scripts/record-migration.cjs 20261106i_push_subscriptions`.
  Rollback: `DROP TABLE IF EXISTS public.push_subscriptions;`
- `src/lib/notifications/webPush.ts` - the sender contract:
  `PushProvider.send(subscription, message)`, with `NoopPushProvider` as
  the only implementation until activation. `getPushProvider()` returns
  the noop unless the VAPID env vars are set.

## Activation checklist (all owner decisions)

1. Product decision: notification types, cadence, and opt-in UX. This
   requires UI (permission prompt, settings toggle) which is out of scope
   for backend scaffolding.
2. Generate VAPID keys (`npx web-push generate-vapid-keys` locally) and
   store them as `WEB_PUSH_VAPID_PUBLIC_KEY` /
   `WEB_PUSH_VAPID_PRIVATE_KEY` env vars (vault; never in the repo). The
   public key is also needed client-side when the UI lands.
3. Add the `web-push` npm dependency. package-lock.json cannot be updated
   through the GitHub web UI (too large), so the install is an owner-side
   step.
4. Apply the migration above, then record it.
5. Replace the noop with a `WebPushProtocolProvider` in
   `getPushProvider()` and add the service worker + opt-in UI.

## Non-goals for now

- No paid push service (OneSignal etc.); the browser-native Web Push
  protocol is free and sufficient at current scale.
- No notification content decisions; customer-facing copy is untouched.
