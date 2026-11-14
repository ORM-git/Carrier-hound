"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getValidReturnUrl } from "@/lib/auth/session";
import { clearCandidateProfileMemoryCache } from "@/lib/resume/storage";
import { trackFunnelEvent } from "@/lib/analytics/funnel";
import BrandIcon from "@/components/BrandIcon";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    let resolved = false;
    let cancelled = false;

    // Read search params via window.location (safe for static export)
    const search = typeof window !== "undefined" ? window.location.search : "";
    const params = new URLSearchParams(search);
    const next = getValidReturnUrl(
      params.get("returnTo") || params.get("return_to") || params.get("next"),
      "/dashboard"
    );
    const code = params.get("code");

    const supabase = createClient();

    const finish = (destination: string) => {
      if (!cancelled && !resolved) {
        resolved = true;
        clearCandidateProfileMemoryCache();
        if (typeof window !== "undefined") {
          try {
            localStorage.removeItem("careermonke_candidate_profile");
          } catch {}
        }
        router.replace(destination);
      }
    };

    // 1. Listen for auth state changes (automatically catches hash token / magic link)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: any, session: any) => {
      if (cancelled || resolved) return;
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED")) {
        if (event === "SIGNED_IN") {
          trackFunnelEvent("signup_completed", { path: "/auth/callback" });
        }
        finish(next);
      }
    });

    let hashTimeoutId: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleAuth = async () => {
      // 2. PKCE code exchange
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (cancelled || resolved) return;
        if (!error) {
          finish(next);
          return;
        }
        console.error("[Auth Callback] exchangeCodeForSession error:", error.message || error);
        const safeErrorMessage = error.message || "Could not authenticate session. Please try again.";
        finish(`/login?error=${encodeURIComponent(safeErrorMessage)}`);
        return;
      }

      // 3. Check existing active session
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled || resolved) return;
      if (session) {
        finish(next);
        return;
      }

      // 4. If window has hash (e.g. #access_token=... from magic link), give it 1.5 seconds to complete
      if (typeof window !== "undefined" && window.location.hash.includes("access_token")) {
        if (cancelled || resolved) return;
        hashTimeoutId = setTimeout(() => {
          if (cancelled || resolved) return;
          supabase.auth.getSession().then(({ data }: any) => {
            if (cancelled || resolved) return;
            const hashSession = data?.session;
            if (hashSession) {
              finish(next);
            } else {
              finish(`/login?error=${encodeURIComponent("Could not authenticate magic link. Please try again.")}`);
            }
          });
        }, 1500);
        return;
      }

      // Fallback
      if (cancelled || resolved) return;
      fallbackTimeoutId = setTimeout(() => {
        if (!cancelled && !resolved) {
          finish(`/login?error=${encodeURIComponent("Could not authenticate session. Please try again.")}`);
        }
      }, 1000);
    };

    handleAuth();

    return () => {
      cancelled = true;
      resolved = true;
      if (hashTimeoutId !== null) clearTimeout(hashTimeoutId);
      if (fallbackTimeoutId !== null) clearTimeout(fallbackTimeoutId);
      subscription.unsubscribe();
    };
  }, [router]);

  return (
    <div
      data-testid="auth-callback-container"
      className="min-h-screen bg-surface-subtle flex flex-col items-center justify-between p-6 text-ink font-sans"
    >
      <div />
      <Card
        variant="surface"
        className="w-full max-w-sm p-8 text-center space-y-4 shadow-tk-sm border border-line"
      >
        <div className="w-14 h-14 rounded-tk-xl bg-surface-muted border border-line flex items-center justify-center mx-auto p-2">
          <BrandIcon className="w-10 h-10" />
        </div>
        <div className="space-y-1.5" role="status" aria-label="Signing you in">
          <Loader2 aria-hidden="true" className="w-6 h-6 text-brand-600 animate-spin mx-auto" />
          <h1 className="text-tk-body font-bold text-ink">Signing you in to CareerMonke…</h1>
          <p className="text-tk-caption text-ink-muted">
            Verifying your secure credentials. This only takes a moment.
          </p>
        </div>
      </Card>
      <footer className="py-2 text-center text-xs text-ink-subtle">
        © 2026 Olive Ridley Media Private Limited. All rights reserved.
      </footer>
    </div>
  );
}
