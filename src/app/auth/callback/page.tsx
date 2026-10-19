"use client";

import React, { useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getValidReturnUrl } from "@/lib/auth/session";

function AuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    let resolved = false;
    const next = getValidReturnUrl(searchParams.get("next"), "/onboarding");
    const supabase = createClient();

    const finish = (destination: string) => {
      if (!resolved) {
        resolved = true;
        router.replace(destination);
      }
    };

    // 1. Listen for auth state changes (automatically catches hash token / magic link)
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event: any, session: any) => {
      if (session && (event === "SIGNED_IN" || event === "INITIAL_SESSION" || event === "TOKEN_REFRESHED")) {
        finish(next);
      }
    });

    const handleAuth = async () => {
      const code = searchParams.get("code");

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
      const { data: { session } } = await supabase.auth.getSession();
      if (session) {
        finish(next);
        return;
      }

      // 4. If window has hash (e.g. #access_token=... from magic link), give it 2 seconds to complete
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
  }, [router, searchParams]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="text-center space-y-3">
        <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
        <p className="text-xs font-semibold text-slate-500">Signing you in to CareerMonke…</p>
      </div>
    </div>
  );
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <AuthCallbackContent />
    </Suspense>
  );
}
