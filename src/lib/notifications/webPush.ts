/**
 * Web Push adapter scaffolding (Backend sheet rank 13, docs/push-notifications.md).
 *
 * Repo-side only: the subscription table migration
 * (20261106i_push_subscriptions.sql) is NOT APPLIED, no service worker or UI
 * ships, and no push provider account exists yet. This module fixes the
 * contract the future sender implements so the product decision is the only
 * remaining step.
 *
 * The concrete WebPushProtocolProvider is intentionally not implemented:
 * the Web Push protocol needs VAPID signing (ES256 JWT + ECDH payload
 * encryption), which should come from the `web-push` npm package once the
 * owner approves adding the dependency (package-lock update is an owner
 * step). Until then, getPushProvider() returns the noop provider, which is
 * what every caller gets today.
 */

export interface PushMessage {
  title: string;
  body: string;
  /** Relative URL opened when the notification is clicked. */
  url?: string;
  /** Opaque correlation id for dedupe/analytics. */
  tag?: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushSendResult =
  | { ok: true }
  | { ok: false; reason: "revoked" | "provider_error"; detail?: string };

export interface PushProvider {
  send(subscription: PushSubscriptionKeys, message: PushMessage): Promise<PushSendResult>;
}

/** Default provider until VAPID keys + the web-push dependency land. */
export class NoopPushProvider implements PushProvider {
  async send(): Promise<PushSendResult> {
    return { ok: false, reason: "provider_error", detail: "web push not configured" };
  }
}

export function getPushProvider(): PushProvider {
  // VAPID env vars are the activation switch documented in
  // docs/push-notifications.md; absent keys mean the feature is off.
  if (!process.env.WEB_PUSH_VAPID_PUBLIC_KEY || !process.env.WEB_PUSH_VAPID_PRIVATE_KEY) {
    return new NoopPushProvider();
  }
  // Owner decision pending: wire the web-push package here once approved.
  return new NoopPushProvider();
}
