"use client";

import React, { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import GuideHeader from "@/components/GuideHeader";
import Footer from "@/components/Footer";
import { createClient } from "@/lib/supabase/client";
import { getValidReturnUrl, getAuthUser } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/siteUrl";
import { X, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className="shrink-0">
      <path
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"
        fill="#4285F4"
      />
      <path
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z"
        fill="#34A853"
      />
      <path
        d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"
        fill="#FBBC05"
      />
      <path
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58z"
        fill="#EA4335"
      />
    </svg>
  );
}

export default function LoginPage() {
  const router = useRouter();

  const [next, setNext] = useState("/dashboard");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState("");
  const [emailSent, setEmailSent] = useState(false);
  const [resendTimer, setResendTimer] = useState(0);

  // Read search params via window.location (safe for static export)
  useEffect(() => {
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const rawNext = params.get("next");
      setNext(getValidReturnUrl(rawNext, "/dashboard"));
      const queryError = params.get("error");
      if (queryError) {
        setError(queryError);
      }
    }
  }, []);

  // Keyboard Escape navigation back to home
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        router.push("/");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [router]);

  // Auto-redirect if already logged in
  useEffect(() => {
    getAuthUser().then((user) => {
      if (user) {
        router.replace(next);
      }
    });
  }, [next, router]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendTimer > 0) {
      const interval = setInterval(() => setResendTimer((t) => t - 1), 1000);
      return () => clearInterval(interval);
    }
  }, [resendTimer]);

  // Real Supabase Email Login (Magic Link / OTP)
  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanEmail = email.trim();
    if (!cleanEmail || !cleanEmail.includes("@")) {
      setError("Please enter a valid email address.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const supabase = createClient();
      const origin = typeof window !== "undefined" && window.location.origin ? window.location.origin : getSiteUrl();
      const redirectUrl = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: signInError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: {
          emailRedirectTo: redirectUrl,
        },
      });

      if (signInError) {
        setError(signInError.message || "Failed to send magic link. Please try again.");
        setLoading(false);
        return;
      }

      setEmailSent(true);
      setResendTimer(30);
    } catch (err: any) {
      setError(err?.message || "Failed to send magic link. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  // Real Supabase Google OAuth
  const handleGoogle = async () => {
    setGoogleLoading(true);
    setError("");

    try {
      const supabase = createClient();
      const origin = typeof window !== "undefined" && window.location.origin ? window.location.origin : getSiteUrl();
      const redirectUrl = `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectUrl,
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setGoogleLoading(false);
      }
    } catch (err: any) {
      setError(err?.message || "Could not initialize Google Sign In.");
      setGoogleLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#F8FAFC] flex flex-col justify-between relative overflow-x-hidden">
      <GuideHeader />
      <main
        id="main-content"
        className="flex-1 flex items-end sm:items-center justify-center p-0 sm:p-4 text-[#0F172A] font-sans relative"
      >
        {/* Dimmed backdrop over existing auth-route page */}
        <div
          data-testid="auth-backdrop"
          aria-hidden="true"
          onClick={() => router.push("/")}
          className="fixed inset-0 bg-black/40 z-40 animate-auth-backdrop cursor-pointer"
        />

        {/* Modal-style white surface:
            - Mobile: bottom-anchored drawer, full viewport width (no side margins), 20px top corners, 0px bottom corners, respect safe area, vertical scroll on short screens
            - Desktop: centred 488px max-width card, 24px radius, 48px top / 32px sides / 32px bottom, 424px content width
        */}
        <div
          data-testid="login-auth-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="auth-title"
          className="fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto sm:left-auto sm:right-auto z-50 w-full max-w-full sm:max-w-[488px] m-0 sm:mx-auto bg-white rounded-t-[20px] rounded-b-none sm:rounded-[24px] border border-[#E5E7EB] border-b-0 sm:border-b pt-8 px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:pt-[48px] sm:px-[32px] sm:pb-[32px] my-0 sm:my-4 max-h-[92vh] sm:max-h-[calc(100vh-32px)] overflow-y-auto space-y-5 animate-auth-modal"
        >
          {/* Top-right dark circular close control */}
          <Link
            href="/"
            aria-label="Close and return to home"
            className="absolute top-3 right-3 sm:top-5 sm:right-5 w-8 h-8 rounded-full bg-[#1E293B] hover:bg-[#0F172A] text-white flex items-center justify-center transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-2 z-10"
          >
            <X className="w-4 h-4 text-white" aria-hidden="true" />
          </Link>

          {/* Heading: centred 24px light text, brand bold inline */}
          <div className="text-center pt-2 sm:pt-0">
            <h1 id="auth-title" className="text-[24px] leading-tight text-[#0F172A] font-light tracking-tight">
              Welcome back to <span className="font-bold">CareerMonke</span>
            </h1>
          </div>

          {/* Readable red-tinted error notification banner */}
          {error && (
            <div
              data-testid="auth-error-banner"
              role="alert"
              className="bg-[#FEF2F2] border border-[#FECACA] rounded-[8px] p-3 flex items-start gap-2.5 text-[14px] text-[#B91C1C]"
            >
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-[#DC2626]" />
              <span className="leading-snug">{error}</span>
            </div>
          )}

          {emailSent ? (
            <div
              data-testid="auth-email-sent"
              className="bg-[#F0FDF4] border border-[#BBF7D0] rounded-[16px] p-6 text-center space-y-4"
            >
              <div className="w-12 h-12 rounded-full bg-[#DCFCE7] text-[#16A34A] flex items-center justify-center mx-auto">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h3 className="font-bold text-[16px] text-[#166534]">Check your inbox</h3>
                <p className="text-[13px] text-[#15803D] max-w-sm mx-auto">
                  We sent a verified magic sign-in link to <strong className="text-[#166534]">{email}</strong>. Click the link to complete sign in.
                </p>
              </div>

              <div className="pt-2 flex flex-col items-center gap-2">
                <button
                  type="button"
                  disabled={resendTimer > 0 || loading}
                  onClick={handleEmailSubmit}
                  className="min-h-[44px] inline-flex items-center gap-1.5 text-xs font-semibold text-[#166534] hover:text-[#14532D] disabled:opacity-50 cursor-pointer rounded-lg px-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22C55E]"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
                  <span>
                    {resendTimer > 0 ? `Resend link in ${resendTimer}s` : "Resend magic link"}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEmailSent(false);
                    setError("");
                  }}
                  className="min-h-[44px] text-xs text-[#15803D] hover:underline px-3 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#22C55E] cursor-pointer"
                >
                  Use a different email
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Google button: full width, 48px high, white, 1px #E5E7EB border, 8px radius */}
              <button
                type="button"
                onClick={handleGoogle}
                disabled={googleLoading || loading}
                className="w-full h-[48px] min-h-[48px] rounded-[8px] border border-[#E5E7EB] bg-white hover:bg-[#F9FAFB] active:bg-[#F3F4F6] text-[#1F2937] text-[14px] font-medium transition-colors flex items-center justify-center gap-3 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2563EB] focus-visible:ring-offset-1 disabled:opacity-60"
              >
                {googleLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin text-[#64748B]" />
                    <span>Connecting to Google…</span>
                  </>
                ) : (
                  <>
                    <GoogleIcon />
                    <span>Continue with Google</span>
                  </>
                )}
              </button>

              {/* Plain small grey "OR", no horizontal divider lines */}
              <div className="text-center py-0.5">
                <span className="text-[12px] font-normal text-[#9CA3AF] tracking-wide">
                  OR
                </span>
              </div>

              {/* Email input: 48px high, #F7F8F9 fill, 8px radius, 14px text, placeholder "Email", accessible sr-only label */}
              <form onSubmit={handleEmailSubmit} className="space-y-4">
                <div className="space-y-1">
                  <label htmlFor="login-email" className="sr-only">
                    Email
                  </label>
                  <input
                    id="login-email"
                    type="email"
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value);
                      if (error) setError("");
                    }}
                    placeholder="Email"
                    autoComplete="email"
                    required
                    className="w-full h-[48px] min-h-[48px] rounded-[8px] border border-[#E5E7EB] bg-[#F7F8F9] px-4 text-[14px] text-[#0F172A] placeholder-[#9CA3AF] transition-all focus:border-[#2563EB] focus:ring-2 focus:ring-[#93C5FD] focus:bg-white focus:outline-none"
                  />
                </div>

                {/* Primary button: 48px high, 8px radius, our blue #2563EB, white semibold text */}
                <button
                  type="submit"
                  disabled={loading || googleLoading}
                  className="w-full h-[48px] min-h-[48px] rounded-[8px] bg-[#2563EB] hover:bg-[#1D4ED8] active:bg-[#1E40AF] text-white text-[14px] font-semibold transition-colors flex items-center justify-center gap-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] focus-visible:ring-offset-1 disabled:opacity-60"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-white" />
                      <span>Sending link…</span>
                    </>
                  ) : (
                    <span>Email me a sign-in link</span>
                  )}
                </button>
              </form>

              {/* Terms and Privacy Policy below primary action */}
              <p className="text-[12px] text-center text-[#6B7280]">
                By continuing, you agree to our{" "}
                <Link href="/terms-and-conditions" className="underline hover:text-[#374151]">
                  Terms
                </Link>{" "}
                and{" "}
                <Link href="/privacy-policy" className="underline hover:text-[#374151]">
                  Privacy Policy
                </Link>
                .
              </p>
            </div>
          )}

          {/* Account switch:
              - Mobile: white background with 1px #E5E7EB border
              - Desktop: full-width 48px light-grey filled box (#F3F4F5), 8px radius, border-transparent
              - Regular text with bold blue Sign up link
          */}
          <div className="w-full h-[48px] min-h-[48px] rounded-[8px] bg-white border border-[#E5E7EB] sm:bg-[#F3F4F5] sm:border-transparent flex items-center justify-center text-[14px] text-[#4B5563]">
            <span>Don&apos;t have an account? </span>
            <Link
              href={next ? `/signup?next=${encodeURIComponent(next)}` : "/signup"}
              className="ml-1 font-bold text-[#2563EB] hover:text-[#1D4ED8] underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#93C5FD] rounded"
            >
              Sign up
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}
