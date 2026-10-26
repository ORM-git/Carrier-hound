"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getValidReturnUrl } from "@/lib/auth/session";
import BrandIcon from "@/components/BrandIcon";
import { Card } from "@/components/ui/card";
import { Loader2 } from "lucide-react";

export default function AuthCallbackPage() {
  const router = useRouter();

  useEffect(() => {
    let resolved = false;

    // Read search params via window.location (safe for static export)
    const search = typeof window !== "undefined" ? window.location.search : "";
    const params = new URLSearchParams(search);
    const next = getValidReturnUrl(
      params.get("returnTo") || params.get("return_to") || params.get("next"),
      "/onboarding"
    );
    const code = params.get("code");

    const supabase = createClient();

    const finish = (destination: string) => {
      if (!resolved) {
        resolved = true;
        router.replace(destination);
      }
    };

    // 1. Listen for auth state changes (automatically catches hash token / magic link)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: any, session: any) => {
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED")) {
        finish(next);
      }
    });

    const handleAuth = async () => {
      // 2. PKCE code exchange
      if (code) {
        const { error } = await supabase.auth.exchangeCodeForSession(code);
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
      if (session) {
        finish(next);
        return;
      }

      // 4. If window has hash (e.g. #access_token=... from magic link), give it 1.5 seconds to complete
      if (typeof window !== "undefined" && window.location.hash.includes("access_token")) {
        setTimeout(() => {
          supabase.auth.getSession().then(({ data }: any) => {
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
      setTimeout(() => {
        if (!resolved) {
          finish(`/login?error=${encodeURIComponent("Could not authenticate session. Please try again.")}`);
        }
      }, 1000);
    };

    handleAuth();

    return () => {
      subscription.unsubscribe();
    };
  }, [router]);

  return (
    <div
      data-testid="auth-callback-container"
      className="min-h-screen bg-surface-subtle flex flex-col items-center justify-center p-6 text-ink font-sans"
    >
      <Card
        variant="surface"
        className="w-full max-w-sm p-8 text-center space-y-4 shadow-tk-sm border border-line"
      >
        <div className="w-14 h-14 rounded-tk-xl bg-surface-muted border border-line flex items-center justify-center mx-auto p-2">
          <BrandIcon className="w-10 h-10" />
        </div>
        <div className="space-y-1.5">
          <Loader2 className="w-6 h-6 text-brand-600 animate-spin mx-auto" />
          <h1 className="text-tk-body font-bold text-ink">Signing you in to CareerMonke…</h1>
          <p className="text-tk-caption text-ink-muted">
            Verifying your secure credentials. This only takes a moment.
          </p>
        </div>
      </Card>
    </div>
  );
}
