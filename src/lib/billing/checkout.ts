import { createClient } from "../supabase/client";
import { openRazorpayCheckout, openRazorpaySubscription as openRazorpaySubscriptionGateway } from "./razorpay";
import type { AutoRenewConsent } from "./types";

export interface CheckoutResult {
  success: boolean;
  error?: string;
}

/**
 * High-level Pro checkout orchestrator.
 * 1. Verifies visitor authentication state:
 *    - If signed out: redirects to /login?next=... to sign in first.
 * 2. For signed-in users:
 *    - Executes real Razorpay checkout with server-authoritative order creation and verification.
 * 3. On success:
 *    - Navigates past the paywall to the unlocked Pro experience.
 */
export async function handleProCheckout(
  options: {
    planCode?: string;
    addonCode?: string;
    redirectTarget?: string;
    onStart?: () => void;
    onError?: (errorMsg: string) => void;
    onSuccess?: () => void;
    onDismiss?: () => void;
  } = {}
) {
  const {
    planCode = options.addonCode ? undefined : "monthly",
    addonCode,
    redirectTarget,
    onStart,
    onError,
    onSuccess,
    onDismiss,
  } = options;

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || (await supabase.auth.getUser()).data.user;

  const currentPath = typeof window !== "undefined"
    ? window.location.pathname + window.location.search
    : "/jobs";
  const target = redirectTarget || currentPath;

  // 1. If visitor is NOT signed in, send them through sign-in first
  if (!user) {
    const loginUrl = `/login?next=${encodeURIComponent(target)}`;
    if (typeof window !== "undefined") {
      window.location.href = loginUrl;
    }
    return;
  }

  onStart?.();

  // 2. Open Razorpay checkout modal
  await openRazorpayCheckout({
    planCode,
    addonCode,
    authToken: session?.access_token,
    userEmail: user.email,
    userName: user.user_metadata?.full_name,
    onSuccess: () => {
      onSuccess?.();
      if (typeof window !== "undefined") {
        window.location.href = target;
      }
    },
    onError: (err: any) => {
      onError?.(err?.message || "Payment processing failed. Please try again.");
    },
    onDismiss: () => {
      onDismiss?.();
    },
  });
}

/**
 * High-level Auto-Renew Subscription checkout orchestrator.
 * 1. Checks NEXT_PUBLIC_AUTORENEW_ENABLED and NEXT_PUBLIC_BILLING_ENABLED flags.
 * 2. Verifies authentication state (redirects to /login if signed out).
 * 3. Opens Razorpay modal in subscription mode.
 * 4. Unreachable when the auto-renew flag is off.
 */
export async function openRazorpaySubscription(
  options: {
    planCode?: string;
    consent?: AutoRenewConsent;
    redirectTarget?: string;
    onStart?: () => void;
    onError?: (errorMsg: string) => void;
    onSuccess?: () => void;
    onDismiss?: () => void;
  } = {}
) {
  if (
    process.env.NEXT_PUBLIC_AUTORENEW_ENABLED !== "true" ||
    process.env.NEXT_PUBLIC_BILLING_ENABLED !== "true"
  ) {
    options.onError?.("Auto-renew subscriptions are currently disabled.");
    return;
  }

  const {
    planCode = "monthly",
    consent,
    redirectTarget,
    onStart,
    onError,
    onSuccess,
    onDismiss,
  } = options;

  if (!consent || !consent.agreed) {
    options.onError?.("Explicit auto-renew consent is required to create a subscription.");
    return;
  }

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || (await supabase.auth.getUser()).data.user;

  const currentPath = typeof window !== "undefined"
    ? window.location.pathname + window.location.search
    : "/pricing";
  const target = redirectTarget || currentPath;

  if (!user) {
    const loginUrl = `/login?next=${encodeURIComponent(target)}`;
    if (typeof window !== "undefined") {
      window.location.href = loginUrl;
    }
    return;
  }

  onStart?.();

  await openRazorpaySubscriptionGateway({
    planCode,
    consent,
    authToken: session?.access_token,
    userEmail: user.email,
    userName: user.user_metadata?.full_name,
    onSuccess: () => {
      onSuccess?.();
      if (typeof window !== "undefined") {
        window.location.href = target;
      }
    },
    onError: (err: any) => {
      onError?.(err?.message || "Subscription processing failed. Please try again.");
    },
    onDismiss: () => {
      onDismiss?.();
    },
  });
}
