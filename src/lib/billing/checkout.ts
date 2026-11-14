import { createClient } from "../supabase/client";
import { openRazorpayCheckout } from "./razorpay";

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
  } = {}
) {
  const { planCode = options.addonCode ? undefined : "monthly", addonCode, redirectTarget, onStart, onError, onSuccess } = options;

  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || (await supabase.auth.getUser()).data.user;

  const currentPath = typeof window !== "undefined"
    ? window.location.pathname + window.location.search
    : "/dashboard";
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
  });
}
